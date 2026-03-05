// src/routes/users.js
'use strict';

const { z } = require('zod');

module.exports = async function (app) {

  // ── GET /v1/users/me ───────────────────────────────
  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      include: {
        inventory: { select: { itemKey: true, quantity: true } },
        checkins:  { orderBy: { date: 'desc' }, take: 1, select: { streak: true, date: true } },
        _count:    { select: { trades: true } },
      },
    });

    if (!user) {
      return reply.code(404).send({ ok: false, error: { code: 'USER_NOT_FOUND', message: '找不到用戶' } });
    }

    // Rank (position by score)
    const rank = await app.prisma.user.count({
      where: { score: { gt: user.score } },
    });

    // Win rate
    const [wonCount, settledCount] = await Promise.all([
      app.prisma.trade.count({ where: { userId, status: 'won' } }),
      app.prisma.trade.count({ where: { userId, status: { in: ['won', 'lost'] } } }),
    ]);

    const checkinInfo = user.checkins[0];
    const today       = new Date().toISOString().split('T')[0];
    const lastDate    = checkinInfo?.date?.toISOString().split('T')[0];

    reply.send({
      ok: true,
      data: {
        id:          user.id,
        username:    user.username,
        email:       user.email,
        avatarUrl:   user.avatarUrl,
        bio:         user.bio,
        score:       Number(user.score),
        gem:         user.gem,
        ntdBalance:  Number(user.ntdBalance),
        isPro:       user.isPro,
        proExpiresAt: user.proExpiresAt,
        proNotifEnabled: user.proNotifEnabled,
        status:      user.status,
        createdAt:   user.createdAt,
        stats: {
          rank:         rank + 1,
          win_rate:     settledCount ? Math.round((wonCount / settledCount) * 1000) / 10 : 0,
          total_trades: user._count.trades,
        },
        inventory: user.inventory,
        checkin: {
          streak:        checkinInfo?.streak || 0,
          last_date:     lastDate || null,
          checked_today: lastDate === today,
        },
      },
    });
  });

  // ── PATCH /v1/users/me ─────────────────────────────
  app.patch('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      username:          z.string().min(3).max(20).optional(),
      bio:               z.string().max(200).optional(),
      avatar_url:        z.string().url().optional(),
      pro_notif_enabled: z.boolean().optional(),
    });

    const body = schema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '請求參數格式錯誤' } });
    }

    const userId = req.user.sub;
    const data   = {};

    if (body.data.username)           data.username         = body.data.username;
    if (body.data.bio !== undefined)  data.bio              = body.data.bio;
    if (body.data.avatar_url)         data.avatarUrl        = body.data.avatar_url;
    if (body.data.pro_notif_enabled !== undefined) data.proNotifEnabled = body.data.pro_notif_enabled;

    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '沒有要更新的資料' } });
    }

    try {
      const updated = await app.prisma.user.update({ where: { id: userId }, data });
      reply.send({ ok: true, data: { updated: true, username: updated.username } });
    } catch (err) {
      if (err.code === 'P2002') {
        return reply.code(409).send({ ok: false, error: { code: 'USERNAME_TAKEN', message: '此用戶名稱已被使用' } });
      }
      throw err;
    }
  });

  // ── POST /v1/users/me/checkin ──────────────────────
  app.post('/me/checkin', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const today  = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await app.prisma.userCheckin.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    if (existing) {
      return reply.code(409).send({ ok: false, error: { code: 'ALREADY_CHECKED_IN', message: '今日已簽到' } });
    }

    // Calculate streak
    const yesterday = new Date(today.getTime() - 86400000);
    const lastCheckin = await app.prisma.userCheckin.findUnique({
      where: { userId_date: { userId, date: yesterday } },
    });

    const streak = lastCheckin ? lastCheckin.streak + 1 : 1;

    // Milestone rewards (7, 14, 21, 30 day streaks)
    const MILESTONES = { 7: 5, 14: 10, 21: 15, 30: 30 };
    const rewardScore = 10 + Math.min(streak * 2, 50); // 最多60分
    const rewardGem   = MILESTONES[streak] || 0;

    await app.prisma.$transaction([
      app.prisma.userCheckin.create({
        data: { userId, date: today, streak, rewardScore, rewardGem },
      }),
      app.prisma.user.update({
        where: { id: userId },
        data:  {
          score: { increment: BigInt(rewardScore) },
          gem:   { increment: rewardGem },
        },
      }),
    ]);

    // 通知
    await app.prisma.notification.create({
      data: {
        userId,
        type:  'reward',
        icon:  streak >= 7 ? '🎉' : '✅',
        title: `第 ${streak} 天簽到成功`,
        body:  `獲得 +${rewardScore} 🪙${rewardGem ? ` +${rewardGem} 💎` : ''}`,
      },
    });

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { score: true, gem: true },
    });

    reply.send({
      ok: true,
      data: {
        streak,
        reward_score: rewardScore,
        reward_gem:   rewardGem,
        milestone:    rewardGem ? { day: streak, gem: rewardGem } : null,
        new_score:    Number(user.score),
      },
    });
  });

  // ── GET /v1/users/leaderboard ──────────────────────
  app.get('/leaderboard', async (req, reply) => {
    const type  = req.query.type  || 'score';
    const limit = Math.min(parseInt(req.query.limit || '50'), 100);

    const cacheKey = `leaderboard:${type}:${limit}`;
    if (app.redis) {
      const cached = await app.redis.get(cacheKey);
      if (cached) return reply.send(JSON.parse(cached));
    }

    const users = await app.prisma.user.findMany({
      orderBy: type === 'score' ? { score: 'desc' } : { score: 'desc' },
      take:    limit,
      select:  { id: true, username: true, avatarUrl: true, score: true, gem: true, isPro: true },
    });

    const response = {
      ok: true,
      data: users.map((u, i) => ({
        rank:      i + 1,
        id:        u.id,
        username:  u.username,
        avatarUrl: u.avatarUrl,
        score:     Number(u.score),
        gem:       u.gem,
        isPro:     u.isPro,
      })),
    };

    if (app.redis) await app.redis.setex(cacheKey, 300, JSON.stringify(response));
    reply.send(response);
  });
};
