// src/routes/markets.js
'use strict';

const { z } = require('zod');

const LIST_CACHE_TTL = 30;
const COUNTS_CACHE_TTL = 30;
const DETAIL_CACHE_TTL = 20;
const HISTORY_CACHE_TTL = 20;

const LIST_QUERY_SCHEMA = z.object({
  category: z.string().trim().optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['hot', 'new', 'ending', 'volume', 'participants', 'trending']).optional().default('hot'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

const HISTORY_QUERY_SCHEMA = z.object({
  range: z.enum(['1D', '1W', '1M', '3M', 'ALL']).optional().default('1W'),
});

module.exports = async function marketsRoutes(app) {
  app.get('/', async (req, reply) => {
    const parsed = LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數錯誤', parsed.error.flatten());
    }

    const { category, q, sort, page, limit } = parsed.data;
    const cacheKey = `markets:v3:list:${JSON.stringify(parsed.data)}`;

    const cached = await getCache(app, cacheKey);
    if (cached) return reply.send(cached);

    const where = buildMarketsWhere({ category, q });
    const orderBy = buildMarketsOrderBy(sort);
    const skip = (page - 1) * limit;

    const [markets, total] = await Promise.all([
      app.prisma.market.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: marketListSelect(),
      }),
      app.prisma.market.count({ where }),
    ]);

    const items = markets.map((market) => formatMarketListItem(market));
    const response = successResponse(
      { items },
      {
        total,
        page,
        limit,
        hasMore: page * limit < total,
        query: { category: category || 'all', q: q || '', sort },
      }
    );

    await setCache(app, cacheKey, response, LIST_CACHE_TTL);
    return reply.send(response);
  });

  app.get('/counts', async (_req, reply) => {
    const cacheKey = 'markets:v3:counts';
    const cached = await getCache(app, cacheKey);
    if (cached) return reply.send(cached);

    const now = new Date();
    const closingAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const baseWhere = buildOpenMarketWhere();

    const [all, trending, closing, byCategory] = await Promise.all([
      app.prisma.market.count({ where: baseWhere }),
      app.prisma.market.count({
        where: {
          AND: [
            baseWhere,
            { OR: [{ isHot: true }, { sortScore: { gt: 0 } }] },
          ],
        },
      }),
      app.prisma.market.count({
        where: {
          AND: [
            baseWhere,
            { endsAt: { gt: now, lte: closingAt } },
          ],
        },
      }),
      app.prisma.market.groupBy({
        by: ['category'],
        where: baseWhere,
        _count: { category: true },
      }),
    ]);

    const counts = {
      all,
      trending,
      closing,
      politics: 0,
      finance: 0,
      sports: 0,
      entertainment: 0,
      tech: 0,
      society: 0,
    };

    for (const row of byCategory) {
      counts[row.category] = row._count.category;
    }

    const response = successResponse(counts, {});
    await setCache(app, cacheKey, response, COUNTS_CACHE_TTL);
    return reply.send(response);
  });

  app.get('/:idOrSlug/probability-history', async (req, reply) => {
    const parsed = HISTORY_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數錯誤', parsed.error.flatten());
    }

    const { idOrSlug } = req.params;
    const { range } = parsed.data;
    const cacheKey = `markets:v3:history:${idOrSlug}:${range}`;
    const cached = await getCache(app, cacheKey);
    if (cached) return reply.send(cached);

    const market = await findMarketByIdOrSlug(app, idOrSlug, {
      id: true,
      slug: true,
      question: true,
      yesPct: true,
      endsAt: true,
      resolvedAt: true,
      status: true,
      resolution: true,
    });

    if (!market) {
      return sendError(reply, 404, 'MARKET_NOT_FOUND', '找不到該預測市場');
    }

    const since = getHistorySince(range);
    const points = await app.prisma.probabilityLog.findMany({
      where: {
        marketId: market.id,
        ...(since ? { recordedAt: { gte: since } } : {}),
      },
      orderBy: { recordedAt: 'asc' },
      select: {
        yesPct: true,
        recordedAt: true,
      },
    });

    const data = {
      market_id: market.id,
      slug: market.slug,
      question: market.question,
      range,
      current_yes_pct: toNumber(market.yesPct),
      status: market.status || deriveMarketStatus(market),
      resolution: market.resolution || 'pending',
      points: points.map((point) => ({
        t: point.recordedAt,
        yes_pct: toNumber(point.yesPct),
      })),
    };

    const response = successResponse(data, {});
    await setCache(app, cacheKey, response, HISTORY_CACHE_TTL);
    return reply.send(response);
  });

  app.get('/:idOrSlug', async (req, reply) => {
    const { idOrSlug } = req.params;
    const cacheKey = `markets:v3:detail:${idOrSlug}`;
    const cached = await getCache(app, cacheKey);
    if (cached) return reply.send(cached);

    const market = await findMarketByIdOrSlug(app, idOrSlug, {
      ...marketDetailSelect(),
      _count: {
        select: {
          comments: true,
          trades: true,
        },
      },
    });

    if (!market) {
      return sendError(reply, 404, 'MARKET_NOT_FOUND', '找不到該預測市場');
    }

    const [recentTrades, distribution, probHistory] = await Promise.all([
      app.prisma.trade.findMany({
        where: {
          marketId: market.id,
          mode: 'buy',
        },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          direction: true,
          amount: true,
          mode: true,
          createdAt: true,
        },
      }),
      app.prisma.trade.groupBy({
        by: ['direction'],
        where: {
          marketId: market.id,
          status: 'open',
          mode: 'buy',
          remainingAmount: { gt: 0 },
        },
        _sum: { remainingAmount: true },
        _count: { direction: true },
      }),
      app.prisma.probabilityLog.findMany({
        where: { marketId: market.id },
        orderBy: { recordedAt: 'desc' },
        take: 90,
        select: {
          yesPct: true,
          recordedAt: true,
        },
      }),
    ]);

    const data = {
      ...formatMarketDetail(market),
      commentCount: market._count.comments,
      tradeCount: market._count.trades,
      recentTrades: recentTrades.map((trade) => ({
        id: trade.id,
        direction: trade.direction,
        mode: trade.mode,
        amount: Number(trade.amount),
        ago: timeAgo(trade.createdAt),
        created_at: trade.createdAt,
      })),
      distribution: normalizeDistribution(distribution),
      probHistory: probHistory
        .slice()
        .reverse()
        .map((point) => ({
          t: point.recordedAt,
          yes_pct: toNumber(point.yesPct),
        })),
    };

    const response = successResponse(data, {});
    await setCache(app, cacheKey, response, DETAIL_CACHE_TTL);
    return reply.send(response);
  });
};

module.exports = async function marketsRoutes(app) {};
