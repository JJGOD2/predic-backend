'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');

const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS || 300);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d';
const DEV_EXPOSE_OTP = process.env.NODE_ENV !== 'production';

// In-memory fallback for development when Redis is unavailable.
const otpStore = new Map();

const REGISTER_SCHEMA = z.object({
  username: z.string().trim().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/, 'username format invalid'),
  email: z.string().trim().email(),
  password: z.string().min(8).max(100),
  phone: z.string().trim().min(6).max(20).optional(),
  referral_code: z.string().trim().min(2).max(50).optional(),
});

const LOGIN_SCHEMA = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(100),
});

const REFRESH_SCHEMA = z.object({
  refresh_token: z.string().min(1),
});

const LOGOUT_SCHEMA = z.object({
  refresh_token: z.string().optional(),
}).optional();

const SEND_OTP_SCHEMA = z.object({
  target: z.string().trim().min(3).max(255),
  purpose: z.enum(['register', 'login', 'reset_password', 'verify_email']),
});

const VERIFY_OTP_SCHEMA = z.object({
  target: z.string().trim().min(3).max(255),
  code: z.string().trim().length(6),
  purpose: z.enum(['register', 'login', 'reset_password', 'verify_email']),
});

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

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  return Number(value);
}

function safeDateISO(value) {
  return value ? new Date(value).toISOString() : null;
}

function buildOtpKey(target, purpose) {
  return `otp:${purpose}:${String(target).toLowerCase()}`;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

async function saveOtp(app, key, code) {
  const payload = {
    code_hash: hashOtp(code),
    attempts: 0,
    expires_at: Date.now() + OTP_TTL_SECONDS * 1000,
  };

  if (app.redis) {
    await app.redis.set(key, JSON.stringify(payload), 'EX', OTP_TTL_SECONDS);
    return payload;
  }

  otpStore.set(key, payload);
  return payload;
}

async function getOtp(app, key) {
  if (app.redis) {
    const raw = await app.redis.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  const payload = otpStore.get(key) || null;
  if (!payload) return null;
  if (payload.expires_at <= Date.now()) {
    otpStore.delete(key);
    return null;
  }
  return payload;
}

async function updateOtp(app, key, payload) {
  const ttlMs = Math.max(1000, payload.expires_at - Date.now());
  const ttlSec = Math.ceil(ttlMs / 1000);

  if (app.redis) {
    await app.redis.set(key, JSON.stringify(payload), 'EX', ttlSec);
    return;
  }

  otpStore.set(key, payload);
}

async function deleteOtp(app, key) {
  if (app.redis) {
    await app.redis.del(key);
    return;
  }
  otpStore.delete(key);
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    avatar_url: user.avatarUrl,
    bio: user.bio,
    status: user.status,
    email_verified: Boolean(user.emailVerified),
    phone_verified: Boolean(user.phoneVerified),
    score: toNumber(user.score),
    gem: user.gem,
    ntd_balance: toNumber(user.ntdBalance),
    is_pro: Boolean(user.isPro),
    pro_expires_at: safeDateISO(user.proExpiresAt),
    pro_notif_enabled: Boolean(user.proNotifEnabled),
    referral_code: user.referralCode || null,
    created_at: safeDateISO(user.createdAt),
    updated_at: safeDateISO(user.updatedAt),
    last_login_at: safeDateISO(user.lastLoginAt),
  };
}

async function getUserByEmail(app, email) {
  return app.prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
  });
}

async function findReferralUser(app, referralCode) {
  if (!referralCode) return null;

  const normalized = String(referralCode).trim();

  const user = await app.prisma.user.findFirst({
    where: {
      OR: [
        { referralCode: normalized },
        { username: normalized },
      ],
    },
  }).catch(() => null);

  return user || null;
}

async function issueTokens(app, user) {
  const refreshVersion = Number(user.refreshTokenVersion || 0);

  const access_token = app.jwt.sign(
    {
      sub: user.id,
      role: 'user',
      username: user.username,
      ver: refreshVersion,
    },
    { expiresIn: ACCESS_TTL }
  );

  const refresh_token = app.jwt.sign(
    {
      sub: user.id,
      type: 'refresh',
      ver: refreshVersion,
    },
    { expiresIn: REFRESH_TTL }
  );

  return { access_token, refresh_token };
}

