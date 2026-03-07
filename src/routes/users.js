'use strict';

const { z } = require('zod');

const PROFILE_PATCH_SCHEMA = z.object({
  username: z.string().trim().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/, 'username format invalid').optional(),
  bio: z.string().max(200).optional(),
  avatar_url: z.string().url().max(500).optional(),
  pro_notif_enabled: z.boolean().optional(),
});

const LEADERBOARD_QUERY_SCHEMA = z.object({
  type: z.enum(['score', 'gem', 'win_rate']).default('score'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

const INVENTORY_QUERY_SCHEMA = z.object({
  with_zero: z.coerce.boolean().optional().default(false),
});

function sendSuccess(reply, data = null, meta = {}, statusCode = 200) {
  return reply.code(statusCode).send({
    data,
    error: null,
    meta,
  });
}

function sendError(reply, statusCode, code, message, details = null) {
  return reply.code(statusCode).send({
    data: null,
    error: { code, message, details },
    meta: {},
  });
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  return Number(value);
}

function safeDateISO(value) {
  return value ? new Date(value).toISOString() : null;
}

function formatTaipeiDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function taipeiDateObject(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function getTaipeiTodayKey(now = new Date()) {
  return formatTaipeiDate(now);
}

function getTaipeiYesterdayKey(now = new Date()) {
  const todayKey = getTaipeiTodayKey(now);
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  const yesterday = new Date(todayDate.getTime() - 86400000);
  return formatTaipeiDate(yesterday);
}

function summarizeInventory(inventoryRows) {
  const map = new Map();
  for (const row of inventoryRows || []) {
    map.set(row.itemKey, {
      item_key: row.itemKey,
      quantity: row.quantity,
      updated_at: safeDateISO(row.updatedAt || row.acquiredAt),
    });
  }

  const lotteryTickets = map.get('lottery_ticket')?.quantity || 0;

  return {
    items: Array.from(map.values()).sort((a, b) => a.item_key.localeCompare(b.item_key)),
    summary: {
      lottery_tickets: lotteryTickets,
      total_item_types: map.size,
      total_item_quantity: Array.from(map.values()).reduce((sum, item) => sum + item.quantity, 0),
    },
  };
}

function buildMilestoneReward(streak) {
  const rewards = { 7: 5, 14: 10, 21: 15, 30: 30 };
  return rewards[streak] || 0;
}

async function getUserStats(app, userId, userScore) {
  const [rankHigherCount, wonCount, settledCount, openPositionsCount] = await Promise.all([
    app.prisma.user.count({ where: { score: { gt: userScore } } }),
    app.prisma.trade.count({ where: { userId, status: 'won' } }),
    app.prisma.trade.count({ where: { userId, status: { in: ['won', 'lost'] } } }),
    app.prisma.trade.count({
      where: {
        userId,
        status: 'open',
        ...(app.prisma.trade.fields?.remainingAmount ? { remainingAmount: { gt: 0 } } : {}),
      },
    }).catch(() =>
      app.prisma.trade.count({
        where: { userId, status: 'open' },
      })
    ),
  ]);

  return {
    rank: rankHigherCount + 1,
    win_rate: settledCount > 0 ? Math.round((wonCount / settledCount) * 1000) / 10 : 0,
    total_trades: wonCount + (settledCount - wonCount) + openPositionsCount,
    settled_trades: settledCount,
    won_trades: wonCount,
    open_positions: openPositionsCount,
  };
}

module.exports = async function usersRoutes(app) {
  // GET /v1/users/me
  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      include: {
        inventory: {
          orderBy: { itemKey: 'asc' },
          select: {
            itemKey: true,
            quantity: true,
            acquiredAt: true,
            ...(app.prisma.userInventory.fields?.updatedAt ? { updatedAt: true } : {}),
          },
        },
        checkins: {
          orderBy: { date: 'desc' },
          take: 30,
          select: {
            date: true,
            streak: true,
            rewardScore: true,
            rewardGem: true,
            createdAt: true,
          },
        },
        dailyTasks: {
          where: { date: taipeiDateObject(getTaipeiTodayKey()) },
          orderBy: { taskKey: 'asc' },
          select: {
            taskKey: true,
            progress: true,
            target: true,
            completedAt: true,
            rewardClaimed: true,
            createdAt: true,
            ...(app.prisma.dailyTask.fields?.updatedAt ? { updatedAt: true } : {}),
          },
        },
      },
    });

    if (!user) {
      return sendError(reply, 404, 'USER_NOT_FOUND', '找不到用戶。');
    }

    const todayKey = getTaipeiTodayKey();
    const yesterdayKey = getTaipeiYesterdayKey();
    const latestCheckin = user.checkins[0] || null;
    const latestCheckinKey = latestCheckin?.date ? formatTaipeiDate(latestCheckin.date) : null;

    const inventoryPayload = summarizeInventory(user.inventory);
    const stats = await getUserStats(app, userId, user.score);

    const currentStreak = latestCheckinKey === todayKey || latestCheckinKey === yesterdayKey
      ? latestCheckin?.streak || 0
      : 0;

    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      avatar_url: user.avatarUrl,
      bio: user.bio,
      status: user.status,
      email_verified: user.emailVerified,
      phone_verified: user.phoneVerified,
      created_at: safeDateISO(user.createdAt),
      updated_at: safeDateISO(user.updatedAt),
      last_login_at: safeDateISO(user.lastLoginAt),
      assets: {
        score: toNumber(user.score),
        gem: user.gem,
        ntd_balance: toNumber(user.ntdBalance),
        lottery_tickets: inventoryPayload.summary.lottery_tickets,
      },
      pro: {
        is_pro: user.isPro,
        expires_at: safeDateISO(user.proExpiresAt),
        notif_enabled: user.proNotifEnabled,
      },
      stats,
      inventory: inventoryPayload.items,
      inventory_summary: inventoryPayload.summary,
      checkin: {
        streak: currentStreak,
        checked_today: latestCheckinKey === todayKey,
        last_date: latestCheckinKey,
        next_milestone_day: [7, 14, 21, 30].find((d) => d > currentStreak) || null,
        recent_records: user.checkins.slice(0, 14).map((row) => ({
          date: formatTaipeiDate(row.date),
          streak: row.streak,
          reward_score: row.rewardScore,
          reward_gem: row.rewardGem,
          created_at: safeDateISO(row.createdAt),
        })),
      },
      tasks: {
        date: todayKey,
        items: user.dailyTasks.map((task) => ({
          task_key: task.taskKey,
          progress: task.progress,
          target: task.target,
          completed: Boolean(task.completedAt),
          completed_at: safeDateISO(task.completedAt),
          reward_claimed: task.rewardClaimed,
          created_at: safeDateISO(task.createdAt),
          updated_at: safeDateISO(task.updatedAt),
        })),
      },
    };

    return sendSuccess(reply, payload, {});
  });

  // PATCH /v1/users/me
  app.patch('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = PROFILE_PATCH_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤。', parsed.error.flatten());
    }

    const userId = req.user.sub;
    const body = parsed.data;
    const data = {};

    if (typeof body.username === 'string') data.username = body.username;
    if (body.bio !== undefined) data.bio = body.bio;
    if (typeof body.avatar_url === 'string') data.avatarUrl = body.avatar_url;
    if (typeof body.pro_notif_enabled === 'boolean') data.proNotifEnabled = body.pro_notif_enabled;

    if (Object.keys(data).length === 0) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '沒有可更新的資料。');
    }

    try {
      const updated = await app.prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          username: true,
          bio: true,
          avatarUrl: true,
          proNotifEnabled: true,
          updatedAt: true,
        },
      });

      return sendSuccess(reply, {
        updated: true,
        user: {
          id: updated.id,
          username: updated.username,
          bio: updated.bio,
          avatar_url: updated.avatarUrl,
          pro_notif_enabled: updated.proNotifEnabled,
          updated_at: safeDateISO(updated.updatedAt),
        },
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        return sendError(reply, 409, 'USERNAME_TAKEN', '此用戶名稱已被使用。');
      }
      throw error;
    }
  });

  // GET /v1/users/me/inventory
  app.get('/me/inventory', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = INVENTORY_QUERY_SCHEMA.safeParse(req.query || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數格式錯誤。', parsed.error.flatten());
    }

    const userId = req.user.sub;
    const rows = await app.prisma.userInventory.findMany({
      where: {
        userId,
        ...(parsed.data.with_zero ? {} : { quantity: { gt: 0 } }),
      },
      orderBy: { itemKey: 'asc' },
    });

    const payload = summarizeInventory(rows);
    return sendSuccess(reply, payload.items, payload.summary);
  });

  // POST /v1/users/me/checkin
  app.post('/me/checkin', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const todayKey = getTaipeiTodayKey();
    const today = taipeiDateObject(todayKey);

    const existing = await app.prisma.userCheckin.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    if (existing) {
      return sendError(reply, 409, 'ALREADY_CHECKED_IN', '今日已簽到。');
    }

    const yesterdayKey = getTaipeiYesterdayKey();
    const yesterday = taipeiDateObject(yesterdayKey);

    const lastCheckin = await app.prisma.userCheckin.findUnique({
      where: { userId_date: { userId, date: yesterday } },
      select: { streak: true },
    });

    const streak = lastCheckin ? lastCheckin.streak + 1 : 1;
    const rewardScore = 10 + Math.min(streak * 2, 50);
    const rewardGem = buildMilestoneReward(streak);

    await app.prisma.$transaction(async (tx) => {
      await tx.userCheckin.create({
        data: { userId, date: today, streak, rewardScore, rewardGem },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          score: { increment: BigInt(rewardScore) },
          gem: { increment: rewardGem },
        },
      });

      await tx.notification.create({
        data: {
          userId,
          type: 'reward',
          icon: rewardGem > 0 ? '🎉' : '✅',
          title: `第 ${streak} 天簽到成功`,
          body: `獲得 +${rewardScore} 積分${rewardGem > 0 ? `、+${rewardGem} 鑽石` : ''}`,
          link: '/dashboard?tab=checkin',
        },
      });
    });

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { score: true, gem: true },
    });

    return sendSuccess(reply, {
      streak,
      reward_score: rewardScore,
      reward_gem: rewardGem,
      milestone: rewardGem > 0 ? { day: streak, gem: rewardGem } : null,
      new_score: toNumber(user.score),
      new_gem: user.gem,
      checked_date: todayKey,
      next_milestone_day: [7, 14, 21, 30].find((d) => d > streak) || null,
    });
  });

  // GET /v1/users/leaderboard
  app.get('/leaderboard', async (req, reply) => {
    const parsed = LEADERBOARD_QUERY_SCHEMA.safeParse(req.query || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數格式錯誤。', parsed.error.flatten());
    }

    const { type, limit, page } = parsed.data;
    const skip = (page - 1) * limit;
    const cacheKey = `leaderboard:${type}:${page}:${limit}`;

    if (app.redis) {
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        return reply.send(JSON.parse(cached));
      }
    }

    let items = [];
    let total = 0;

    if (type === 'win_rate') {
      const users = await app.prisma.user.findMany({
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          score: true,
          gem: true,
          isPro: true,
          trades: {
            where: { status: { in: ['won', 'lost'] } },
            select: { status: true },
          },
        },
      });

      const ranked = users
        .map((user) => {
          const settled = user.trades.length;
          const won = user.trades.filter((t) => t.status === 'won').length;
          const winRate = settled > 0 ? Math.round((won / settled) * 1000) / 10 : 0;
          return {
            id: user.id,
            username: user.username,
            avatar_url: user.avatarUrl,
            score: toNumber(user.score),
            gem: user.gem,
            is_pro: user.isPro,
            value: winRate,
            settled_trades: settled,
          };
        })
        .sort((a, b) => {
          if (b.value !== a.value) return b.value - a.value;
          return b.score - a.score;
        });

      total = ranked.length;
      items = ranked.slice(skip, skip + limit).map((user, index) => ({
        rank: skip + index + 1,
        ...user,
      }));
    } else {
      const orderBy = type === 'gem' ? { gem: 'desc' } : { score: 'desc' };

      const [users, count] = await Promise.all([
        app.prisma.user.findMany({
          orderBy,
          skip,
          take: limit,
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            score: true,
            gem: true,
            isPro: true,
          },
        }),
        app.prisma.user.count(),
      ]);

      total = count;
      items = users.map((user, index) => ({
        rank: skip + index + 1,
        id: user.id,
        username: user.username,
        avatar_url: user.avatarUrl,
        score: toNumber(user.score),
        gem: user.gem,
        is_pro: user.isPro,
        value: type === 'gem' ? user.gem : toNumber(user.score),
      }));
    }

    const response = {
      data: items,
      error: null,
      meta: {
        type,
        page,
        limit,
        total,
        has_next_page: skip + limit < total,
      },
    };

    if (app.redis) {
      await app.redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
    }

    return reply.send(response);
  });
};
