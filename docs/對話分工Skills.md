# 套房租金管理系統對話分工 Skills

最後更新：2026-06-10

這份文件不是程式功能，而是給 Codex 新對話使用的「分工工作規範」。目標是讓大專案可以拆成多個清楚的對話，例如 UI、功能、資料庫、部署維運，但又不會互相改亂。

## 使用原則

1. 每個新對話開始前，都先要求它閱讀共用文件。
2. 每個對話只負責自己的範圍，不跨太多檔案。
3. 每次修改前先 `git pull` 或確認目前是最新狀態。
4. 每次修改後執行 `npm.cmd run build`。
5. 建置通過後才 commit 和 push。
6. 同一時間不要讓兩個對話改同一個檔案。
7. 重要功能完成後，要更新 `docs/專案上下文.md`。

共用開場：

```text
請先閱讀 README.md、docs/專案上下文.md、docs/備份機制.md、docs/對話分工Skills.md，再開始。
目前工作目錄是 C:\Users\wcy76\OneDrive\Documents\套房租金管理系统。
修改前先確認 git status，修改後執行 npm.cmd run build，通過後 commit 並 push。
不要刪除歷史資料，不要 git reset。
```

## Skill 1：主線功能開發

適合處理：

- 收租流程
- 租約邏輯
- 更換租客
- 退租
- 月結
- 匯款 / 現金收款
- 產生帳單
- 對帳單匯出

建議對話名稱：

```text
套房租金｜主線功能
```

開場提示：

```text
你是套房租金管理系統的主線功能開發對話。
請先閱讀 README.md、docs/專案上下文.md、docs/對話分工Skills.md。

本對話只負責收租、租約、帳單、退租、月結、對帳等核心功能。
請優先保證資料正確，不要為了畫面效果改壞資料流程。
修改前先閱讀相關既有程式，修改後執行 npm.cmd run build，通過後 commit 並 push。
```

常改檔案：

- `src/app/dashboard/page.tsx`
- `src/app/rooms/[roomId]/page.tsx`
- `src/lib/permissions.ts`
- `src/lib/types.ts`
- `src/lib/format.ts`
- `src/lib/billNotes.ts`

注意：

- 不要任意改資料庫 schema，除非任務明確需要。
- 不要改整站視覺風格，UI 細節交給 UI 對話。
- 收款狀態與金額計算要保守處理。

## Skill 2：UI / 使用體驗

適合處理：

- 頁面排版
- 表格密度
- 按鈕位置
- 顏色與狀態標籤
- 後台視覺一致性
- 操作體驗是否順手
- 避免整頁白屏、跳動、眼花

建議對話名稱：

```text
套房租金｜UI體驗
```

開場提示：

```text
你是套房租金管理系統的 UI / 使用體驗對話。
請先閱讀 README.md、docs/專案上下文.md、docs/對話分工Skills.md。

本系統是電腦版後台管理系統，請保持簡潔、清楚、表格為主。
不要做行銷頁或花俏卡片。不要過度使用大面積顏色。
修改前先確認不會影響資料邏輯。修改後執行 npm.cmd run build，通過後 commit 並 push。
```

常改檔案：

- `src/app/globals.css`
- `src/components/AppShell.tsx`
- `src/components/StatusBadge.tsx`
- 各頁面中的小型 JSX 排版

注意：

- 不要重寫核心資料流程。
- 不要把後台做成 landing page。
- 表格、篩選、操作按鈕要優先可掃描、可重複使用。
- 如果需要改 `dashboard/page.tsx` 或 `rooms/[roomId]/page.tsx`，只改 UI 區塊，不碰資料寫入邏輯。

## Skill 3：Supabase / 資料庫

適合處理：

- PostgreSQL schema
- RLS 權限
- migration SQL
- 資料安全限制
- Realtime 設定
- 備份與還原
- 資料清理

建議對話名稱：

```text
套房租金｜Supabase資料庫
```

開場提示：

