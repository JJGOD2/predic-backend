# Predic Backend API

Fastify + PostgreSQL + Redis 後端

## 快速啟動（本地開發）

```bash
# 1. 安裝套件
npm install

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env，填入你的 DATABASE_URL 等

# 3. 建立資料庫 Schema
npm run db:push

# 4. 填入初始資料（12個市場 + demo帳號）
npm run db:seed

# 5. 啟動開發伺服器
npm run dev
```

API 會跑在 `http://localhost:3001`

## API 測試

```bash
# Health check
curl http://localhost:3001/health

# 註冊
curl -X POST http://localhost:3001/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"TestUser","email":"test@example.com","password":"Test1234!"}'

# 登入
curl -X POST http://localhost:3001/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@predic.tw","password":"Demo1234!"}'

# 市場列表
curl http://localhost:3001/v1/markets
```

## 部署到 Zeabur

詳見 README 的部署步驟說明。
