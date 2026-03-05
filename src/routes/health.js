// src/routes/health.js
'use strict';

module.exports = async function (app) {
  app.get('/', async (req, reply) => {
    let dbOk = false;
    let redisOk = false;

    try {
      await app.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {}

    try {
      if (app.redis) {
        await app.redis.ping();
        redisOk = true;
      }
    } catch {}

    const healthy = dbOk;
    reply.code(healthy ? 200 : 503).send({
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      version: '1.0.0',
      services: { db: dbOk, redis: redisOk },
      ts: new Date().toISOString(),
    });
  });
};
