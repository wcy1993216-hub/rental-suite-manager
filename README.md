# 套房租金管理系統

Next.js + TypeScript + Supabase + PostgreSQL 的電腦版後台管理 MVP。

## 本地啟動

1. 安裝依賴：

```bash
npm install
```

2. 建立 `.env.local`，參考 `.env.example` 填入 Supabase URL 與 publishable key。

3. 到 Supabase SQL Editor 執行 `supabase/schema.sql`。

4. 先在 Supabase Auth 建立第一個使用者，再手動把該使用者加入 `profiles` 並設為 `super_admin`。

5. 啟動：

```bash
npm run dev
```

## 主要頁面

- `/login`：登入
- `/dashboard`：每月收租表
- `/rooms/[roomId]`：房間詳情
- `/rooms`：房間管理
- `/maintenance`：修繕管理
- `/import`：Excel 匯入
- `/users`：帳號權限

## 維運文件

- [備份機制](docs/備份機制.md)
- [專案上下文](docs/專案上下文.md)
- [對話分工 Skills](docs/對話分工Skills.md)


