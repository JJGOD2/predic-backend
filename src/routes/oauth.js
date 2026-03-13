'use strict';

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// OAuth Config - 使用環境變數，部署時在 Zeabur 設定
const OAUTH = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://predic-frontend.zeabur.app/auth/callback/google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo'
  },
  line: {
    channelId: process.env.LINE_CHANNEL_ID,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    redirectUri: process.env.LINE_REDIRECT_URI || 'https://predic-frontend.zeabur.app/auth/callback/line',
    authUrl: 'https://access.line.me/oauth2/v2.1/authorize',
    tokenUrl: 'https://api.line.me/oauth2/v2.1/token',
    userInfoUrl: 'https://api.line.me/v2/profile'
  }
};

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';

// Generate OAuth authorization URL
function generateOAuthUrl(provider) {
  const config = OAUTH[provider];
  if (!config) throw new Error('Invalid provider');
  if (!config.clientId || !config.channelId) {
    throw new Error('OAuth not configured. Please set environment variables.');
  }

  const state = crypto.randomBytes(32).toString('hex');
  
  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'consent'
    });
    return { url: `${config.authUrl}?${params}`, state };
  }
  
  if (provider === 'line') {
    const params = new URLSearchParams({
      client_id: config.channelId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state,
      bot_prompt: 'normal'
    });
    return { url: `${config.authUrl}?${params}`, state };
  }
}

// Exchange code for tokens
async function exchangeOAuthCode(provider, code) {
  const config = OAUTH[provider];
  if (!config) throw new Error('Invalid provider');

  const params = new URLSearchParams();
  
  if (provider === 'google') {
    params.set('client_id', config.clientId);
    params.set('client_secret', config.clientSecret);
    params.set('code', code);
    params.set('grant_type', 'authorization_code');
    params.set('redirect_uri', config.redirectUri);
  }
  
  if (provider === 'line') {
    params.set('client_id', config.channelId);
    params.set('client_secret', config.channelSecret);
    params.set('code', code);
    params.set('grant_type', 'authorization_code');
    params.set('redirect_uri', config.redirectUri);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  return response.json();
}

// Get user info from OAuth provider
async function getOAuthUserInfo(provider, accessToken) {
  const config = OAUTH[provider];
  
  if (provider === 'google') {
    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    return {
      email: data.email,
      name: data.name,
      picture: data.picture,
      providerId: data.id
    };
  }
  
  if (provider === 'line') {
    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    return {
      email: null,
      name: data.displayName,
      picture: data.pictureUrl,
      providerId: data.userId
    };
  }
}

// Find or create OAuth user
async function findOrCreateOAuthUser(provider, providerId, email, name, picture) {
  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [
        { googleId: provider === 'google' ? providerId : null },
        { lineId: provider === 'line' ? providerId : null }
      ]
    }
  });

  if (existingUser) {
    return prisma.user.update({
      where: { id: existingUser.id },
      data: {
        ...(picture && { avatarUrl: picture }),
        ...(name && { username: name })
      }
    });
  }

  if (email) {
    const userWithEmail = await prisma.user.findUnique({
      where: { email }
    });

    if (userWithEmail) {
      return prisma.user.update({
        where: { id: userWithEmail.id },
        data: {
          googleId: provider === 'google' ? providerId : userWithEmail.googleId,
          lineId: provider === 'line' ? providerId : userWithEmail.lineId
        }
      });
    }
  }

  const username = `${provider}_${providerId.substring(0, 8)}_${Date.now()}`;
  
  return prisma.user.create({
    data: {
      username,
      email: email || `${provider}_${providerId}@predic.local`,
      passwordHash: crypto.randomBytes(32).toString('hex'),
      avatarUrl: picture || null,
      googleId: provider === 'google' ? providerId : null,
      lineId: provider === 'line' ? providerId : null,
      score: BigInt(100),
      gem: 10
    }
  });
}

