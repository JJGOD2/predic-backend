// src/routes/notifications.js
'use strict';

module.exports = async function (app) {

  // ── GET /v1/notifications ──────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const type   = req.query.type  || 'all';
    const unread = req.query.unread === 'true';
    const page   = parseInt(req.query.page  || '1');
    const limit  = Math.min(parseInt(req.query.limit || '30'), 100);

    const where = { userId };
    if (type !== 'all') where.type = type;
    if (unread) where.isRead = false;

    const [items, total, unreadCount] = await Promise.all([
      app.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
      app.prisma.notification.count({ where }),
      app.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    reply.send({
      ok: true,
      data:        items,
      unread_count: unreadCount,
      meta: { total, page, limit, hasMore: page * limit < total },
    });
  });

  // ── POST /v1/notifications/read-all ───────────────
  app.post('/read-all', { preHandler: [app.authenticate] }, async (req, reply) => {
    const result = await app.prisma.notification.updateMany({
      where: { userId: req.user.sub, isRead: false },
      data:  { isRead: true },
    });
    reply.send({ ok: true, data: { updated_count: result.count } });
  });

  // ── POST /v1/notifications/:id/read ──────────────
  app.post('/:id/read', { preHandler: [app.authenticate] }, async (req, reply) => {
    await app.prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.sub },
      data:  { isRead: true },
    });
    reply.send({ ok: true });
  });

  // ── POST /v1/notifications/push-subscribe ─────────
  app.post('/push-subscribe', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { subscription } = req.body || {};
    if (!subscription?.endpoint) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '缺少 subscription' } });
    }

    await app.prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        userId:    req.user.sub,
        endpoint:  subscription.endpoint,
        p256dh:    subscription.keys?.p256dh || '',
        auth:      subscription.keys?.auth || '',
        userAgent: req.headers['user-agent'],
      },
      update: { userId: req.user.sub },
    });

    reply.send({ ok: true, data: { subscribed: true } });
  });
};
