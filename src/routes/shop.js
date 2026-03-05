// src/routes/shop.js
'use strict';

const SHOP_ITEMS = [
  { id: 'prophet_eye',  name: '先知之眼',  icon: '👁',  price: 50,  currency: 'gem',  type: 'item' },
  { id: 'double_card',  name: '加倍卡',    icon: '×2',  price: 30,  currency: 'gem',  type: 'item' },
  { id: 'shield_card',  name: '保護盾',    icon: '🛡',  price: 20,  currency: 'gem',  type: 'item' },
  { id: 'score_500',    name: '500 積分',  icon: '🪙',  price: 49,  currency: 'ntd',  type: 'recharge', giveScore: 500 },
  { id: 'score_1200',   name: '1,200 積分',icon: '🪙',  price: 99,  currency: 'ntd',  type: 'recharge', giveScore: 1200 },
  { id: 'score_3000',   name: '3,000 積分',icon: '🪙',  price: 199, currency: 'ntd',  type: 'recharge', giveScore: 3000 },
  { id: 'gem_10',       name: '10 鑽石',   icon: '💎',  price: 500, currency: 'score',type: 'recharge', giveGem: 10 },
];

module.exports = async function (app) {

  // ── GET /v1/shop/items ─────────────────────────────
  app.get('/items', async (req, reply) => {
    const type = req.query.type;
    const items = type ? SHOP_ITEMS.filter(i => i.type === type) : SHOP_ITEMS;
    reply.send({ ok: true, data: items });
  });

  // ── POST /v1/shop/buy ──────────────────────────────
  app.post('/buy', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { item_id, currency, quantity = 1 } = req.body || {};
    const userId = req.user.sub;

    const item = SHOP_ITEMS.find(i => i.id === item_id);
    if (!item) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '找不到該商品' } });
    }

    const totalCost = item.price * quantity;

    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: '未登入' } });

    // Check balance
    if (currency === 'gem'   && user.gem < totalCost) {
      return reply.code(400).send({ ok: false, error: { code: 'INSUFFICIENT_BALANCE', message: '鑽石不足' } });
    }
    if (currency === 'score' && Number(user.score) < totalCost) {
      return reply.code(400).send({ ok: false, error: { code: 'INSUFFICIENT_BALANCE', message: '積分不足' } });
    }

    // Transaction: deduct + add inventory / balance
    await app.prisma.$transaction(async (tx) => {
      const update = {};
      if (currency === 'gem')   update.gem   = { decrement: totalCost };
      if (currency === 'score') update.score = { decrement: BigInt(totalCost) };
      if (currency === 'ntd')   update.ntdBalance = { decrement: totalCost };

      // Add rewards (recharge items)
      if (item.giveScore) update.score = { ...(update.score || {}), increment: BigInt(item.giveScore * quantity) };
      if (item.giveGem)   update.gem   = { ...(update.gem   || {}), increment: item.giveGem * quantity };

      await tx.user.update({ where: { id: userId }, data: update });

      // Add to inventory (for item type)
      if (item.type === 'item') {
        await tx.userInventory.upsert({
          where:  { userId_itemKey: { userId, itemKey: item.id } },
          create: { userId, itemKey: item.id, quantity },
          update: { quantity: { increment: quantity } },
        });
      }
    });

    // Notification
    await app.prisma.notification.create({
      data: {
        userId,
        type:  'reward',
        icon:  item.icon,
        title: '購買成功',
        body:  `已購買 ${item.name} × ${quantity}`,
      },
    });

    reply.send({ ok: true, data: { purchased: true, item: item.name, quantity } });
  });

  // ── POST /v1/shop/use-item ─────────────────────────
  app.post('/use-item', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { item_key, market_id } = req.body || {};
    const userId = req.user.sub;

    const inv = await app.prisma.userInventory.findUnique({
      where: { userId_itemKey: { userId, itemKey: item_key } },
    });

    if (!inv || inv.quantity < 1) {
      return reply.code(400).send({ ok: false, error: { code: 'INSUFFICIENT_BALANCE', message: '道具不足' } });
    }

    await app.prisma.userInventory.update({
      where: { userId_itemKey: { userId, itemKey: item_key } },
      data:  { quantity: { decrement: 1 } },
    });

    // Item-specific effects
    let effect = {};
    if (item_key === 'prophet_eye' && market_id) {
      const market = await app.prisma.market.findUnique({ where: { id: market_id } });
      effect = {
        market_id,
        hint: Number(market?.yesPct || 50) > 60 ? '社群傾向「是」' : '走勢較為平均',
      };
    }

    reply.send({ ok: true, data: { used: true, item_key, effect } });
  });
};