module.exports = async function oauthRoutes(app) {

  // Generate OAuth URL
  app.post('/v1/auth/oauth/:provider', async (req, reply) => {
    try {
      const { provider } = req.params;
      if (!['google', 'line'].includes(provider)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_PROVIDER', message: 'Invalid OAuth provider' }
        });
      }

      const { url, state } = generateOAuthUrl(provider);
      
      if (!app.oauthStates) app.oauthStates = new Map();
      app.oauthStates.set(`oauth_state_${provider}_${state}`, {
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      return reply.send({ ok: true, data: { url, state } });
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({
        ok: false,
        error: { code: 'OAUTH_ERROR', message: err.message }
      });
    }
  });

  // OAuth Callback
  app.post('/v1/auth/oauth/callback', async (req, reply) => {
    try {
      const { provider, code, state } = req.body;

      if (!['google', 'line'].includes(provider)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_PROVIDER', message: 'Invalid OAuth provider' }
        });
      }

      const storedState = app.oauthStates?.get(`oauth_state_${provider}_${state}`);
      
      if (!storedState) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_STATE', message: 'Invalid OAuth state' }
        });
      }

      if (Date.now() > storedState.expiresAt) {
        app.oauthStates.delete(`oauth_state_${provider}_${state}`);
        return reply.code(400).send({
          ok: false,
          error: { code: 'STATE_EXPIRED', message: 'OAuth state expired' }
        });
      }

      app.oauthStates.delete(`oauth_state_${provider}_${state}`);

      const tokens = await exchangeOAuthCode(provider, code);
      
      if (tokens.error) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'TOKEN_ERROR', message: tokens.error_description || 'Failed to get tokens' }
        });
      }

      const userInfo = await getOAuthUserInfo(provider, tokens.access_token);

      const user = await findOrCreateOAuthUser(
        provider,
        userInfo.providerId,
        userInfo.email,
        userInfo.name,
        userInfo.picture
      );

      const accessToken = app.jwt.sign({
        userId: user.id,
        email: user.email
      }, { expiresIn: ACCESS_TTL });

      const refreshToken = crypto.randomBytes(64).toString('hex');

      await prisma.refreshToken.create({
        data: {
          token: refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        }
      });

      return reply.send({
        ok: true,
        data: {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatarUrl,
            score: Number(user.score),
            gem: user.gem,
            googleId: !!user.googleId,
            lineId: !!user.lineId,
            boundInstagram: !!user.boundInstagram,
            boundThreads: !!user.boundThreads
          }
        }
      });
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({
        ok: false,
        error: { code: 'OAUTH_CALLBACK_ERROR', message: err.message }
      });
    }
  });

  // Bind Social Media Account
  app.post('/v1/auth/bind-social', async (req, reply) => {
    try {
      await req.jwtVerify();
      const { platform, platformId, username } = req.body;
      
      if (!['instagram', 'threads'].includes(platform)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_PLATFORM', message: 'Invalid platform' }
        });
      }

      const userId = req.user.userId;

      const existingBinding = await prisma.user.findFirst({
        where: platform === 'instagram' 
          ? { boundInstagram: platformId, NOT: { id: userId } }
          : { boundThreads: platformId, NOT: { id: userId } }
      });

      if (existingBinding) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'ALREADY_BOUND', message: 'This account is already bound to another user' }
        });
      }

      const updateData = platform === 'instagram' 
        ? { boundInstagram: platformId, boundInstagramUsername: username }
        : { boundThreads: platformId, boundThreadsUsername: username };

      const user = await prisma.user.update({
        where: { id: userId },
        data: updateData
      });

      return reply.send({
        ok: true,
        data: {
          boundInstagram: !!user.boundInstagram,
          boundThreads: !!user.boundThreads
        }
      });
    } catch (err) {
      app.log.error(err);
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' }
      });
    }
  });

  // Check social binding status
  app.get('/v1/auth/social-status', async (req, reply) => {
    try {
      await req.jwtVerify();
      
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
          boundInstagram: true,
          boundThreads: true,
          isPro: true
        }
      });

      return reply.send({
        ok: true,
        data: {
          canPropose: !!(user.boundInstagram || user.boundThreads || user.isPro),
          canPredict: true,
          boundInstagram: !!user.boundInstagram,
          boundThreads: !!user.boundThreads
        }
      });
    } catch (err) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' }
      });
    }
  });
};
