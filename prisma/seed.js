// prisma/seed.js
'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const passwordHash = await bcrypt.hash('Demo1234!', 12);
  const demo = await prisma.user.upsert({
    where: { email: 'demo@predic.tw' },
    update: {},
    create: {
      username: 'Predic示範',
      email: 'demo@predic.tw',
      passwordHash,
      score: 15997n,
      gem: 150,
      ntdBalance: 12450,
      refreshTokenVersion: 0,
      referralCode: 'PREDICDEMO'
    }
  });
  console.log('Demo user:', demo.email);

  const markets = [
    {
      slug: 'tw-election-2026-dpp-10seats',
      category: 'politics',
      icon: '🏛',
      tag: 'Politics',
      question: '2026年台灣縣市長選舉，民進黨能否拿下超過10席？',
      description: '根據中選會正式結果判定。',
      yesPct: 64,
      status: 'open',
      isHot: true,
      isSponsored: false,
      volumeScore: 2400000n,
      participantCount: 2140,
      sortScore: 2400000,
      endsAt: new Date('2026-11-15'),
    },
    {
      slug: 'tsmc-1200-2026',
      category: 'finance',
      icon: '📈',
      tag: 'Finance',
      question: '台積電(TSMC)股價在2026年底前是否突破NT$1,200？',
      description: '以台灣證交所收盤價為準。',
      yesPct: 71,
      status: 'open',
      isHot: true,
      isSponsored: true,
      sponsorName: '某券商',
      volumeScore: 5100000n,
      participantCount: 3241,
      sortScore: 5100000,
      endsAt: new Date('2026-12-31'),
    },
    {
      slug: 'taiwan-football-asia-cup',
      category: 'sports',
      icon: '⚽',
      tag: 'Sports',
      question: '中華台北男足能否在本屆亞洲盃資格賽晉級？',
      description: '以官方資格賽結果判定。',
      yesPct: 43,
      status: 'open',
      isHot: false,
      volumeScore: 880000n,
      participantCount: 820,
      sortScore: 880000,
      endsAt: new Date('2026-09-10'),
    },
    {
      slug: 'taiwan-singer-grammy-2027',
      category: 'entertainment',
      icon: '🎬',
      tag: 'Entertainment',
      question: '台灣歌手是否在2027年葛萊美獎獲得提名？',
      description: '以葛萊美官方入圍名單為準。',
      yesPct: 28,
      status: 'open',
      isHot: false,
      volumeScore: 330000n,
      participantCount: 490,
      sortScore: 330000,
      endsAt: new Date('2027-02-01'),
    },
    {
      slug: 'openai-gpt5-2026',
      category: 'tech',
      icon: '💻',
      tag: 'Tech',
      question: 'OpenAI 是否在2026年發布 GPT-5 正式版？',
      description: '以 OpenAI 官方公告為準。',
      yesPct: 82,
      status: 'open',
      isHot: true,
      volumeScore: 3700000n,
      participantCount: 2890,
      sortScore: 3700000,
      endsAt: new Date('2026-12-31'),
    },
    {
      slug: 'tw-gdp-2025-above-3pct',
      category: 'society',
      icon: '🌏',
      tag: 'Society',
      question: '台灣2025年GDP成長率是否超過3%？',
      description: '以主計總處公布數據為準。',
      yesPct: 55,
      status: 'open',
      isHot: false,
      isSponsored: true,
      volumeScore: 1200000n,
      participantCount: 1100,
      sortScore: 1200000,
      endsAt: new Date('2026-06-30'),
    }
  ];

  for (const m of markets) {
    await prisma.market.upsert({
      where: { slug: m.slug },
      update: {
        yesPct: m.yesPct,
        volumeScore: m.volumeScore,
        participantCount: m.participantCount,
        sortScore: m.sortScore,
        tag: m.tag,
        status: m.status
      },
      create: m
    });
  }
  console.log('Markets seeded:', markets.length);

  for (const m of markets) {
    const market = await prisma.market.findUnique({ where: { slug: m.slug } });
    if (!market) continue;

    const existing = await prisma.probabilityLog.count({
      where: { marketId: market.id }
    });
    if (existing > 0) continue;

    const points = [];
    let v = Math.max(10, Math.min(90, Number(m.yesPct) + (Math.random() - 0.5) * 20));
    const now = new Date();

    for (let i = 30; i >= 0; i--) {
      const drift = (Number(m.yesPct) - v) * 0.1 + (Math.random() - 0.48) * 3;
      v = Math.max(5, Math.min(95, v + drift));
      points.push({
        marketId: market.id,
        yesPct: i === 0 ? Number(m.yesPct) : parseFloat(v.toFixed(1)),
        recordedAt: new Date(now.getTime() - i * 86400000)
      });
    }

    await prisma.probabilityLog.createMany({ data: points });
  }
  console.log('Probability history seeded');

  const shopItems = [
    {
      key: 'prophet_eye',
      name: '先知之眼',
      description: '查看市場額外提示資訊',
      type: 'item',
      currency: 'score',
      price: 300,
      rewardItemKey: 'prophet_eye',
      rewardQuantity: 1,
      isActive: true,
      sortOrder: 1
    },
    {
      key: 'double_card',
      name: '雙倍卡',
      description: '提升任務或活動獎勵倍率',
      type: 'item',
      currency: 'gem',
      price: 15,
      rewardItemKey: 'double_card',
      rewardQuantity: 1,
      isActive: true,
      sortOrder: 2
    },
    {
      key: 'shield_card',
      name: '防護卡',
      description: '可用於特定活動保護',
      type: 'item',
      currency: 'score',
      price: 500,
      rewardItemKey: 'shield_card',
      rewardQuantity: 1,
      isActive: true,
      sortOrder: 3
    },
    {
      key: 'lottery_ticket_pack_1',
      name: '抽獎券 x1',
      description: '可直接獲得 1 張抽獎券',
      type: 'ticket_pack',
      currency: 'score',
      price: 200,
      rewardItemKey: 'lottery_ticket',
      rewardQuantity: 1,
      rewardTickets: 1,
      isActive: true,
      sortOrder: 10
    },
    {
      key: 'gem_pack_small',
      name: '鑽石小包',
      description: '獲得 50 顆鑽石',
      type: 'gem_pack',
      currency: 'ntd',
      price: 90,
      rewardGem: 50,
      isActive: true,
      sortOrder: 20
    },
    {
      key: 'pro_monthly',
      name: 'PRO 月方案',
      description: '開通 30 天 PRO 會員',
      type: 'pro_plan',
      currency: 'ntd',
      price: 199,
      isActive: true,
      sortOrder: 30
    }
  ];

  for (const item of shopItems) {
    await prisma.shopItem.upsert({
      where: { key: item.key },
      update: item,
      create: item
    });
  }
  console.log('Shop items seeded:', shopItems.length);

  const lotteryPrizes = [
    {
      key: 'lottery_score_100',
      name: '100 積分',
      description: '獲得 100 積分',
      rarity: 'common',
      weight: 40,
      rewardType: 'score',
      rewardScore: 100n,
      isActive: true,
      sortOrder: 1
    },
    {
      key: 'lottery_gem_10',
      name: '10 鑽石',
      description: '獲得 10 顆鑽石',
      rarity: 'uncommon',
      weight: 25,
      rewardType: 'gem',
      rewardGem: 10,
      isActive: true,
      sortOrder: 2
    },
    {
      key: 'lottery_prophet_eye',
      name: '先知之眼 x1',
      description: '獲得 1 個先知之眼',
      rarity: 'rare',
      weight: 15,
      rewardType: 'item',
      rewardItemKey: 'prophet_eye',
      rewardQuantity: 1,
      isActive: true,
      sortOrder: 3
    },
    {
      key: 'lottery_coupon_100',
      name: 'NT$100 優惠券',
      description: '獲得 NT$100 優惠券獎勵',
      rarity: 'epic',
      weight: 8,
      rewardType: 'coupon',
      rewardQuantity: 1,
      isActive: true,
      sortOrder: 4
    },
    {
      key: 'lottery_pro_7d',
      name: 'PRO 7 天體驗',
      description: '獲得 7 天 PRO 體驗',
      rarity: 'legendary',
      weight: 2,
      rewardType: 'pro_days',
      rewardProDays: 7,
      isActive: true,
      sortOrder: 5
    }
  ];

  for (const prize of lotteryPrizes) {
    await prisma.lotteryPrize.upsert({
      where: { key: prize.key },
      update: prize,
      create: prize
    });
  }
  console.log('Lottery prizes seeded:', lotteryPrizes.length);

  const demoInventory = [
    { itemKey: 'prophet_eye', quantity: 2 },
    { itemKey: 'double_card', quantity: 1 },
    { itemKey: 'lottery_ticket', quantity: 3 }
  ];

  for (const inv of demoInventory) {
    await prisma.userInventory.upsert({
      where: {
        userId_itemKey: {
          userId: demo.id,
          itemKey: inv.itemKey
        }
      },
      update: { quantity: inv.quantity },
      create: {
        userId: demo.id,
        itemKey: inv.itemKey,
        quantity: inv.quantity
      }
    });
  }
  console.log('Demo inventory seeded');

  const notifCount = await prisma.notification.count({
    where: { userId: demo.id }
  });

  if (notifCount === 0) {
    await prisma.notification.createMany({
      data: [
        {
          userId: demo.id,
          type: 'result',
          icon: '✅',
          title: '開獎：台積電Q3營收創新高',
          body: '你預測「是」，恭喜獲勝！獲得 +420 積分。'
        },
        {
          userId: demo.id,
          type: 'reward',
          icon: '🎰',
          title: '抽獎結果通知',
          body: '恭喜！你抽到 NT$100 優惠券。'
        },
        {
          userId: demo.id,
          type: 'system',
          icon: '🏆',
          title: '排名提升！你現在排名 #12',
          body: '連續 7 場全勝，已解鎖「先知大師」稱號！'
        },
        {
          userId: demo.id,
          type: 'promo',
          icon: '⚡',
          title: 'PRO 專屬：本週熱門市場分析',
          body: 'GPT-5 市場：機率從 74% 上升至 82%，趨勢明顯看漲。'
        }
      ]
    });
  }

  console.log('Seed complete!');
  console.log('Demo 帳號: demo@predic.tw');
  console.log('Demo 密碼: Demo1234!');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
