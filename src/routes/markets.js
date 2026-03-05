// src/routes/markets.js
'use strict';

const { z } = require('zod');

const CACHE_TTL = 30; // seconds

module.exports = async function (app) {

  // ── GET /v1/markets ────────────────────────────────
  app.get('/', async (req, reply) => {
    const schema = z.object({
      category: z.string().optional(),
      q:        z.string().optional(),
      sort:     z.enum(['hot', 'new', 'ending', 'volume']).optional().default('hot'),
      page:     z.coerce.number().int().positive().optional().default(1),
      limit:    z.coerce.number().int().min(1).max(50).optional().default(20),
    });

    const query = schema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '查詢參數錯誤' } });
    }

    const { category, q, sort, page, limit } = query.data;

    // Try Redis cache first
    const cacheKey = `markets:list:${JSON.stringify(query.data)}`;
    if (app.redis) {
      const cached = await app.redis.get(cacheKey);
      if (cached) return reply.send(JSON.parse(cached));
    }

    const where = {};
    const now   = new Date();

    if (category === 'trending') {
      where.isHot = true;
    } else if (category === 'closing') {
      where.endsAt = { gt: now, lt: new Date(now.getTime() + 7 * 86400000) };
    } else if (category && category !== 'all') {
      where.category = category;
    }

    if (q) {
      where.question = { contains: q, mode: 'insensitive' };
    }

    // Default: only pending markets
    if (!where.resolution) where.resolution = null;

    const orderBy = {
      hot:    { participantCount: 'desc' },
      new:    { createdAt:        'desc' },
      ending: { endsAt:           'asc'  },
      volume: { volumeScore:      'desc' },
    }[sort];

    const [markets, total] = await Promise.all([
      app.prisma.market.findMany({
        where,
        orderBy,
        skip:  (page - 1) * limit,
        take:  limit,
        select: marketSelect(),
      }),
      app.prisma.market.count({ where }),
    ]);

    const response = {
      ok: true,
      data: markets.map(formatMarket),
      meta: { total, page, limit, hasMore: page * limit < total },
    };

    if (app.redis) await app.redis.setex(cacheKey, CACHE_TTL, JSON.stringify(response));

    reply.send(response);
  });

  // ── GET /v1/markets/counts ─────────────────────────
  app.get('/counts', async (req, reply) => {
    const cacheKey = 'markets:counts';
    if (app.redis) {
      const cached = await app.redis.get(cacheKey);
      if (cached) return reply.send(JSON.parse(cached));
    }

    const now     = new Date();
    const closing = new Date(now.getTime() + 90 * 86400000);

    const [all, trending, closingCount, byCategory] = await Promise.all([
      app.prisma.market.count({ where: { resolution: null } }),
      app.prisma.market.count({ where: { resolution: null, isHot: true } }),
      app.prisma.market.count({ where: { resolution: null, endsAt: { gt: now, lt: closing } } }),
      app.prisma.market.groupBy({
        by: ['category'],
        where: { resolution: null },
        _count: { category: true },
      }),
    ]);

    const counts = { all, trending, closing: closingCount };
    byCategory.forEach(r => { counts[r.category] = r._count.category; });

    const response = { ok: true, data: counts };
    if (app.redis) await app.redis.setex(cacheKey, CACHE_TTL, JSON.stringify(response));
    reply.send(response);
  });

  // ── GET /v1/markets/:id ────────────────────────────
  app.get('/:id', async (req, reply) => {
    const market = await app.prisma.market.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
      select: {
        ...marketSelect(),
        description: true,
        probHistory: {
          orderBy: { recordedAt: 'desc' },
          take: 90,
          select: { yesPct: true, recordedAt: true },
        },
        _count: { select: { comments: true } },
      },
    });

    if (!market) {
      return reply.code(404).send({ ok: false, error: { code: 'MARKET_NOT_FOUND', message: '找不到該預測市場' } });
    }

    // Recent trades (anonymous)
    const recentTrades = await app.prisma.trade.findMany({
      where:   { marketId: market.id },
      orderBy: { createdAt: 'desc' },
      take:    10,
      select:  { direction: true, amount: true, createdAt: true },
    });

    // Order book distribution (buy/no buckets)
    const distribution = await app.prisma.trade.groupBy({
      by: ['direction'],
      where:  { marketId: market.id, status: 'open' },
      _sum:   { amount: true },
      _count: { direction: true },
    });

    reply.send({
      ok: true,
      data: {
        ...formatMarket(market),
        description: market.description,
        commentCount: market._count.comments,
        probHistory: market.probHistory.map(p => ({
          t:       p.recordedAt,
          yes_pct: Number(p.yesPct),
        })).reverse(),
        distribution: distribution.map(d => ({
          direction: d.direction,
          totalAmount: Number(d._sum.amount || 0),
          count:       d._count.direction,
        })),
        recentTrades: recentTrades.map(t => ({
          direction: t.direction,
          amount:    Number(t.amount),
          ago:       timeAgo(t.createdAt),
        })),
      },
    });
  });

  // ── GET /v1/markets/:id/probability-history ────────
  app.get('/:id/probability-history', async (req, reply) => {
    const range = req.query.range || '1W';
    const days  = { '1D': 1, '1W': 7, '1M': 30, 'ALL': 365 }[range] || 7;
    const since = new Date(Date.now() - days * 86400000);

    const points = await app.prisma.probabilityLog.findMany({
      where:   { marketId: req.params.id, recordedAt: { gte: since } },
      orderBy: { recordedAt: 'asc' },
      select:  { yesPct: true, recordedAt: true },
    });

    const market = await app.prisma.market.findUnique({
      where:  { id: req.params.id },
      select: { yesPct: true },
    });

    reply.send({
      ok: true,
      data: {
        range,
        market_id:       req.params.id,
        current_yes_pct: Number(market?.yesPct || 50),
        points: points.map(p => ({ t: p.recordedAt, yes_pct: Number(p.yesPct) })),
      },
    });
  });
};

// ── Helpers ───────────────────────────────────────────
function marketSelect() {
  return {
    id: true, slug: true, category: true, icon: true, question: true,
    yesPct: true, resolution: true, volumeScore: true, participantCount: true,
    endsAt: true, resolvedAt: true, isHot: true, isSponsored: true,
    sponsorName: true, communityThreshold: true, createdAt: true,
  };
}

function formatMarket(m) {
  return {
    id:                 m.id,
    slug:               m.slug,
    category:           m.category,
    icon:               m.icon,
    question:           m.question,
    yes:                Number(m.yesPct),
    no:                 100 - Number(m.yesPct),
    resolution:         m.resolution,
    vol:                formatVolume(Number(m.volumeScore)),
    p:                  m.participantCount.toLocaleString(),
    ends:               m.endsAt?.toISOString().split('T')[0].replace(/-/g, '/'),
    hot:                m.isHot,
    sponsored:          m.isSponsored,
    sponsorName:        m.sponsorName,
    communityThreshold: m.communityThreshold,
  };
}

function formatVolume(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M積分';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K積分';
  return n + '積分';
}

function timeAgo(date) {
  const mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 60)  return mins + '分鐘前';
  if (mins < 1440) return Math.floor(mins / 60) + '小時前';
  return Math.floor(mins / 1440) + '天前';
}
