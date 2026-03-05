// src/routes/trades.js
'use strict';

const { z } = require('zod');

module.exports = async function (app) {

  // ── POST /v1/trades  (需登入) ─────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      market_id: z.string().uuid(),
      direction: z.enum(['yes', 'no']),
      amount:    z.number().int().min(50, '最低押注 50 積分'),
      mode:      z.enum(['buy', 'sell']).optional().default('buy'),
    });

    const body = schema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: body.error.errors[0].message } });
    }

    const userId = req.user.sub;
    const { market_id, direction, amount, mode } = body.data;

    // 使用 DB Transaction 確保原子性
    const result = await app.prisma.$transaction(async (tx) => {
      const [user, market] = await Promise.all([
        tx.user.findUnique({ where: { id: userId } }),
        tx.market.findUnique({ where: { id: market_id } }),
      ]);

      if (!market) throw appError('MARKET_NOT_FOUND', '找不到該預測市場', 404);
      if (market.resolution !== null) throw appError('MARKET_CLOSED', '市場已截止，無法下注', 400);
      if (new Date() > market.endsAt) throw appError('MARKET_CLOSED', '市場已截止，無法下注', 400);
      if (!user) throw appError('UNAUTHORIZED', '用戶不存在', 401);
      if (Number(user.score) < amount) throw appError('INSUFFICIENT_BALANCE', '積分不足', 400);

      // 扣除積分
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data:  { score: { decrement: BigInt(amount) } },
      });

      // 建立押注記錄
      const trade = await tx.trade.create({
        data: {
          userId,
          marketId: market_id,
          direction,
          amount:   BigInt(amount),
          entryPct: market.yesPct,
        },
      });

      // 更新市場統計
      await tx.market.update({
        where: { id: market_id },
        data: {
          volumeScore:      { increment: BigInt(amount) },
          participantCount: { increment: 1 },
          // 動態調整機率（簡易版：依投票比例）
          yesPct: await calcNewYesPct(tx, market_id, direction),
        },
      });

      return { trade, user: updatedUser };
    });

    // 建立通知
    await app.prisma.notification.create({
      data: {
        userId,
        type:  'reward',
        icon:  direction === 'yes' ? '📈' : '📉',
        title: `下注成功：${direction === 'yes' ? '買多「是」' : '買空「否」'}`,
        body:  `已押注 ${amount.toLocaleString()} 🪙 積分`,
      },
    });

    reply.code(201).send({
      ok: true,
      data: {
        trade: {
          id:        result.trade.id,
          direction: result.trade.direction,
          amount:    Number(result.trade.amount),
          entry_pct: Number(result.trade.entryPct),
        },
        user: {
          score: Number(result.user.score),
          gem:   result.user.gem,
        },
      },
    });
  });

  // ── GET /v1/trades/me ──────────────────────────────
  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      status: z.enum(['open', 'won', 'lost', 'all']).optional().default('all'),
      page:   z.coerce.number().int().positive().optional().default(1),
      limit:  z.coerce.number().int().min(1).max(50).optional().default(20),
    });

    const query = schema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '查詢參數錯誤' } });
    }

    const { status, page, limit } = query.data;
    const userId = req.user.sub;

    const where = { userId };
    if (status !== 'all') where.status = status;

    const [trades, total] = await Promise.all([
      app.prisma.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * limit,
        take:    limit,
        include: {
          market: { select: { question: true, icon: true, yesPct: true, resolution: true } },
        },
      }),
      app.prisma.trade.count({ where }),
    ]);

    reply.send({
      ok: true,
      data: trades.map(t => ({
        id:        t.id,
        direction: t.direction,
        amount:    Number(t.amount),
        entry_pct: Number(t.entryPct),
        status:    t.status,
        pnl:       t.pnl !== null ? Number(t.pnl) : null,
        createdAt: t.createdAt,
        market: {
          question:   t.market.question,
          icon:       t.market.icon,
          current_pct: Number(t.market.yesPct),
          resolution:  t.market.resolution,
        },
      })),
      meta: { total, page, limit, hasMore: page * limit < total },
    });
  });

  // ── GET /v1/trades/me/summary ──────────────────────
  app.get('/me/summary', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const [allTrades, openTrades, wonTrades] = await Promise.all([
      app.prisma.trade.findMany({ where: { userId }, select: { pnl: true, status: true, createdAt: true } }),
      app.prisma.trade.count({ where: { userId, status: 'open' } }),
      app.prisma.trade.count({ where: { userId, status: 'won' } }),
    ]);

    const settled = allTrades.filter(t => t.status !== 'open');
    const winRate = settled.length ? Math.round((wonTrades / settled.length) * 1000) / 10 : 0;
    const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl ? Number(t.pnl) : 0), 0);
    const bestTrade = Math.max(0, ...allTrades.filter(t => t.pnl).map(t => Number(t.pnl)));

    reply.send({
      ok: true,
      data: {
        total_trades:  allTrades.length,
        open_trades:   openTrades,
        win_rate:      winRate,
        total_pnl:     totalPnl,
        best_trade:    bestTrade,
        pnl_history:   buildPnlHistory(allTrades),
      },
    });
  });
};

// ── Helpers ───────────────────────────────────────────
function appError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.errCode = code;
  return err;
}

async function calcNewYesPct(tx, marketId, direction) {
  const counts = await tx.trade.groupBy({
    by:    ['direction'],
    where: { marketId, status: 'open' },
    _sum:  { amount: true },
  });

  let yesVol = 0, noVol = 0;
  counts.forEach(c => {
    if (c.direction === 'yes') yesVol = Number(c._sum.amount || 0);
    if (c.direction === 'no')  noVol  = Number(c._sum.amount || 0);
  });

  const total = yesVol + noVol;
  if (total === 0) return 50;
  return Math.round((yesVol / total) * 100 * 100) / 100;
}

function buildPnlHistory(trades) {
  // Group by day, return last 30 days of cumulative pnl
  const daily = {};
  trades.filter(t => t.pnl).forEach(t => {
    const day = t.createdAt.toISOString().split('T')[0];
    daily[day] = (daily[day] || 0) + Number(t.pnl);
  });

  return Object.entries(daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, pnl]) => ({ date, pnl }));
}
