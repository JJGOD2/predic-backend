'use strict';

const { z } = require('zod');

const MIN_TRADE_AMOUNT = 50;

module.exports = async function tradesRoutes(app) {
  // POST /v1/trades
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = tradeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.errors[0]?.message || '請求資料格式錯誤');
    }

    const userId = req.user.sub;
    const { market_id: marketId, direction, amount, mode } = parsed.data;

    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const [user, market] = await Promise.all([
          tx.user.findUnique({ where: { id: userId } }),
          tx.market.findUnique({ where: { id: marketId } }),
        ]);

        assertUser(user);
        assertMarketIsTradable(market);

        if (mode === 'buy') {
          return handleBuy({ tx, user, market, userId, marketId, direction, amount });
        }

        return handleSell({ tx, user, market, userId, marketId, direction, amount });
      });

      return reply.code(201).send(success({
        trade: result.trade,
        user: result.user,
        market: result.market,
        position: result.position || null,
      }));
    } catch (error) {
      app.log.error(error);
      return sendAppError(reply, error);
    }
  });

  // GET /v1/trades/me
  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = tradeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendValidationError(reply, '查詢參數錯誤');
    }

    const userId = req.user.sub;
    const { status, page, limit } = parsed.data;
    const skip = (page - 1) * limit;

    try {
      let rows = [];
      let total = 0;

      if (status === 'open') {
        const raw = await app.prisma.trade.findMany({
          where: {
            userId,
            mode: 'buy',
            status: 'open',
            remainingAmount: { gt: 0 },
          },
          include: {
            market: {
              select: {
                id: true,
                slug: true,
                question: true,
                icon: true,
                yesPct: true,
                resolution: true,
                status: true,
                endsAt: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        const grouped = aggregateOpenPositions(raw);
        total = grouped.length;
        rows = grouped.slice(skip, skip + limit).map(formatOpenPosition);
      } else {
        const where = {
          userId,
          ...(status === 'all'
            ? {}
            : status === 'closed'
              ? { NOT: { status: 'open' } }
              : { status }),
        };

        const [trades, count] = await Promise.all([
          app.prisma.trade.findMany({
            where,
            include: {
              market: {
                select: {
                  id: true,
                  slug: true,
                  question: true,
                  icon: true,
                  yesPct: true,
                  resolution: true,
                  status: true,
                  endsAt: true,
                },
              },
            },
            orderBy: [{ closedAt: 'desc' }, { settledAt: 'desc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
          }),
          app.prisma.trade.count({ where }),
        ]);

        total = count;
        rows = trades.map(formatTradeRow);
      }

      return reply.send(success(rows, {
        total,
        page,
        limit,
        hasMore: page * limit < total,
      }));
    } catch (error) {
      app.log.error(error);
      return sendAppError(reply, error);
    }
  });

  // GET /v1/trades/me/summary
  app.get('/me/summary', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    try {
      const [allTrades, openBuyTrades, user] = await Promise.all([
        app.prisma.trade.findMany({
          where: { userId },
          include: {
            market: { select: { yesPct: true } },
          },
          orderBy: { createdAt: 'asc' },
        }),
        app.prisma.trade.findMany({
          where: {
            userId,
            mode: 'buy',
            status: 'open',
            remainingAmount: { gt: 0 },
          },
          include: {
            market: { select: { yesPct: true } },
          },
        }),
        app.prisma.user.findUnique({
          where: { id: userId },
          select: { score: true, gem: true, ntdBalance: true },
        }),
      ]);

      const realizedTrades = allTrades.filter((t) => t.status !== 'open' && t.pnl !== null);
      const winningTrades = realizedTrades.filter((t) => Number(t.pnl) > 0);
      const totalRealizedPnl = realizedTrades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
      const bestTrade = realizedTrades.reduce((max, t) => Math.max(max, Number(t.pnl || 0)), 0);
      const openExposure = openBuyTrades.reduce((sum, t) => sum + Number(t.remainingAmount || 0), 0);
      const unrealizedPnl = openBuyTrades.reduce((sum, t) => {
        const currentPct = getCurrentPctForDirection(decimalToNumber(t.market.yesPct), t.direction);
        return sum + estimatePnl(Number(t.remainingAmount || 0), decimalToNumber(t.entryPct), currentPct);
      }, 0);

      return reply.send(success({
        total_trades: allTrades.length,
        open_positions: countUniqueOpenPositions(openBuyTrades),
        open_exposure: openExposure,
        win_rate: realizedTrades.length ? round1((winningTrades.length / realizedTrades.length) * 100) : 0,
        total_pnl: totalRealizedPnl,
        unrealized_pnl: roundInt(unrealizedPnl),
        best_trade: bestTrade,
        score: Number(user?.score || 0n),
        gem: Number(user?.gem || 0),
        ntd_balance: decimalToNumber(user?.ntdBalance || 0),
        pnl_history: buildPnlHistory(realizedTrades),
      }));
    } catch (error) {
      app.log.error(error);
      return sendAppError(reply, error);
    }
  });
};

const tradeBodySchema = z.object({
  market_id: z.string().uuid('market_id 格式錯誤'),
  direction: z.enum(['yes', 'no']),
  amount: z.coerce.number().int().min(MIN_TRADE_AMOUNT, `最低交易額為 ${MIN_TRADE_AMOUNT} 積分`),
  mode: z.enum(['buy', 'sell']).optional().default('buy'),
});

const tradeQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'won', 'lost', 'voided', 'all']).optional().default('all'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

async function handleBuy({ tx, user, market, userId, marketId, direction, amount }) {
  if (Number(user.score) < amount) {
    throw appError('INSUFFICIENT_BALANCE', '積分不足', 400);
  }

  const currentYesPct = decimalToNumber(market.yesPct);
  const entryPct = getCurrentPctForDirection(currentYesPct, direction);

  const alreadyParticipated = await tx.trade.findFirst({
    where: { userId, marketId },
    select: { id: true },
  });

  const updatedUser = await tx.user.update({
    where: { id: userId },
    data: { score: { decrement: BigInt(amount) } },
    select: { score: true, gem: true },
  });

  const trade = await tx.trade.create({
    data: {
      userId,
      marketId,
      direction,
      mode: 'buy',
      amount: BigInt(amount),
      remainingAmount: BigInt(amount),
      entryPct: decimal(entryPct),
      status: 'open',
    },
  });

  const marketStats = await recalculateMarketStats(tx, marketId, !alreadyParticipated);
  await createTradeNotification(tx, {
    userId,
    type: 'trade',
    icon: direction === 'yes' ? '📈' : '📉',
    title: `買入成功：${direction === 'yes' ? '是' : '否'}`,
    body: `已買入 ${amount.toLocaleString()} 積分，進場價格 ${entryPct.toFixed(2)}%`,
    link: `/markets/${market.slug}`,
  });

  const position = await buildPositionSnapshot(tx, userId, marketId, direction);

  return {
    trade: formatTradeRow({ ...trade, market: { ...market, yesPct: marketStats.yesPct, slug: market.slug } }),
    user: { score: Number(updatedUser.score), gem: Number(updatedUser.gem || 0) },
    market: marketStats,
    position,
  };
}

async function handleSell({ tx, user, market, userId, marketId, direction, amount }) {
  const openLots = await tx.trade.findMany({
    where: {
      userId,
      marketId,
      direction,
      mode: 'buy',
      status: 'open',
      remainingAmount: { gt: 0 },
    },
    orderBy: { createdAt: 'asc' },
  });

  const totalRemaining = openLots.reduce((sum, lot) => sum + Number(lot.remainingAmount || 0), 0);
  if (totalRemaining < amount) {
    throw appError('INSUFFICIENT_POSITION', '可賣出持倉不足', 400);
  }

  const currentYesPct = decimalToNumber(market.yesPct);
  const exitPct = getCurrentPctForDirection(currentYesPct, direction);

  let remainingToClose = amount;
  let realizedPnl = 0;

  for (const lot of openLots) {
    if (remainingToClose <= 0) break;

    const lotRemaining = Number(lot.remainingAmount || 0);
    const consume = Math.min(lotRemaining, remainingToClose);
    const lotPnl = estimatePnl(consume, decimalToNumber(lot.entryPct), exitPct);
    realizedPnl += lotPnl;

    const newRemaining = lotRemaining - consume;

    await tx.trade.update({
      where: { id: lot.id },
      data: {
        remainingAmount: BigInt(newRemaining),
        status: newRemaining === 0 ? 'closed' : 'open',
        pnl: newRemaining === 0
          ? BigInt(roundInt((Number(lot.pnl || 0)) + lotPnl))
          : lot.pnl,
        closedAt: newRemaining === 0 ? new Date() : lot.closedAt,
      },
    });

    remainingToClose -= consume;
  }

  const realizedPnlInt = roundInt(realizedPnl);
  const refundAmount = Math.max(0, amount + realizedPnlInt);

  const updatedUser = await tx.user.update({
    where: { id: userId },
    data: { score: { increment: BigInt(refundAmount) } },
    select: { score: true, gem: true },
  });

  const sellTrade = await tx.trade.create({
    data: {
      userId,
      marketId,
      direction,
      mode: 'sell',
      amount: BigInt(amount),
      remainingAmount: BigInt(0),
      entryPct: decimal(exitPct),
      status: 'closed',
      pnl: BigInt(realizedPnlInt),
      closedAt: new Date(),
      settledAt: new Date(),
    },
  });

  const marketStats = await recalculateMarketStats(tx, marketId, false);
  await createTradeNotification(tx, {
    userId,
    type: 'trade',
    icon: '💸',
    title: `賣出成功：${direction === 'yes' ? '是' : '否'}`,
    body: `已賣出 ${amount.toLocaleString()} 積分，${realizedPnlInt >= 0 ? '實現獲利' : '實現損失'} ${Math.abs(realizedPnlInt).toLocaleString()} 積分`,
    link: `/markets/${market.slug}`,
  });

  const position = await buildPositionSnapshot(tx, userId, marketId, direction);

  return {
    trade: formatTradeRow({ ...sellTrade, market: { ...market, yesPct: marketStats.yesPct, slug: market.slug } }),
    user: { score: Number(updatedUser.score), gem: Number(updatedUser.gem || 0) },
    market: marketStats,
    position,
  };
}

async function recalculateMarketStats(tx, marketId, incrementParticipantCount) {
  const exposureRows = await tx.trade.groupBy({
    by: ['direction'],
    where: {
      marketId,
      mode: 'buy',
      status: 'open',
      remainingAmount: { gt: 0 },
    },
    _sum: { remainingAmount: true },
  });

  let yesExposure = 0;
  let noExposure = 0;
  for (const row of exposureRows) {
    if (row.direction === 'yes') yesExposure = Number(row._sum.remainingAmount || 0);
    if (row.direction === 'no') noExposure = Number(row._sum.remainingAmount || 0);
  }

  const totalExposure = yesExposure + noExposure;
  const nextYesPct = totalExposure === 0 ? 50 : round2((yesExposure / totalExposure) * 100);

  const marketUpdate = await tx.market.update({
    where: { id: marketId },
    data: {
      yesPct: decimal(nextYesPct),
      volumeScore: BigInt(totalExposure),
      ...(incrementParticipantCount ? { participantCount: { increment: 1 } } : {}),
    },
    select: {
      id: true,
      slug: true,
      yesPct: true,
      participantCount: true,
      volumeScore: true,
      status: true,
      resolution: true,
      endsAt: true,
    },
  });

  await tx.probabilityLog.create({
    data: {
      marketId,
      yesPct: decimal(nextYesPct),
    },
  });

  return {
    id: marketUpdate.id,
    slug: marketUpdate.slug,
    yes_pct: decimalToNumber(marketUpdate.yesPct),
    no_pct: round2(100 - decimalToNumber(marketUpdate.yesPct)),
    participant_count: marketUpdate.participantCount,
    volume_score: Number(marketUpdate.volumeScore || 0),
    status: marketUpdate.status || inferMarketStatus(marketUpdate),
    resolution: marketUpdate.resolution,
    ends_at: marketUpdate.endsAt,
  };
}

async function buildPositionSnapshot(tx, userId, marketId, direction) {
  const openLots = await tx.trade.findMany({
    where: {
      userId,
      marketId,
      direction,
      mode: 'buy',
      status: 'open',
      remainingAmount: { gt: 0 },
    },
    include: {
      market: { select: { yesPct: true, question: true, icon: true, slug: true, resolution: true, status: true } },
    },
  });

  if (openLots.length === 0) return null;

  const aggregated = aggregateOpenPositions(openLots)[0];
  return formatOpenPosition(aggregated);
}

function aggregateOpenPositions(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.marketId}:${row.direction}`;
    const remainingAmount = Number(row.remainingAmount || 0);
    const entryPct = decimalToNumber(row.entryPct);
    const marketYesPct = decimalToNumber(row.market.yesPct);
    const currentPct = getCurrentPctForDirection(marketYesPct, row.direction);

    if (!map.has(key)) {
      map.set(key, {
        kind: 'position',
        userId: row.userId,
        marketId: row.marketId,
        direction: row.direction,
        amount: 0,
        weightedCost: 0,
        unrealizedPnl: 0,
        createdAt: row.createdAt,
        market: row.market,
      });
    }

    const item = map.get(key);
    item.amount += remainingAmount;
    item.weightedCost += remainingAmount * entryPct;
    item.unrealizedPnl += estimatePnl(remainingAmount, entryPct, currentPct);
    if (row.createdAt < item.createdAt) item.createdAt = row.createdAt;
  }

  return Array.from(map.values()).map((item) => ({
    ...item,
    avgEntryPct: item.amount > 0 ? round2(item.weightedCost / item.amount) : 0,
  })).sort((a, b) => b.createdAt - a.createdAt);
}

function formatOpenPosition(position) {
  const currentYesPct = decimalToNumber(position.market.yesPct);
  const currentPct = getCurrentPctForDirection(currentYesPct, position.direction);

  return {
    id: `${position.marketId}:${position.direction}`,
    type: 'position',
    direction: position.direction,
    amount: roundInt(position.amount),
    remaining_amount: roundInt(position.amount),
    entry_pct: round2(position.avgEntryPct),
    current_pct: round2(currentPct),
    status: 'open',
    pnl: roundInt(position.unrealizedPnl),
    createdAt: position.createdAt,
    market: {
      id: position.marketId,
      slug: position.market.slug,
      question: position.market.question,
      icon: position.market.icon,
      current_pct: round2(currentPct),
      resolution: position.market.resolution,
      status: position.market.status,
    },
  };
}

function formatTradeRow(trade) {
  const marketYesPct = trade.market ? decimalToNumber(trade.market.yesPct) : null;
  const currentPct = trade.market ? getCurrentPctForDirection(marketYesPct, trade.direction) : null;

  return {
    id: trade.id,
    type: trade.mode === 'sell' ? 'sell' : 'trade',
    mode: trade.mode,
    direction: trade.direction,
    amount: Number(trade.amount),
    remaining_amount: Number(trade.remainingAmount || 0),
    entry_pct: decimalToNumber(trade.entryPct),
    status: trade.status,
    pnl: trade.pnl !== null && trade.pnl !== undefined ? Number(trade.pnl) : null,
    createdAt: trade.createdAt,
    closedAt: trade.closedAt || null,
    settledAt: trade.settledAt || null,
    market: trade.market ? {
      id: trade.market.id,
      slug: trade.market.slug,
      question: trade.market.question,
      icon: trade.market.icon,
      current_pct: currentPct,
      resolution: trade.market.resolution,
      status: trade.market.status,
      ends_at: trade.market.endsAt,
    } : null,
  };
}

function buildPnlHistory(trades) {
  const dailyMap = new Map();
  let running = 0;

  const sorted = [...trades].sort((a, b) => {
    const aDate = a.closedAt || a.settledAt || a.createdAt;
    const bDate = b.closedAt || b.settledAt || b.createdAt;
    return aDate - bDate;
  });

  for (const trade of sorted) {
    const date = (trade.closedAt || trade.settledAt || trade.createdAt).toISOString().slice(0, 10);
    running += Number(trade.pnl || 0);
    dailyMap.set(date, running);
  }

  return Array.from(dailyMap.entries())
    .slice(-30)
    .map(([date, pnl]) => ({ date, pnl }));
}

function countUniqueOpenPositions(rows) {
  const set = new Set(rows.map((row) => `${row.marketId}:${row.direction}`));
  return set.size;
}

function estimatePnl(amount, entryPct, currentPct) {
  return roundInt(amount * ((currentPct - entryPct) / 100));
}

function getCurrentPctForDirection(yesPct, direction) {
  return direction === 'yes' ? round2(yesPct) : round2(100 - yesPct);
}

function inferMarketStatus(market) {
  if (market.resolution) return 'resolved';
  if (market.endsAt && new Date(market.endsAt) <= new Date()) return 'closed';
  return 'open';
}

async function createTradeNotification(tx, payload) {
  await tx.notification.create({
    data: {
      userId: payload.userId,
      type: payload.type,
      icon: payload.icon,
      title: payload.title,
      body: payload.body,
      link: payload.link || null,
    },
  });
}

function assertUser(user) {
  if (!user) {
    throw appError('UNAUTHORIZED', '用戶不存在', 401);
  }
  if (user.status && user.status !== 'active') {
    throw appError('ACCOUNT_DISABLED', '帳戶目前不可交易', 403);
  }
}

function assertMarketIsTradable(market) {
  if (!market) throw appError('MARKET_NOT_FOUND', '找不到該預測市場', 404);
  if (market.status && !['open'].includes(market.status)) {
    throw appError('MARKET_CLOSED', '市場目前不可交易', 400);
  }
  if (market.resolution !== null) {
    throw appError('MARKET_CLOSED', '市場已結算，無法交易', 400);
  }
  if (new Date(market.endsAt) <= new Date()) {
    throw appError('MARKET_CLOSED', '市場已截止，無法交易', 400);
  }
}

function success(data, meta = {}) {
  return {
    data,
    error: null,
    meta,
  };
}

function sendValidationError(reply, message) {
  return reply.code(400).send({
    data: null,
    error: {
      code: 'VALIDATION_ERROR',
      message,
    },
    meta: {},
  });
}

function sendAppError(reply, error) {
  const statusCode = error.statusCode || 500;
  return reply.code(statusCode).send({
    data: null,
    error: {
      code: error.errCode || 'INTERNAL_SERVER_ERROR',
      message: error.message || '伺服器錯誤',
    },
    meta: {},
  });
}

function appError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.errCode = code;
  error.statusCode = statusCode;
  return error;
}

function decimal(value) {
  return value;
}

function decimalToNumber(value) {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function roundInt(value) {
  return Math.round(Number(value));
}
