'use strict';

const { z } = require('zod');

const ALLOWED_TYPES = ['all', 'system', 'trade', 'result', 'reward', 'promo', 'security'];
const UNREAD_WINDOW_DAYS = 30;

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
    error: {
      code,
      message,
      details,
    },
    meta: {},
  });
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildNotificationGroupLabel(date) {
  const now = new Date();
  const target = new Date(date);

  if (isSameDay(now, target)) return '今天';

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(yesterday, target)) return '昨天';

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (target >= startOfDay(sevenDaysAgo)) return '近 7 天';

  return '較早通知';
}

function normalizeNotification(item) {
  return {
    id: item.id,
    type: item.type,
    icon: item.icon,
    title: item.title,
    body: item.body,
    link: item.link,
    isRead: item.isRead,
    isPushed: item.isPushed,
    createdAt: item.createdAt,
    groupLabel: buildNotificationGroupLabel(item.createdAt),
  };
}

function groupNotifications(items) {
  const order = ['今天', '昨天', '近 7 天', '較早通知'];
  const map = new Map();

  for (const item of items) {
    const key = item.groupLabel || '較早通知';
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(item);
  }

  return order
    .filter((label) => map.has(label))
    .map((label) => ({
      label,
      items: map.get(label),
      count: map.get(label).length,
    }));
}

function buildWhereClause(userId, query) {
  const where = {
    userId,
  };

  if (query.type && query.type !== 'all') {
    where.type = query.type;
  }

  if (query.unreadOnly) {
    where.isRead = false;
  }

  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = startOfDay(query.fromDate);
    if (query.toDate) where.createdAt.lte = endOfDay(query.toDate);
  }

  return where;
}

async function createNotificationCounts(app, userId) {
  const since = new Date();
  since.setDate(since.getDate() - UNREAD_WINDOW_DAYS);

  const [unreadCount, typeBuckets] = await Promise.all([
    app.prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    }),
    app.prisma.notification.groupBy({
      by: ['type'],
      where: {
        userId,
        createdAt: {
          gte: since,
        },
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  const countsByType = {
    all: 0,
    system: 0,
    trade: 0,
    result: 0,
    reward: 0,
    promo: 0,
    security: 0,
  };

  for (const bucket of typeBuckets) {
    countsByType[bucket.type] = bucket._count._all;
    countsByType.all += bucket._count._all;
  }

  return {
    unreadCount,
    countsByType,
  };
}

module.exports = async function notificationsRoutes(app) {
  const listQuerySchema = z.object({
    type: z.enum(ALLOWED_TYPES).optional().default('all'),
    unread: z.union([z.string(), z.boolean()]).optional().default(false),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(30),
    grouped: z.union([z.string(), z.boolean()]).optional().default(true),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  });

  const readOneParamsSchema = z.object({
    id: z.string().min(1),
  });

  const pushSubscribeSchema = z.object({
    subscription: z.object({
      endpoint: z.string().url(),
      expirationTime: z.any().optional(),
      keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      }),
    }),
  });

  const pushUnsubscribeSchema = z.object({
    endpoint: z.string().url(),
  });

  // GET /v1/notifications
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '通知查詢參數不正確。', parsed.error.flatten());
    }

    const userId = req.user.sub;
    const query = parsed.data;
    const unreadOnly = String(query.unread) === 'true' || query.unread === true;
    const grouped = String(query.grouped) !== 'false' && query.grouped !== false;

    const fromDate = query.from ? new Date(query.from) : null;
    const toDate = query.to ? new Date(query.to) : null;

    const where = buildWhereClause(userId, {
      type: query.type,
      unreadOnly,
      fromDate,
      toDate,
    });

    const [items, total, counts] = await Promise.all([
      app.prisma.notification.findMany({
        where,
        orderBy: [
          { isRead: 'asc' },
          { createdAt: 'desc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      app.prisma.notification.count({ where }),
      createNotificationCounts(app, userId),
    ]);

    const normalizedItems = items.map(normalizeNotification);
    const groups = grouped ? groupNotifications(normalizedItems) : [];

    return sendSuccess(
      reply,
      {
        items: normalizedItems,
        groups,
        summary: {
          unreadCount: counts.unreadCount,
          countsByType: counts.countsByType,
        },
      },
      {
        total,
        page: query.page,
        limit: query.limit,
        hasMore: query.page * query.limit < total,
        unread_count: counts.unreadCount,
        type: query.type,
        unread_only: unreadOnly,
        grouped,
      }
    );
  });

  // POST /v1/notifications/read-all
  app.post('/read-all', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const result = await app.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    const unreadCount = await app.prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });

    return sendSuccess(
      reply,
      {
        updatedCount: result.count,
        unreadCount,
      },
      {
        unread_count: unreadCount,
      }
    );
  });

  // POST /v1/notifications/:id/read
  app.post('/:id/read', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = readOneParamsSchema.safeParse(req.params || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '通知編號不正確。', parsed.error.flatten());
    }

    const userId = req.user.sub;
    const notification = await app.prisma.notification.findFirst({
      where: {
        id: parsed.data.id,
        userId,
      },
    });

    if (!notification) {
      return sendError(reply, 404, 'NOT_FOUND', '找不到通知。');
    }

    if (!notification.isRead) {
      await app.prisma.notification.update({
        where: { id: notification.id },
        data: { isRead: true },
      });
    }

    const unreadCount = await app.prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });

    return sendSuccess(
      reply,
      {
        id: notification.id,
        isRead: true,
        unreadCount,
      },
      {
        unread_count: unreadCount,
      }
    );
  });

  // POST /v1/notifications/push-subscribe
  app.post('/push-subscribe', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = pushSubscribeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '缺少有效的推播訂閱資料。', parsed.error.flatten());
    }

    const { subscription } = parsed.data;

    const record = await app.prisma.pushSubscription.upsert({
      where: {
        endpoint: subscription.endpoint,
      },
      create: {
        userId: req.user.sub,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: req.headers['user-agent'] || null,
      },
      update: {
        userId: req.user.sub,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: req.headers['user-agent'] || null,
      },
    });

    return sendSuccess(reply, {
      subscribed: true,
      id: record.id,
      endpoint: record.endpoint,
    });
  });

  // POST /v1/notifications/push-unsubscribe
  app.post('/push-unsubscribe', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = pushUnsubscribeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '缺少要取消訂閱的 endpoint。', parsed.error.flatten());
    }

    const result = await app.prisma.pushSubscription.deleteMany({
      where: {
        endpoint: parsed.data.endpoint,
        userId: req.user.sub,
      },
    });

    return sendSuccess(reply, {
      unsubscribed: true,
      deletedCount: result.count,
    });
  });
};
