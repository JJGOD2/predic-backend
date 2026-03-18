const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const LEVEL_CONFIG = {
  1: { name: '村民', emoji: '🌑', requirement: 0 },
  2: { name: '預言家', emoji: '🌒', requirement: 3 }, // 3次正確
  3: { name: '獵人', emoji: '🌓', requirement: 10 }, // 10次正確 + 3連勝
  4: { name: '女巫', emoji: '🌔', requirement: 20 }, // 20次正確
  5: { name: '長老', emoji: '🌕', requirement: 30 }, // 30次正確
  6: { name: '守衛', emoji: '🌖', requirement: 50 }, // 50次正確 + 被追隨
  7: { name: '酒鬼', emoji: '🌗', requirement: 70 }, // 70次正確（瘋子）
  8: { name: '狼人', emoji: '🐺', requirement: 100 }, // 巔峰
};

const ACHIEVEMENTS = {
  // 首次成就
  first_predict: { name: '初試預測', emoji: '🌑', desc: '完成首次預測', score: 50 },
  first_correct: { name: '初試身手', emoji: '🌒', desc: '首次預測正確', score: 100 },
  first_win_streak: { name: '連勝初體驗', emoji: '🔥', desc: '達成首次連勝', score: 150 },
  
  // 數量成就
  predict_10: { name: '預測新手', emoji: '📊', desc: '完成 10 次預測', score: 100 },
  predict_50: { name: '預測老手', emoji: '📈', desc: '完成 50 次預測', score: 300 },
  predict_100: { name: '預測大師', emoji: '🎯', desc: '完成 100 次預測', score: 500 },
  
  // 連勝成就
  win_streak_3: { name: '三連勝', emoji: '🔥', desc: '連續 3 次正確', score: 200 },
  win_streak_5: { name: '五連勝', emoji: '💥', desc: '連續 5 次正確', score: 500 },
  win_streak_10: { name: '十連勝', emoji: '⚡', desc: '連續 10 次正確', score: 1000 },
  
  // 邀請成就
  invite_1: { name: '首位信徒', emoji: '👤', desc: '邀請首位朋友', score: 100 },
  invite_5: { name: '小小團體', emoji: '👥', desc: '邀請 5 位朋友', score: 300 },
  invite_10: { name: '預言家軍團', emoji: '🐺', desc: '邀請 10 位朋友', score: 800 },
  
  // 社群成就
  bound_instagram: { name: '社群達人', emoji: '📱', desc: '綁定 Instagram', score: 50 },
  bound_line: { name: 'LINE 族', emoji: '💚', desc: '綁定 LINE', score: 50 },
  
  // PRO 成就
  pro_member: { name: 'PRO 會員', emoji: '⚡', desc: '訂閱 PRO', score: 100 },
  
  // 幸運成就
  lottery_win: { name: '幸運兒', emoji: '🍀', desc: '首次抽獎中獎', score: 200 },
  lottery_5wins: { name: '抽獎達人', emoji: '🎁', desc: '抽獎中獎 5 次', score: 500 },
};

function calculateLevel(correctCount, consecutiveWins, totalPredictions) {
  // 根據正確次數計算等級
  if (correctCount >= 100) return 8;
  if (correctCount >= 70) return 7;
  if (correctCount >= 50) return 6;
  if (correctCount >= 30) return 5;
  if (correctCount >= 20) return 4;
  if (correctCount >= 10) return 3;
  if (correctCount >= 3) return 2;
  return 1;
}

function calculateTitle(level) {
  return LEVEL_CONFIG[level]?.name || '村民';
}

module.exports = async function levelRoutes(app) {
  // GET /v1/users/me/level - 獲取用戶等級資料
  app.get('/me/level', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        level: true,
        title: true,
        correctCount: true,
        consecutiveWins: true,
        consecutiveLosses: true,
        totalPredictions: true,
        achievements: true,
      }
    });
    
    if (!user) {
      return reply.status(404).json({ error: 'User not found' });
    }
    
    const achievements = JSON.parse(user.achievements || '[]');
    const allAchievements = Object.entries(ACHIEVEMENTS).map(([key, val]) => ({
      id: key,
      ...val,
      unlocked: achievements.includes(key),
    }));
    
    const currentLevel = LEVEL_CONFIG[user.level] || LEVEL_CONFIG[1];
    const nextLevel = LEVEL_CONFIG[user.level + 1];
    
    return {
      level: user.level,
      title: user.title,
      correctCount: user.correctCount,
      consecutiveWins: user.consecutiveWins,
      totalPredictions: user.totalPredictions,
      emoji: currentLevel.emoji,
      nextLevel: nextLevel ? {
        level: user.level + 1,
        name: nextLevel.name,
        emoji: nextLevel.emoji,
        requirement: nextLevel.requirement,
      } : null,
      achievements: allAchievements,
    };
  });

  // GET /v1/users/level-leaderboard - 等級排行榜
  app.get('/level-leaderboard', async (req, reply) => {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    
    const users = await prisma.user.findMany({
      take: limit,
      orderBy: { level: 'desc' },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        level: true,
        title: true,
        correctCount: true,
      }
    });
    
    const ranked = users.map((u, i) => ({
      rank: i + 1,
      ...u,
      emoji: LEVEL_CONFIG[u.level]?.emoji || '🌑',
    }));
    
    return ranked;
  });

  // POST /v1/users/me/update-level - 更新用戶等級（預測結算後呼叫）
  app.post('/me/update-level', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { isCorrect, isWinStreak } = req.body;
    
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      return reply.status(404).json({ error: 'User not found' });
    }
    
    let correctCount = user.correctCount || 0;
    let consecutiveWins = user.consecutiveWins || 0;
    let consecutiveLosses = user.consecutiveLosses || 0;
    let totalPredictions = user.totalPredictions || 0;
    
    // 更新統計
    totalPredictions++;
    if (isCorrect) {
      correctCount++;
      consecutiveWins++;
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      consecutiveWins = 0;
    }
    
    // 計算新等級
    const newLevel = calculateLevel(correctCount, consecutiveWins, totalPredictions);
    const newTitle = calculateTitle(newLevel);
    
    // 檢查升級
    const oldLevel = user.level || 1;
    let leveledUp = false;
    if (newLevel > oldLevel) {
      leveledUp = true;
    }
    
    // 更新用戶
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        correctCount,
        consecutiveWins,
        consecutiveLosses,
        totalPredictions,
        level: newLevel,
        title: newTitle,
      }
    });
    
    return {
      level: newLevel,
      title: newTitle,
      emoji: LEVEL_CONFIG[newLevel]?.emoji,
      leveledUp,
      stats: {
        correctCount,
        totalPredictions,
        consecutiveWins,
        consecutiveLosses,
      }
    };
  });

  // 解鎖成就
  app.post('/me/unlock-achievement', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { achievementId } = req.body;
    
    if (!ACHIEVEMENTS[achievementId]) {
      return reply.status(400).json({ error: 'Invalid achievement' });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    const achievements = JSON.parse(user.achievements || '[]');
    
    if (achievements.includes(achievementId)) {
      return { alreadyUnlocked: true };
    }
    
    achievements.push(achievementId);
    
    await prisma.user.update({
      where: { id: userId },
      data: {
        achievements: JSON.stringify(achievements),
        score: { increment: ACHIEVEMENTS[achievementId].score },
      }
    });
    
    return {
      unlocked: true,
      achievement: ACHIEVEMENTS[achievementId],
      totalScore: user.score + ACHIEVEMENTS[achievementId].score,
    };
  });
};
