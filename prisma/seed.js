// prisma/seed.js
'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ── Demo user ─────────────────────────────────────
  const passwordHash = await bcrypt.hash('Demo1234!', 12);
  const demo = await prisma.user.upsert({
    where:  { email: 'demo@predic.tw' },
    update: {},
    create: {
      username:     'Predic示範',
      email:        'demo@predic.tw',
      passwordHash,
      score:        15997n,
      gem:          150,
      ntdBalance:   12450,
    },
  });
  console.log('✅ Demo user:', demo.email);

  // ── Markets ───────────────────────────────────────
  const markets = [
    {
      slug: 'tw-election-2026-dpp-10seats',
      category: 'politics', icon: '🏛',
      question: '2026年台灣縣市長選舉，民進黨能否拿下超過10席？',
      yesPct: 64, isHot: true, isSponsored: false,
      volumeScore: 2400000n, participantCount: 2140,
      endsAt: new Date('2026-11-15'),
    },
    {
      slug: 'tsmc-1200-2026',
      category: 'finance', icon: '📈',
      question: '台積電(TSMC)股價在2026年底前是否突破NT$1,200？',
      yesPct: 71, isHot: true, isSponsored: true, sponsorName: '某券商',
      volumeScore: 5100000n, participantCount: 3241,
      endsAt: new Date('2026-12-31'),
    },
    {
      slug: 'taiwan-football-asia-cup',
      category: 'sports', icon: '⚽',
      question: '中華台北男足能否在本屆亞洲盃資格賽晉級？',
      yesPct: 43, isHot: false,
      volumeScore: 880000n, participantCount: 820,
      endsAt: new Date('2026-09-10'),
    },
    {
      slug: 'taiwan-singer-grammy-2027',
      category: 'entertainment', icon: '🎬',
      question: '台灣歌手是否在2027年葛萊美獎獲得提名？',
      yesPct: 28, isHot: false,
      volumeScore: 330000n, participantCount: 490,
      endsAt: new Date('2027-02-01'),
    },
    {
      slug: 'openai-gpt5-2026',
      category: 'tech', icon: '💻',
      question: 'OpenAI 是否在2026年發布 GPT-5 正式版？',
      yesPct: 82, isHot: true,
      volumeScore: 3700000n, participantCount: 2890,
      endsAt: new Date('2026-12-31'),
    },
    {
      slug: 'tw-gdp-2025-above-3pct',
      category: 'society', icon: '🌏',
      question: '台灣2025年GDP成長率是否超過3%？',
      yesPct: 55, isHot: false, isSponsored: true,
      volumeScore: 1200000n, participantCount: 1100,
      endsAt: new Date('2026-06-30'),
    },
    {
      slug: 'tw-digital-intermediary-law-2026',
      category: 'politics', icon: '🏛',
      question: '立法院是否在2026年通過《數位中介服務法》？',
      yesPct: 37, isHot: false,
      volumeScore: 960000n, participantCount: 870,
      endsAt: new Date('2026-06-30'),
    },
    {
      slug: 'bitcoin-150k-2026-q2',
      category: 'finance', icon: '📈',
      question: '比特幣在2026年Q2前是否突破US$150,000？',
      yesPct: 61, isHot: true,
      volumeScore: 4200000n, participantCount: 3100,
      endsAt: new Date('2026-06-30'),
    },
    {
      slug: 'tw-baseball-wbc-top8',
      category: 'sports', icon: '⚾',
      question: '台灣棒球隊是否在2026世界棒球經典賽進入八強？',
      yesPct: 58, isHot: true,
      volumeScore: 1500000n, participantCount: 1420,
      endsAt: new Date('2026-03-20'),
    },
    {
      slug: 'apple-ar-glasses-wwdc-2026',
      category: 'tech', icon: '💻',
      question: 'Apple 是否在 WWDC 2026 發表 AR 眼鏡正式版？',
      yesPct: 47, isHot: false,
      volumeScore: 2100000n, participantCount: 1800,
      endsAt: new Date('2026-06-15'),
    },
    {
      slug: 'tw-film-cannes-2026',
      category: 'entertainment', icon: '🎬',
      question: '台灣電影是否在2026坎城影展獲得任何獎項？',
      yesPct: 34, isHot: false,
      volumeScore: 210000n, participantCount: 320,
      endsAt: new Date('2026-05-25'),
    },
    {
      slug: 'tw-birth-rate-rise-2026',
      category: 'society', icon: '🌏',
      question: '台灣2026年生育率是否止跌回升？',
      yesPct: 22, isHot: false,
      volumeScore: 440000n, participantCount: 560,
      endsAt: new Date('2027-03-01'),
    },
  ];

  for (const m of markets) {
    await prisma.market.upsert({
      where:  { slug: m.slug },
      update: { yesPct: m.yesPct, volumeScore: m.volumeScore, participantCount: m.participantCount },
      create: m,
    });
  }
  console.log(`✅ ${markets.length} markets seeded`);

  // ── Seed probability history for each market ──────
  for (const m of markets) {
    const market = await prisma.market.findUnique({ where: { slug: m.slug } });
    if (!market) continue;

    // Check if already has history
    const existing = await prisma.probabilityLog.count({ where: { marketId: market.id } });
    if (existing > 0) continue;

    // Generate 30 days of history
    const points = [];
    let v = Math.max(10, Math.min(90, Number(m.yesPct) + (Math.random() - 0.5) * 20));
    const now = new Date();
    for (let i = 30; i >= 0; i--) {
      const drift = (Number(m.yesPct) - v) * 0.1 + (Math.random() - 0.48) * 3;
      v = Math.max(5, Math.min(95, v + drift));
      points.push({
        marketId:   market.id,
        yesPct:     i === 0 ? Number(m.yesPct) : parseFloat(v.toFixed(1)),
        recordedAt: new Date(now.getTime() - i * 86400000),
      });
    }
    await prisma.probabilityLog.createMany({ data: points });
  }
  console.log('✅ Probability history seeded');

  // ── Demo notifications ────────────────────────────
  const notifCount = await prisma.notification.count({ where: { userId: demo.id } });
  if (notifCount === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: demo.id, type: 'result', icon: '✅', title: '開獎：台積電Q3營收創新高',      body: '你預測「是」，恭喜獲勝！獲得 +420 🪙 積分。' },
        { userId: demo.id, type: 'reward', icon: '🎰', title: '抽獎結果通知',                body: '恭喜！你抽到全家 NT$100 兌換券，已發送到帳戶。' },
        { userId: demo.id, type: 'system', icon: '🏆', title: '排名提升！你現在排名 #12',    body: '連續 7 場全勝，已解鎖「先知大師」稱號！' },
        { userId: demo.id, type: 'promo',  icon: '⚡', title: 'PRO 專屬：本週熱門市場分析', body: 'GPT-5 市場：機率從 74% 上升至 82%，趨勢明顯看漲。' },
      ],
    });
    console.log('✅ Demo notifications created');
  }

  console.log('\n🎉 Seed complete!');
  console.log('─────────────────────────────────');
  console.log('Demo 帳號: demo@predic.tw');
  console.log('Demo 密碼: Demo1234!');
  console.log('─────────────────────────────────');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
