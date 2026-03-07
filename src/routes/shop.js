// src/routes/shop.js
'use strict';

const { z } = require('zod');

const ITEM_KEYS = {
  PROPHET_EYE: 'prophet_eye',
  DOUBLE_CARD: 'double_card',
  SHIELD_CARD: 'shield_card',
  LOTTERY_TICKET: 'lottery_ticket',
};

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  return Number(value || 0);
}

function toPlainAmount(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value.toString === 'function') return value.toString();
  return String(value ?? '0');
}

function sendError(reply, statusCode, code, message, details = null) {
  return reply.code(statusCode).send({
    data: null,
    error: { code, message, details },
    meta: {},
  });
}

function sendSuccess(reply, data, meta = {}, statusCode = 200) {
  return reply.code(statusCode).send({
    data,
    error: null,
    meta,
  });
}

function buildInventoryMap(items) {
  const map = new Map();
  for (const item of items || []) {
    map.set(item.itemKey, item.quantity);
  }
  return map;
}

function normalizeShopItem(item, ownedQty = 0) {
  return {
    id: item.id,
    key: item.key,
    name: item.name,
    description: item.description,
    type: item.type,
    currency: item.currency,
    price: Number(item.price),
    reward_item_key: item.rewardItemKey,
    reward_quantity: item.rewardQuantity,
    reward_gem: item.rewardGem,
    reward_score: toNumber(item.rewardScore),
    reward_tickets: item.rewardTickets,
    is_active: item.isActive,
    sort_order: item.sortOrder,
    owned_quantity: ownedQty,
  };
}

function normalizePrize(prize) {
  return {
    id: prize.id,
    key: prize.key,
    name: prize.name,
    description: prize.description,
    rarity: prize.rarity,
    stock: prize.stock,
    weight: prize.weight,
    reward_type: prize.rewardType,
    reward_item_key: prize.rewardItemKey,
    reward_quantity: prize.rewardQuantity,
    reward_gem: prize.rewardGem,
    reward_score: toNumber(prize.rewardScore),
    reward_pro_days: prize.rewardProDays,
    is_active: prize.isActive,
    sort_order: prize.sortOrder,
  };
}

async function grantInventoryItem(tx, userId, itemKey, quantity) {
  if (!itemKey || quantity <= 0) return;

  await tx.userInventory.upsert({
    where: { userId_itemKey: { userId, itemKey } },
    create: { userId, itemKey, quantity },
    update: { quantity: { increment: quantity } },
  });
}

async function createRewardNotification(tx, userId, title, body, icon = '🎁') {
  await tx.notification.create({
    data: {
      userId,
      type: 'reward',
      icon,
      title,
      body,
    },
  });
}

