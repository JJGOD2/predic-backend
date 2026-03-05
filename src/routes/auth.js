// src/routes/auth.js
'use strict';

const bcrypt  = require('bcryptjs');
const { z }   = require('zod');
const { authenticator } = require('otplib');

// OTP store (in-memory for dev; use Redis in prod)
const otpStore = new Map(); // key: `${email}:${purpose}` → { code, expiresAt, attempts }

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpKey(target, purpose) {
  return `otp:${target}:${purpose}`;
}

module.exports = async function (app) {

  // ── POST /v1/auth/register ─────────────────────────
  app.post('/register', async (req, reply) => {
    const schema = z.object({
      username:     z.string().min(3).max(20),
      email:        z.string().email(),
      password:     z.string().min(8),
      referral_code: z.string().optional(),
    });

    const body = schema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '請求參數格式錯誤' } });
    }

    const { username, email, password, referral_code } = body.data;

    // Check duplicates
    const existing = await app.prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      const code = existing.email === email ? 'EMAIL_EXISTS' : 'USERNAME_TAKEN';
      const msg  = code === 'EMAIL_EXISTS' ? '此 Email 已被使用' : '此用戶名稱已被使用';
      return reply.code(409).send({ ok: false, error: { code, message: msg } });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await app.prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        score: 1000n, // 新手禮 1000 積分
      },
    });

    // Handle referral
    if (referral_code) {
      const referrer = await app.prisma.user.findUnique({ where: { username: referral_code } });
      if (referrer) {
        await app.prisma.referralReward.create({
          data: { referrerId: referrer.id, refereeId: user.id, rewardScore: 200 },
        });
        await app.prisma.user.update({
          where: { id: referrer.id },
          data:  { score: { increment: 200n } },
        });
      }
    }

    const accessToken  = app.jwt.sign({ sub: user.id, role: 'user' });
    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_TTL || '30d' }
    );

    reply.code(201).send({
      ok: true,
      data: {
        user: sanitizeUser(user),
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    });
  });

  // ── POST /v1/auth/login ────────────────────────────
  app.post('/login', async (req, reply) => {
    const schema = z.object({
      email:    z.string().email(),
      password: z.string(),
    });

    const body = schema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '請求參數格式錯誤' } });
    }

    const user = await app.prisma.user.findUnique({ where: { email: body.data.email } });
    if (!user) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Email 或密碼錯誤' } });
    }

    const valid = await bcrypt.compare(body.data.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Email 或密碼錯誤' } });
    }

    await app.prisma.user.update({
      where: { id: user.id },
      data:  { lastLoginAt: new Date() },
    });

    const accessToken  = app.jwt.sign({ sub: user.id, role: 'user' });
    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_TTL || '30d' }
    );

    reply.send({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: sanitizeUser(user),
      },
    });
  });

  // ── POST /v1/auth/refresh ──────────────────────────
  app.post('/refresh', async (req, reply) => {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '缺少 refresh_token' } });
    }

    try {
      const payload = app.jwt.verify(refresh_token);
      if (payload.type !== 'refresh') throw new Error('not refresh token');

      const user = await app.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new Error('user not found');

      const accessToken = app.jwt.sign({ sub: user.id, role: 'user' });
      reply.send({ ok: true, data: { access_token: accessToken } });
    } catch {
      reply.code(401).send({ ok: false, error: { code: 'TOKEN_EXPIRED', message: 'Refresh Token 無效' } });
    }
  });

  // ── POST /v1/auth/send-otp ─────────────────────────
  app.post('/send-otp', async (req, reply) => {
    const schema = z.object({
      target:  z.string(),
      purpose: z.enum(['register', 'login', 'reset_password']),
    });

    const body = schema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '請求參數格式錯誤' } });
    }

    const { target, purpose } = body.data;
    const code = generateOtp();
    const key  = otpKey(target, purpose);

    // Store in memory (or Redis if available)
    if (app.redis) {
      await app.redis.setex(key, 300, JSON.stringify({ code, attempts: 0 }));
    } else {
      otpStore.set(key, { code, expiresAt: Date.now() + 300_000, attempts: 0 });
    }

    // In production: send via email/SMS. For dev: return in response
    app.log.info(`[OTP] ${target} (${purpose}): ${code}`);

    const responseData = { ok: true, data: { message: 'OTP 已發送' } };
    // DEV ONLY: expose code in non-production
    if (process.env.NODE_ENV !== 'production') {
      responseData.data._dev_code = code;
    }

    reply.send(responseData);
  });

  // ── POST /v1/auth/verify-otp ───────────────────────
  app.post('/verify-otp', async (req, reply) => {
    const schema = z.object({
      target:  z.string(),
      code:    z.string().length(6),
      purpose: z.enum(['register', 'login', 'reset_password']),
    });

    const body = schema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: '請求參數格式錯誤' } });
    }

    const { target, code, purpose } = body.data;
    const key = otpKey(target, purpose);

    let stored;
    if (app.redis) {
      const raw = await app.redis.get(key);
      stored = raw ? JSON.parse(raw) : null;
    } else {
      stored = otpStore.get(key);
      if (stored && stored.expiresAt < Date.now()) stored = null;
    }

    if (!stored) {
      return reply.code(400).send({ ok: false, error: { code: 'OTP_EXPIRED', message: 'OTP 已過期或無效' } });
    }

    if (stored.code !== code) {
      stored.attempts++;
      if (app.redis) await app.redis.setex(key, 300, JSON.stringify(stored));
      return reply.code(400).send({ ok: false, error: { code: 'OTP_INVALID', message: 'OTP 錯誤' } });
    }

    // OTP valid — delete it
    if (app.redis) await app.redis.del(key);
    else otpStore.delete(key);

    reply.send({ ok: true, data: { verified: true } });
  });
};

// ── Helper ────────────────────────────────────────────
function sanitizeUser(user) {
  return {
    id:          user.id,
    username:    user.username,
    email:       user.email,
    avatarUrl:   user.avatarUrl,
    score:       Number(user.score),
    gem:         user.gem,
    ntdBalance:  Number(user.ntdBalance),
    isPro:       user.isPro,
    proExpiresAt: user.proExpiresAt,
    status:      user.status,
    createdAt:   user.createdAt,
  };
}