async function appendWelcomeRewards(app, tx, userId) {
  await tx.notification.create({
    data: {
      userId,
      type: 'reward',
      icon: '🎁',
      title: '新手禮已發送',
      body: '歡迎加入 Predic，已發送 1,000 積分至你的帳戶。',
      isRead: false,
    },
  }).catch(() => null);
}

async function incrementRefreshTokenVersionIfSupported(app, userId) {
  try {
    await app.prisma.user.update({
      where: { id: userId },
      data: {
        refreshTokenVersion: { increment: 1 },
      },
    });
    return true;
  } catch (_err) {
    return false;
  }
}

module.exports = async function authRoutes(app) {
  // POST /v1/auth/register
  app.post('/register', async (req, reply) => {
    const parsed = REGISTER_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤。', parsed.error.flatten());
    }

    const { username, email, password, phone, referral_code } = parsed.data;
    const normalizedEmail = normalizeEmail(email);

    const duplicate = await app.prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { username },
        ],
      },
      select: {
        id: true,
        email: true,
        username: true,
      },
    });

    if (duplicate) {
      if (duplicate.email === normalizedEmail) {
        return sendError(reply, 409, 'EMAIL_EXISTS', '此 Email 已被使用。');
      }
      return sendError(reply, 409, 'USERNAME_TAKEN', '此用戶名稱已被使用。');
    }

    const referralUser = await findReferralUser(app, referral_code);
    const passwordHash = await bcrypt.hash(password, 12);
    const generatedReferralCode = username.toLowerCase();

    let user;

    try {
      user = await app.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username,
            email: normalizedEmail,
            phone: phone || null,
            passwordHash,
            score: BigInt(1000),
            ...(referralUser ? {
              referredByCode: referralUser.referralCode || referralUser.username,
            } : {}),
            referralCode: generatedReferralCode,
          },
        }).catch(async () => {
          // Fallback for old schema without referralCode/referredByCode.
          return tx.user.create({
            data: {
              username,
              email: normalizedEmail,
              phone: phone || null,
              passwordHash,
              score: BigInt(1000),
            },
          });
        });

        await appendWelcomeRewards(app, tx, created.id);

        if (referralUser) {
          await tx.referralReward.create({
            data: {
              referrerId: referralUser.id,
              refereeId: created.id,
              rewardScore: 200,
            },
          }).catch(() => null);

          await tx.user.update({
            where: { id: referralUser.id },
            data: {
              score: { increment: BigInt(200) },
            },
          }).catch(() => null);

          await tx.notification.create({
            data: {
              userId: referralUser.id,
              type: 'reward',
              icon: '🤝',
              title: '推薦獎勵已入帳',
              body: `${username} 完成註冊，你已獲得 200 積分。`,
              isRead: false,
            },
          }).catch(() => null);
        }

        return created;
      });
    } catch (error) {
      req.log.error(error);
      return sendError(reply, 500, 'REGISTER_FAILED', '註冊失敗，請稍後再試。');
    }

    const freshUser = await app.prisma.user.findUnique({ where: { id: user.id } });
    const tokens = await issueTokens(app, freshUser || user);

    return sendSuccess(
      reply,
      {
        user: sanitizeUser(freshUser || user),
        ...tokens,
      },
      {},
      201
    );
  });

  // POST /v1/auth/login
  app.post('/login', async (req, reply) => {
    const parsed = LOGIN_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤。', parsed.error.flatten());
    }

    const { email, password } = parsed.data;
    const user = await getUserByEmail(app, email);

    if (!user) {
      return sendError(reply, 401, 'UNAUTHORIZED', 'Email 或密碼錯誤。');
    }

    if (user.status && user.status !== 'active') {
      return sendError(reply, 403, 'ACCOUNT_DISABLED', '帳號目前無法登入，請聯繫客服。');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return sendError(reply, 401, 'UNAUTHORIZED', 'Email 或密碼錯誤。');
    }

    const updatedUser = await app.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await issueTokens(app, updatedUser);

    return sendSuccess(reply, {
      user: sanitizeUser(updatedUser),
      ...tokens,
    });
  });

  // POST /v1/auth/refresh
  app.post('/refresh', async (req, reply) => {
    const parsed = REFRESH_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '缺少 refresh_token。', parsed.error.flatten());
    }

    try {
      const payload = app.jwt.verify(parsed.data.refresh_token);

      if (payload.type !== 'refresh') {
        return sendError(reply, 401, 'TOKEN_INVALID', 'Refresh Token 無效。');
      }

      const user = await app.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) {
        return sendError(reply, 401, 'TOKEN_INVALID', 'Refresh Token 無效。');
      }

      if (user.status && user.status !== 'active') {
        return sendError(reply, 403, 'ACCOUNT_DISABLED', '帳號目前無法登入。');
      }

      const currentVersion = Number(user.refreshTokenVersion || 0);
      if (payload.ver !== undefined && currentVersion !== Number(payload.ver)) {
        return sendError(reply, 401, 'TOKEN_REVOKED', 'Refresh Token 已失效，請重新登入。');
      }

      const freshUser = await app.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const tokens = await issueTokens(app, freshUser);

      return sendSuccess(reply, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user: sanitizeUser(freshUser),
      });
    } catch (error) {
      req.log.warn({ err: error }, 'refresh token verify failed');
      return sendError(reply, 401, 'TOKEN_INVALID', 'Refresh Token 無效或已過期。');
    }
  });

  // POST /v1/auth/logout
  app.post('/logout', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = LOGOUT_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤。', parsed.error.flatten());
    }

    const userId = req.user.sub;
    const rotated = await incrementRefreshTokenVersionIfSupported(app, userId);

    return sendSuccess(reply, {
      logged_out: true,
      refresh_revoked: rotated,
    });
  });

  // POST /v1/auth/send-otp
  app.post('/send-otp', async (req, reply) => {
    const parsed = SEND_OTP_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤。', parsed.error.flatten());
    }

    const target = String(parsed.data.target).trim();
    const purpose = parsed.data.purpose;
    const key = buildOtpKey(target, purpose);
    const code = generateOtpCode();

    await saveOtp(app, key, code);
    req.log.info({ target, purpose }, `[OTP] generated for ${purpose}`);

    const data = {
      message: 'OTP 已發送。',
      expires_in_seconds: OTP_TTL_SECONDS,
    };

    if (DEV_EXPOSE_OTP) {
      data._dev_code = code;
    }

    return sendSuccess(reply, data);
  });

  // POST /v1/auth/verify-otp
  app.post('/verify-otp', async (req, reply) => {
    const parsed = VERIFY_OTP_SCHEMA.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤。', parsed.error.flatten());
    }

    const target = String(parsed.data.target).trim();
    const purpose = parsed.data.purpose;
    const code = parsed.data.code;
    const key = buildOtpKey(target, purpose);

    const stored = await getOtp(app, key);
    if (!stored) {
      return sendError(reply, 400, 'OTP_EXPIRED', 'OTP 已過期或不存在。');
    }

    if (stored.attempts >= OTP_MAX_ATTEMPTS) {
      await deleteOtp(app, key);
      return sendError(reply, 400, 'OTP_LOCKED', 'OTP 驗證次數過多，請重新發送。');
    }

    if (stored.code_hash !== hashOtp(code)) {
      stored.attempts += 1;
      await updateOtp(app, key, stored);
      return sendError(reply, 400, 'OTP_INVALID', 'OTP 錯誤。', {
        attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - stored.attempts),
      });
    }

    await deleteOtp(app, key);

    if (purpose === 'verify_email') {
      const normalizedEmail = normalizeEmail(target);
      await app.prisma.user.updateMany({
        where: { email: normalizedEmail },
        data: { emailVerified: true },
      }).catch(() => null);
    }

    return sendSuccess(reply, {
      verified: true,
      target,
      purpose,
    });
  });
};