module.exports = async function shopRoutes(app) {
  // ── GET /v1/shop/items ────────────────────────────
  // 支援 type=item|gem_pack|ticket_pack|pro_plan
  app.get('/items', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      type: z.string().optional(),
      active_only: z
        .union([z.literal('true'), z.literal('false')])
        .optional()
        .transform((v) => (v === undefined ? true : v === 'true')),
    });

    const parsed = schema.safeParse(req.query || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '查詢參數格式錯誤', parsed.error.flatten());
    }

    const { type, active_only } = parsed.data;
    const userId = req.user.sub;

    const [items, inventory] = await Promise.all([
      app.prisma.shopItem.findMany({
        where: {
          ...(type ? { type } : {}),
          ...(active_only ? { isActive: true } : {}),
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      app.prisma.userInventory.findMany({
        where: { userId },
        select: { itemKey: true, quantity: true },
      }),
    ]);

    const inventoryMap = buildInventoryMap(inventory);

    return sendSuccess(reply, {
      items: items.map((item) => normalizeShopItem(item, inventoryMap.get(item.rewardItemKey || item.key) || 0)),
    });
  });

  // ── GET /v1/shop/summary ──────────────────────────
  // 商城頁資產摘要：積分 / 鑽石 / 抽獎券 / 道具數量
  app.get('/summary', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        score: true,
        gem: true,
        ntdBalance: true,
        inventory: {
          select: {
            itemKey: true,
            quantity: true,
          },
        },
      },
    });

    if (!user) {
      return sendError(reply, 404, 'USER_NOT_FOUND', '找不到使用者');
    }

    const inventoryMap = buildInventoryMap(user.inventory);

    return sendSuccess(reply, {
      score: toNumber(user.score),
      gem: user.gem,
      ntd_balance: Number(user.ntdBalance),
      lottery_tickets: inventoryMap.get(ITEM_KEYS.LOTTERY_TICKET) || 0,
      inventory: user.inventory.map((item) => ({
        item_key: item.itemKey,
        quantity: item.quantity,
      })),
    });
  });

  // ── POST /v1/shop/buy ─────────────────────────────
  // 依商品資料表決定幣別與發獎，不信任前端傳 currency
  app.post('/buy', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      item_key: z.string().min(1).max(50),
      quantity: z.number().int().min(1).max(99).default(1),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤', parsed.error.flatten());
    }

    const { item_key, quantity } = parsed.data;
    const userId = req.user.sub;

    const [item, user] = await Promise.all([
      app.prisma.shopItem.findUnique({ where: { key: item_key } }),
      app.prisma.user.findUnique({ where: { id: userId } }),
    ]);

    if (!item || !item.isActive) {
      return sendError(reply, 404, 'SHOP_ITEM_NOT_FOUND', '找不到可購買的商品');
    }

    if (!user) {
      return sendError(reply, 401, 'UNAUTHORIZED', '未登入');
    }

    const unitPrice = Number(item.price);
    const totalCost = unitPrice * quantity;
    const currency = item.currency;

    if (currency === 'gem' && user.gem < totalCost) {
      return sendError(reply, 400, 'INSUFFICIENT_BALANCE', '鑽石不足');
    }
    if (currency === 'score' && toNumber(user.score) < totalCost) {
      return sendError(reply, 400, 'INSUFFICIENT_BALANCE', '積分不足');
    }
    if (currency === 'ntd' && Number(user.ntdBalance) < totalCost) {
      return sendError(reply, 400, 'INSUFFICIENT_BALANCE', '儲值餘額不足');
    }

    const result = await app.prisma.$transaction(async (tx) => {
      const userUpdateData = {};

      if (currency === 'gem') {
        userUpdateData.gem = { decrement: totalCost };
      }
      if (currency === 'score') {
        userUpdateData.score = { decrement: BigInt(totalCost) };
      }
      if (currency === 'ntd') {
        userUpdateData.ntdBalance = { decrement: totalCost };
      }

      if (item.rewardGem > 0) {
        userUpdateData.gem = {
          ...(userUpdateData.gem || {}),
          increment: item.rewardGem * quantity,
        };
      }

      if (toNumber(item.rewardScore) > 0) {
        userUpdateData.score = {
          ...(userUpdateData.score || {}),
          increment: BigInt(toNumber(item.rewardScore) * quantity),
        };
      }

      if (item.type === 'pro_plan' && item.rewardQuantity > 0) {
        const now = new Date();
        const currentBase = user.proExpiresAt && user.proExpiresAt > now ? user.proExpiresAt : now;
        const nextExpire = new Date(currentBase.getTime() + item.rewardQuantity * 24 * 60 * 60 * 1000);

        userUpdateData.isPro = true;
        userUpdateData.proExpiresAt = nextExpire;

        await tx.proSubscription.create({
          data: {
            userId,
            plan: item.key,
            priceNtd: item.price,
            startsAt: now,
            expiresAt: nextExpire,
            status: 'active',
          },
        });
      }

      if (Object.keys(userUpdateData).length > 0) {
        await tx.user.update({
          where: { id: userId },
          data: userUpdateData,
        });
      }

      if (item.rewardItemKey) {
        await grantInventoryItem(tx, userId, item.rewardItemKey, item.rewardQuantity * quantity);
      }

      if (item.rewardTickets > 0) {
        await grantInventoryItem(tx, userId, ITEM_KEYS.LOTTERY_TICKET, item.rewardTickets * quantity);
      }

      await createRewardNotification(
        tx,
        userId,
        '購買成功',
        `已購買 ${item.name} × ${quantity}`,
        item.type === 'pro_plan' ? '⭐' : '🛍️'
      );

      const freshUser = await tx.user.findUnique({
        where: { id: userId },
        select: {
          score: true,
          gem: true,
          ntdBalance: true,
          isPro: true,
          proExpiresAt: true,
          inventory: {
            where: {
              itemKey: {
                in: [item.rewardItemKey || '', ITEM_KEYS.LOTTERY_TICKET],
              },
            },
            select: {
              itemKey: true,
              quantity: true,
            },
          },
        },
      });

      return {
        item,
        user: freshUser,
      };
    });

    const inventoryMap = buildInventoryMap(result.user.inventory);

    return sendSuccess(reply, {
      purchased: true,
      item: normalizeShopItem(result.item, inventoryMap.get(result.item.rewardItemKey || result.item.key) || 0),
      quantity,
      balances: {
        score: toNumber(result.user.score),
        gem: result.user.gem,
        ntd_balance: Number(result.user.ntdBalance),
        lottery_tickets: inventoryMap.get(ITEM_KEYS.LOTTERY_TICKET) || 0,
        is_pro: result.user.isPro,
        pro_expires_at: result.user.proExpiresAt,
      },
    }, {}, 201);
  });

  // ── POST /v1/shop/use-item ────────────────────────
  // 使用型道具：目前支援 prophet_eye / double_card / shield_card
  app.post('/use-item', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      item_key: z.string().min(1).max(50),
      market_id: z.string().uuid().optional(),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤', parsed.error.flatten());
    }

    const { item_key, market_id } = parsed.data;
    const userId = req.user.sub;

    const inventory = await app.prisma.userInventory.findUnique({
      where: { userId_itemKey: { userId, itemKey: item_key } },
    });

    if (!inventory || inventory.quantity < 1) {
      return sendError(reply, 400, 'INSUFFICIENT_INVENTORY', '道具不足');
    }

    let effect = {};

    if ([ITEM_KEYS.PROPHET_EYE, ITEM_KEYS.DOUBLE_CARD, ITEM_KEYS.SHIELD_CARD].includes(item_key) && !market_id) {
      return sendError(reply, 400, 'MARKET_ID_REQUIRED', '此道具需要指定市場');
    }

    if (market_id) {
      const market = await app.prisma.market.findUnique({
        where: { id: market_id },
        select: {
          id: true,
          question: true,
          yesPct: true,
          status: true,
        },
      });

      if (!market) {
        return sendError(reply, 404, 'MARKET_NOT_FOUND', '找不到指定市場');
      }

      if (market.status && !['open', 'active'].includes(market.status)) {
        return sendError(reply, 400, 'MARKET_NOT_OPEN', '此市場目前不可使用道具');
      }

      if (item_key === ITEM_KEYS.PROPHET_EYE) {
        const yesPct = Number(market.yesPct);
        effect = {
          market_id,
          market_question: market.question,
          hint: yesPct >= 60 ? '社群傾向「是」' : yesPct <= 40 ? '社群傾向「否」' : '目前走勢接近平衡',
          yes_pct_snapshot: yesPct,
        };
      }

      if (item_key === ITEM_KEYS.DOUBLE_CARD) {
        effect = {
          market_id,
          market_question: market.question,
          effect_type: 'trade_boost',
          description: '下一次在此市場成功結算時，可用於加成獎勵倍率。',
        };
      }

      if (item_key === ITEM_KEYS.SHIELD_CARD) {
        effect = {
          market_id,
          market_question: market.question,
          effect_type: 'loss_protection',
          description: '下一次在此市場失敗時，可用於降低損失。',
        };
      }
    }

    const updated = await app.prisma.$transaction(async (tx) => {
      const nextInventory = await tx.userInventory.update({
        where: { userId_itemKey: { userId, itemKey: item_key } },
        data: { quantity: { decrement: 1 } },
      });

      await createRewardNotification(
        tx,
        userId,
        '已使用道具',
        `你已使用 ${item_key}${market_id ? ' 於指定市場' : ''}`,
        '✨'
      );

      return nextInventory;
    });

    return sendSuccess(reply, {
      used: true,
      item_key,
      remaining_quantity: updated.quantity,
      effect,
    });
  });

  // ── POST /v1/shop/tickets/exchange ────────────────
  // 200 積分兌換 1 張抽獎券
  app.post('/tickets/exchange', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      quantity: z.number().int().min(1).max(50).default(1),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤', parsed.error.flatten());
    }

    const { quantity } = parsed.data;
    const userId = req.user.sub;
    const scoreCostPerTicket = 200;
    const totalCost = scoreCostPerTicket * quantity;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { score: true },
    });

    if (!user) {
      return sendError(reply, 404, 'USER_NOT_FOUND', '找不到使用者');
    }

    if (toNumber(user.score) < totalCost) {
      return sendError(reply, 400, 'INSUFFICIENT_BALANCE', '積分不足，無法兌換抽獎券');
    }

    const result = await app.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          score: { decrement: BigInt(totalCost) },
        },
      });

      await grantInventoryItem(tx, userId, ITEM_KEYS.LOTTERY_TICKET, quantity);

      await createRewardNotification(
        tx,
        userId,
        '已兌換抽獎券',
        `成功使用 ${totalCost} 積分兌換 ${quantity} 張抽獎券`,
        '🎟️'
      );

      const refreshed = await tx.user.findUnique({
        where: { id: userId },
        select: {
          score: true,
          inventory: {
            where: { itemKey: ITEM_KEYS.LOTTERY_TICKET },
            select: { itemKey: true, quantity: true },
          },
        },
      });

      return refreshed;
    });

    const tickets = result.inventory[0]?.quantity || 0;

    return sendSuccess(reply, {
      exchanged: true,
      quantity,
      score_cost: totalCost,
      balances: {
        score: toNumber(result.score),
        lottery_tickets: tickets,
      },
    });
  });

  // ── GET /v1/shop/lottery/prizes ───────────────────
  app.get('/lottery/prizes', { preHandler: [app.authenticate] }, async (_req, reply) => {
    const prizes = await app.prisma.lotteryPrize.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { rarity: 'asc' }, { createdAt: 'asc' }],
    });

    return sendSuccess(reply, {
      prizes: prizes.map(normalizePrize),
    });
  });

  // ── POST /v1/shop/lottery/draw ────────────────────
  app.post('/lottery/draw', { preHandler: [app.authenticate] }, async (req, reply) => {
    const schema = z.object({
      quantity: z.number().int().min(1).max(10).default(1),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '請求參數格式錯誤', parsed.error.flatten());
    }

    const { quantity } = parsed.data;
    const userId = req.user.sub;

    const ticketInventory = await app.prisma.userInventory.findUnique({
      where: { userId_itemKey: { userId, itemKey: ITEM_KEYS.LOTTERY_TICKET } },
    });

    if (!ticketInventory || ticketInventory.quantity < quantity) {
      return sendError(reply, 400, 'INSUFFICIENT_TICKETS', '抽獎券不足');
    }

    const prizes = await app.prisma.lotteryPrize.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    if (!prizes.length) {
      return sendError(reply, 404, 'LOTTERY_NOT_AVAILABLE', '目前沒有可抽獎的項目');
    }

    const availablePrizes = prizes.filter((prize) => prize.stock === null || prize.stock > 0);
    if (!availablePrizes.length) {
      return sendError(reply, 409, 'LOTTERY_OUT_OF_STOCK', '目前抽獎獎池已無可用獎項');
    }

    const weightedPool = [];
    for (const prize of availablePrizes) {
      const weight = Math.max(1, prize.weight || 1);
      for (let i = 0; i < weight; i += 1) weightedPool.push(prize);
    }

    const drawResults = [];

    const result = await app.prisma.$transaction(async (tx) => {
      await tx.userInventory.update({
        where: { userId_itemKey: { userId, itemKey: ITEM_KEYS.LOTTERY_TICKET } },
        data: { quantity: { decrement: quantity } },
      });

      for (let i = 0; i < quantity; i += 1) {
        const prize = weightedPool[Math.floor(Math.random() * weightedPool.length)];

        if (!prize) {
          throw new Error('Lottery draw failed: no prize available.');
        }

        if (prize.stock !== null) {
          await tx.lotteryPrize.update({
            where: { id: prize.id },
            data: { stock: { decrement: 1 } },
          });
        }

        if (prize.rewardItemKey) {
          await grantInventoryItem(tx, userId, prize.rewardItemKey, prize.rewardQuantity);
        }

        const rewardUserUpdate = {};
        if (prize.rewardGem > 0) {
          rewardUserUpdate.gem = { increment: prize.rewardGem };
        }
        if (toNumber(prize.rewardScore) > 0) {
          rewardUserUpdate.score = { increment: BigInt(toNumber(prize.rewardScore)) };
        }
        if (prize.rewardProDays > 0) {
          const currentUser = await tx.user.findUnique({
            where: { id: userId },
            select: { isPro: true, proExpiresAt: true },
          });
          const now = new Date();
          const base = currentUser?.proExpiresAt && currentUser.proExpiresAt > now ? currentUser.proExpiresAt : now;
          rewardUserUpdate.isPro = true;
          rewardUserUpdate.proExpiresAt = new Date(base.getTime() + prize.rewardProDays * 24 * 60 * 60 * 1000);
        }

        if (Object.keys(rewardUserUpdate).length > 0) {
          await tx.user.update({
            where: { id: userId },
            data: rewardUserUpdate,
          });
        }

        await tx.lotteryDrawLog.create({
          data: {
            userId,
            prizeId: prize.id,
            ticketCost: 1,
          },
        });

        await createRewardNotification(
          tx,
          userId,
          '抽獎獲得獎勵',
          `恭喜抽中 ${prize.name}`,
          '🎉'
        );

        drawResults.push(normalizePrize(prize));
      }

      const refreshedUser = await tx.user.findUnique({
        where: { id: userId },
        select: {
          score: true,
          gem: true,
          ntdBalance: true,
          isPro: true,
          proExpiresAt: true,
          inventory: {
            where: {
              itemKey: {
                in: [ITEM_KEYS.LOTTERY_TICKET, ITEM_KEYS.PROPHET_EYE, ITEM_KEYS.DOUBLE_CARD, ITEM_KEYS.SHIELD_CARD],
              },
            },
            select: { itemKey: true, quantity: true },
          },
        },
      });

      return refreshedUser;
    });

    const inventoryMap = buildInventoryMap(result.inventory);

    return sendSuccess(reply, {
      drawn: true,
      quantity,
      results: drawResults,
      balances: {
        score: toNumber(result.score),
        gem: result.gem,
        ntd_balance: Number(result.ntdBalance),
        lottery_tickets: inventoryMap.get(ITEM_KEYS.LOTTERY_TICKET) || 0,
        is_pro: result.isPro,
        pro_expires_at: result.proExpiresAt,
      },
      inventory: result.inventory.map((item) => ({
        item_key: item.itemKey,
        quantity: item.quantity,
      })),
    });
  });

  // ── GET /v1/shop/lottery/logs ─────────────────────
  app.get('/lottery/logs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const userId = req.user.sub;

    const logs = await app.prisma.lotteryDrawLog.findMany({
      where: { userId },
      take: limit,
      orderBy: { drawnAt: 'desc' },
      include: {
        prize: true,
      },
    });

    return sendSuccess(reply, {
      logs: logs.map((log) => ({
        id: log.id,
        ticket_cost: log.ticketCost,
        drawn_at: log.drawnAt,
        prize: normalizePrize(log.prize),
      })),
    });
  });
};