```text
你是套房租金管理系統的 Supabase / PostgreSQL 對話。
請先閱讀 README.md、docs/專案上下文.md、docs/備份機制.md、docs/對話分工Skills.md。

本對話只負責資料庫 schema、RLS、migration、安全限制、備份還原。
任何會刪除資料或修改大量資料的 SQL，都必須先說明風險，不要直接執行。
請優先保留歷史資料。修改後如影響前端型別，請同步更新 src/lib/types.ts。
```

常改檔案：

- `supabase/schema.sql`
- `supabase/*.sql`
- `src/lib/types.ts`
- `src/lib/permissions.ts`

注意：

- 不要直接刪除正式資料。
- 不要把 service role key、資料庫密碼寫進檔案。
- migration 要能重複執行，盡量使用 `if exists` / `if not exists`。
- 新增欄位時要考慮舊資料。

## Skill 4：部署 / 維運

適合處理：

- GitHub
- Vercel
- 環境變數
- 本機啟動
- build 錯誤
- 備份流程
- 專案交接文件
- 操作手冊

建議對話名稱：

```text
套房租金｜部署維運
```

開場提示：

```text
你是套房租金管理系統的部署 / 維運對話。
請先閱讀 README.md、docs/專案上下文.md、docs/備份機制.md、docs/對話分工Skills.md。

本對話負責 GitHub、Vercel、環境變數、本機啟動、備份、文件與交接。
不要改核心功能邏輯，除非是為了修 build 或部署錯誤。
修改後執行 npm.cmd run build，通過後 commit 並 push。
```

常改檔案：

- `README.md`
- `docs/*.md`
- `.env.example`
- `package.json`
- `next.config.ts`
- 部署相關設定檔

注意：

- `.env.local` 不可 commit。
- 正式環境變數要在 Vercel 設定。
- Supabase key 和密碼不可寫進文件。

## Skill 5：測試 / 品質檢查

適合處理：

- Build 檢查
- 主要流程驗收
- 回歸檢查
- 找 bug 風險
- 檢查 UI 是否有重疊或白屏
- 檢查資料流程是否會誤刪歷史

建議對話名稱：

```text
套房租金｜測試檢查
```

開場提示：

```text
你是套房租金管理系統的測試 / 品質檢查對話。
請先閱讀 README.md、docs/專案上下文.md、docs/對話分工Skills.md。

本對話優先找問題，不急著改大功能。
請用 code review 方式列出風險、可能 bug、缺少驗證的地方。
如果需要修小 bug，可以修改後執行 npm.cmd run build，通過後 commit 並 push。
```

常檢查範圍：

- 登入
- 每月收租表
- 房間詳情
- 更換租客
- 退租
- 現金 / 匯款
- 修繕管理
- 月結鎖定
- Excel 匯入
- 操作記錄

注意：

- 這個對話不要同時做大型功能開發。
- 發現問題要先描述影響，再決定是否修。

## 多對話協作規則

### 每次開始

新對話先做：

```powershell
git status --short
git pull
```

如果有未提交修改，先不要直接覆蓋。

### 每次完成

完成後：

```powershell
npm.cmd run build
git status --short
git add <changed files>
git commit -m "清楚描述修改"
git push
```

### 避免衝突

同一時間不要讓兩個對話改同一個檔案。

常見容易衝突的檔案：

- `src/app/dashboard/page.tsx`
- `src/app/rooms/[roomId]/page.tsx`
- `src/app/globals.css`
- `src/lib/types.ts`
- `supabase/schema.sql`

如果一定要多人改，先讓其中一個完成 commit / push，另一個再 pull。

## 建議使用方式

目前系統還在快速調整期，建議最多同時開 2 個對話：

1. 主線功能
2. UI 體驗

等系統更穩後，再分成：

1. 主線功能
2. UI 體驗
3. Supabase 資料庫
4. 部署維運
5. 測試檢查

## 什麼時候更新專案上下文

做完以下改動後，要更新 `docs/專案上下文.md`：

- 新增頁面
- 新增資料表或欄位
- 權限規則改變
- 收租邏輯改變
- 退租、修繕、月結流程改變
- 部署或備份方式改變

小改按鈕文字、顏色、位置，通常不用更新。

