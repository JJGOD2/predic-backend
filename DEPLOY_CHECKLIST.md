# 🚀 Deploy Checklist - 部署前檢查清單

## 1. 環境變數檢查
- [ ] `.env` 檔案存在
- [ ] `DATABASE_URL` 已設定
- [ ] `JWT_SECRET` 已設定
- [ ] `CORS_ORIGINS` 已設定

## 2. 資料庫檢查
- [ ] PostgreSQL 服務運行中
- [ ] `npx prisma db push` 可執行
- [ ] 資料表都已建立

## 3. 程式碼檢查（本地）
```bash
# 在專案根目錄執行：
npm install
npm run build  # 確認可以編譯
npx prisma validate  # 確認 schema 正確
```

## 4. Git 檢查
- [ ] `package-lock.json` 已 commit
- [ ] 最新程式碼已 push

## 5. Zeabur 檢查
- [ ] 選擇正確的資料夾
- [ ] 環境變數都已設定
- [ ] Build Command 正確
- [ ] Start Command 包含 db push

---

## 快速修復指令

```bash
# 確保 package-lock.json 存在
npm install --package-lock-only

# 驗證 Prisma Schema
npx prisma validate

# 測試編譯（忽略錯誤）
npm run build || true

# 確保所有依賴正確
rm -rf node_modules
npm install
```

---

## 常見問題解決

| 問題 | 解決方式 |
|------|----------|
| TypeScript 編譯錯誤 | `tsconfig.json` 加 `"skipLibCheck": true` |
| Prisma 找不到 | 確保 `npx prisma generate` 有執行 |
| 缺少模組 | 確保 `package-lock.json` 已 commit |
| 資料庫不同步 | Start Command 加入 `npx prisma db push` |

---

*最後更新: 2026-03-19*
