// src/server.js
'use strict';

const Fastify = require('fastify');
const { PrismaClient } = require('@prisma/client');

// ── Prisma singleton ────────────────────────────────
const prisma = new PrismaClient();

// ── Create Fastify instance ─────────────────────────
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

// ── Attach Prisma to app ─────────────────────────────
app.decorate('prisma', prisma);

async function buildApp() {
  // ── Plugins ────────────────────────────────────────
  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: false,
  });

  await app.register(require('@fastify/cors'), {
    origin: (process.env.CORS_ORIGINS || '*').split(','),
    credentials: true,
  });

  await app.register(require('@fastify/rate-limit'), {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    errorResponseBuilder: () => ({
      ok: false,
      error: { code: 'RATE_LIMITED', message: '請求過於頻繁，請稍後再試' },
    }),
  });

  await app.register(require('@fastify/jwt'), {
    secret: process.env.JWT_ACCESS_SECRET || 'dev-secret-change-in-production',
    sign: { expiresIn: process.env.JWT_ACCESS_TTL || '15m' },
  });

  // Redis (optional — graceful fallback if not configured)
  if (process.env.REDIS_URL) {
    await app.register(require('@fastify/redis'), {
      url: process.env.REDIS_URL,
      closeClient: true,
    });
  }

  // ── Auth middleware ────────────────────────────────
  app.decorate('authenticate', async function (req, reply) {
    try {
      await req.jwtVerify();
    } catch (err) {
      reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: '未登入或 Token 無效' },
      });
    }
  });

  // ── Routes ────────────────────────────────────────
  await app.register(require('./routes/health'), { prefix: '/health' });
  await app.register(require('./routes/auth'),    { prefix: '/v1/auth' });
  await app.register(require('./routes/oauth'),  { prefix: '/v1/auth' });
  await app.register(require('./routes/markets'), { prefix: '/v1/markets' });
  await app.register(require('./routes/trades'),  { prefix: '/v1/trades' });
  await app.register(require('./routes/users'),   { prefix: '/v1/users' });
  await app.register(require('./routes/notifications'), { prefix: '/v1/notifications' });
  await app.register(require('./routes/shop'),    { prefix: '/v1/shop' });

  // ── Global error handler ──────────────────────────
  app.setErrorHandler((err, req, reply) => {
    app.log.error(err);

    if (err.validation) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: '請求參數格式錯誤', details: err.validation },
      });
    }

    const code    = err.statusCode || 500;
    const message = code < 500 ? err.message : '伺服器內部錯誤';
    reply.code(code).send({
      ok: false,
      error: { code: err.errCode || 'INTERNAL_ERROR', message },
    });
  });

  return app;
}

// ── Start ──────────────────────────────────────────
buildApp().then(async (server) => {
  try {
    await prisma.$connect();
    server.log.info('✅ PostgreSQL connected');

    const port = parseInt(process.env.PORT || '3001');
    await server.listen({ port, host: '0.0.0.0' });
    server.log.info(`🚀 Predic API running on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
});

// ── Graceful shutdown ─────────────────────────────
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
