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
  // GET /v1/markets
  app.get('/', async (req, reply) => {
    const parsed = LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數錯誤', parsed.error.flatten());
    }

    const { category, q, sort, page, limit } = parsed.data;
    const cacheKey = `markets:v2:list:${JSON.stringify(parsed.data)}`;

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

    const data = markets.map((market) => formatMarketListItem(market));
    const response = successResponse(data, {
      total,
      page,
      limit,
      hasMore: page * limit < total,
      query: { category: category || 'all', q: q || '', sort },
    });

    await setCache(app, cacheKey, response, LIST_CACHE_TTL);
    return reply.send(response);
  });

  // GET /v1/markets/counts
  app.get('/counts', async (_req, reply) => {
    const cacheKey = 'markets:v2:counts';
    const cached = await getCache(app, cacheKey);
    if (cached) return reply.send(cached);

    const now = new Date();
    const closingAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const baseWhere = buildOpenMarketWhere();

    const [
      all,
      trending,
      closing,
      byCategory,
    ] = await Promise.all([
      app.prisma.market.count({ where: baseWhere }),
      app.prisma.market.count({
        where: {
          ...baseWhere,
          OR: [{ isHot: true }, { sortScore: { gt: 0 } }],
        },
      }),
      app.prisma.market.count({
        where: {
          ...baseWhere,
          endsAt: { gt: now, lte: closingAt },
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

  // GET /v1/markets/:idOrSlug/probability-history
  app.get('/:idOrSlug/probability-history', async (req, reply) => {
    const parsed = HISTORY_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數錯誤', parsed.error.flatten());
    }

    const { idOrSlug } = req.params;
    const { range } = parsed.data;
    const cacheKey = `markets:v2:history:${idOrSlug}:${range}`;
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
        recordedAt: since ? { gte: since } : undefined,
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

  // GET /v1/markets/:idOrSlug
  app.get('/:idOrSlug', async (req, reply) => {
    const { idOrSlug } = req.params;
    const cacheKey = `markets:v2:detail:${idOrSlug}`;
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
        _sum: {
          remainingAmount: true,
        },
        _count: {
          direction: true,
        },
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

function marketListSelect() {
  return {
    id: true,
    slug: true,
    category: true,
    icon: true,
    tag: true,
    question: true,
    yesPct: true,
    status: true,
    resolution: true,
    volumeScore: true,
    participantCount: true,
    endsAt: true,
    resolvedAt: true,
    isHot: true,
    isSponsored: true,
    sponsorName: true,
    communityThreshold: true,
    sortScore: true,
    createdAt: true,
  };
}

function marketDetailSelect() {
  return {
    id: true,
    slug: true,
    category: true,
    icon: true,
    tag: true,
    question: true,
    description: true,
    yesPct: true,
    status: true,
    resolution: true,
    resolutionSource: true,
    volumeScore: true,
    participantCount: true,
    endsAt: true,
    resolvedAt: true,
    isHot: true,
    isSponsored: true,
    sponsorName: true,
    communityThreshold: true,
    sortScore: true,
    createdAt: true,
    updatedAt: true,
  };
}

function buildMarketsWhere({ category, q }) {
  const where = buildOpenMarketWhere();

  if (category === 'trending') {
    where.OR = [{ isHot: true }, { sortScore: { gt: 0 } }];
  } else if (category === 'closing') {
    const now = new Date();
    const closingAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    where.endsAt = { gt: now, lte: closingAt };
  } else if (category && category !== 'all') {
    where.category = category;
  }

  if (q) {
    where.OR = mergeOr(where.OR, [
      { question: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { tag: { contains: q, mode: 'insensitive' } },
      { sponsorName: { contains: q, mode: 'insensitive' } },
    ]);
  }

  return where;
}

function buildOpenMarketWhere() {
  return {
    OR: [
      { status: 'open' },
      {
        status: null,
        resolution: null,
      },
    ],
  };
}

function buildMarketsOrderBy(sort) {
  switch (sort) {
    case 'new':
      return [{ createdAt: 'desc' }];
    case 'ending':
      return [{ endsAt: 'asc' }, { participantCount: 'desc' }];
    case 'volume':
      return [{ volumeScore: 'desc' }, { participantCount: 'desc' }];
    case 'participants':
      return [{ participantCount: 'desc' }, { volumeScore: 'desc' }];
    case 'trending':
      return [{ sortScore: 'desc' }, { isHot: 'desc' }, { participantCount: 'desc' }];
    case 'hot':
    default:
      return [{ isHot: 'desc' }, { sortScore: 'desc' }, { participantCount: 'desc' }, { volumeScore: 'desc' }];
  }
}

async function findMarketByIdOrSlug(app, idOrSlug, select) {
  return app.prisma.market.findFirst({
    where: {
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
    select,
  });
}

function formatMarketListItem(market) {
  const yes = toNumber(market.yesPct);
  const no = clampPct(100 - yes);
  const status = market.status || deriveMarketStatus(market);
  const tag = market.tag || defaultTagForCategory(market.category);

  return {
    id: market.id,
    slug: market.slug,
    category: market.category,
    icon: market.icon,
    tag,
    question: market.question,
    q: market.question,
    yes,
    no,
    status,
    resolution: market.resolution || 'pending',
    vol: formatVolume(market.volumeScore),
    volume_score: bigIntToNumber(market.volumeScore),
    p: formatParticipants(market.participantCount),
    participant_count: market.participantCount,
    ends: formatDateSlash(market.endsAt),
    ends_at: market.endsAt,
    hot: Boolean(market.isHot),
    sponsored: Boolean(market.isSponsored),
    sponsorName: market.sponsorName || null,
    communityThreshold: market.communityThreshold,
    sortScore: toNumber(market.sortScore || 0),
    tc: tagClassForCategory(market.category),
    created_at: market.createdAt,
  };
}

function formatMarketDetail(market) {
  const listItem = formatMarketListItem(market);
  return {
    ...listItem,
    description: market.description || '',
    resolution_source: market.resolutionSource || null,
    resolved_at: market.resolvedAt,
    updated_at: market.updatedAt,
    metadata: {
      community_threshold: market.communityThreshold,
      sponsor_name: market.sponsorName || null,
      sort_score: toNumber(market.sortScore || 0),
    },
  };
}

function normalizeDistribution(rows) {
  const base = {
    yes: { direction: 'yes', totalAmount: 0, count: 0 },
    no: { direction: 'no', totalAmount: 0, count: 0 },
  };

  for (const row of rows || []) {
    const direction = row.direction === 'no' ? 'no' : 'yes';
    base[direction] = {
      direction,
      totalAmount: Number(row._sum.remainingAmount || 0),
      count: row._count.direction || 0,
    };
  }

  return [base.yes, base.no];
}

function deriveMarketStatus(market) {
  if (market.status) return market.status;
  if (market.resolution) {
    return market.resolution === 'voided' ? 'voided' : 'resolved';
  }
  if (market.endsAt && new Date(market.endsAt) <= new Date()) {
    return 'closed';
  }
  return 'open';
}

function defaultTagForCategory(category) {
  const mapping = {
    politics: '政治',
    finance: '財經',
    sports: '運動',
    entertainment: '娛樂',
    tech: '科技',
    society: '社會',
  };
  return mapping[category] || '熱門';
}

function tagClassForCategory(category) {
  const mapping = {
    politics: 'politics',
    finance: 'finance',
    sports: 'sports',
    entertainment: 'entertainment',
    tech: 'tech',
    society: 'society',
  };
  return mapping[category] || 'society';
}

function getHistorySince(range) {
  if (range === 'ALL') return null;
  const map = {
    '1D': 1,
    '1W': 7,
    '1M': 30,
    '3M': 90,
  };
  const days = map[range] || 7;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function formatDateSlash(date) {
  if (!date) return null;
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function formatParticipants(count) {
  return Number(count || 0).toLocaleString('zh-TW');
}

function formatVolume(value) {
  const n = bigIntToNumber(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M積分`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K積分`;
  return `${n}積分`;
}

function bigIntToNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value == null) return 0;
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return Number(value.toString());
  }
  return Number(value);
}

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return Number(value.toString());
  }
  return Number(value);
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value.toFixed ? value.toFixed(2) : value)));
}

function timeAgo(date) {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.max(1, Math.floor(diffMs / 60000));
  if (mins < 60) return `${mins}分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小時前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function mergeOr(existingOr, items) {
  if (!existingOr || existingOr.length === 0) return items;
  return existingOr.concat(items);
}

function successResponse(data, meta = {}) {
  return {
    data,
    error: null,
    meta,
  };
}

function sendError(reply, statusCode, code, message, details = null) {
  return reply.code(statusCode).send({
    data: null,
    error: {
      code,
      message,
      details,
    },
    meta: {},
  });
}

async function getCache(app, key) {
  if (!app.redis) return null;
  try {
    const raw = await app.redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setCache(app, key, payload, ttl) {
  if (!app.redis) return;
  try {
    await app.redis.setex(key, ttl, JSON.stringify(payload));
  } catch {
    // ignore cache write errors
  }
}
