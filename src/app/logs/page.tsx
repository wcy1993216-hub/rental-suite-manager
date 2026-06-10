"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate, monthInputToBillMonth } from "@/lib/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AuditLog } from "@/lib/types";

const LOG_PAGE_SIZE = 100;

const ACTION_LABELS: Record<string, string> = {
  lock_month: "鎖定月份",
  unlock_month: "解除月結",
  disable_room: "停用房間",
  enable_room: "恢復房間",
  generate_monthly_bills: "產生本月帳單",
  clear_monthly_bills: "清除本月帳單",
  update_room_bill: "更新房間帳單",
  update_maintenance_record: "更新修繕記錄",
  update_electricity_fee: "修改電費",
  update_water_common_electricity_fee: "修改水費/公電",
  update_misc_fee: "修改其他",
  confirm_cash_payment: "確認現金收款",
  register_bank_transfer: "登記匯款",
  reset_payment_status: "撤回為未收"
};

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getDetailSummary(log: AuditLog) {
  const detail = log.detail ?? {};
  const parts: string[] = [];

  if (typeof detail.room_number === "string") parts.push(`房號 ${detail.room_number}`);
  if (typeof detail.inserted_count === "number") parts.push(`新增 ${detail.inserted_count} 筆`);
  if (typeof detail.deleted_count === "number") parts.push(`刪除 ${detail.deleted_count} 筆`);
  if (typeof detail.previous_value === "number" || typeof detail.next_value === "number") {
    parts.push(`${detail.previous_value ?? "-"} → ${detail.next_value ?? "-"}`);
  }
  if (typeof detail.payment_status === "string") parts.push(`狀態 ${detail.payment_status}`);
  if (typeof detail.transfer_last5 === "string") parts.push(`後五碼 ${detail.transfer_last5}`);
  if (typeof detail.transfer_amount === "number") parts.push(`金額 ${detail.transfer_amount}`);

  return parts.length > 0 ? parts.join("，") : JSON.stringify(detail);
}

export default function LogsPage() {
  return (
    <AuthGuard allowedRoles={["super_admin"]}>
      {() => <LogsContent />}
    </AuthGuard>
  );
}

function LogsContent() {
  const supabase = getSupabaseBrowserClient();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [monthFilter, setMonthFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadLogs = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError("");

    let query = supabase
      .from("audit_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (monthFilter) {
      query = query.eq("bill_month", monthInputToBillMonth(monthFilter));
    }

    if (actionFilter !== "all") {
      query = query.eq("action", actionFilter);
    }

    const from = (currentPage - 1) * LOG_PAGE_SIZE;
    const to = from + LOG_PAGE_SIZE - 1;
    const { data, count, error: queryError } = await query.range(from, to);

    if (queryError) {
      setError(queryError.message);
      setLogs([]);
      setTotalCount(0);
      setLoading(false);
      return;
    }

    setLogs((data ?? []) as AuditLog[]);
    setTotalCount(count ?? 0);
    setLoading(false);
  }, [actionFilter, currentPage, monthFilter, supabase]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const totalPages = Math.max(1, Math.ceil(totalCount / LOG_PAGE_SIZE));
  const startItem = totalCount === 0 ? 0 : (currentPage - 1) * LOG_PAGE_SIZE + 1;
  const endItem = Math.min(currentPage * LOG_PAGE_SIZE, totalCount);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const totalText = useMemo(() => {
    if (totalCount === 0) return "共 0 筆";
    return `第 ${startItem}-${endItem} 筆，共 ${totalCount} 筆`;
  }, [endItem, startItem, totalCount]);

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h1>操作記錄</h1>
          <p>保留月結、付款、帳單與房間停用等重要操作，方便月底或事後查核。</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" type="button" onClick={loadLogs} disabled={loading}>
            <RefreshCw size={17} />
            重新整理
          </button>
        </div>
      </div>

      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="log-month">月份</label>
          <input
            id="log-month"
            className="input"
            type="month"
            value={monthFilter}
            onChange={(event) => {
              setMonthFilter(event.target.value);
              setCurrentPage(1);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="log-action">動作</label>
          <select
            id="log-action"
            className="select"
            value={actionFilter}
            onChange={(event) => {
              setActionFilter(event.target.value);
              setCurrentPage(1);
            }}
          >
            <option value="all">全部動作</option>
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar align-end">
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setMonthFilter("");
              setActionFilter("all");
              setCurrentPage(1);
            }}
            disabled={loading && logs.length === 0}
          >
            清除篩選
          </button>
        </div>
      </div>

      <div className="table-shell">
        <table className="data-table">
          <thead>
            <tr>
              <th>時間</th>
              <th>操作者</th>
              <th>動作</th>
              <th>月份</th>
              <th>房號</th>
              <th>目標</th>
              <th>明細</th>
            </tr>
          </thead>
          <tbody>
            {loading && logs.length === 0 ? (
              <tr>
                <td colSpan={7}>載入中...</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={7}>尚無操作記錄。</td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatTimestamp(log.created_at)}</td>
                  <td>{log.actor_email ?? "-"}</td>
                  <td><strong>{ACTION_LABELS[log.action] ?? log.action}</strong></td>
                  <td>{formatDate(log.bill_month)}</td>
                  <td>{typeof log.detail?.room_number === "string" ? log.detail.room_number : log.room_id ?? "-"}</td>
                  <td>{log.target_table ? `${log.target_table}${log.target_id ? ` / ${log.target_id.slice(0, 8)}` : ""}` : "-"}</td>
                  <td>{getDetailSummary(log)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <span className="pagination-meta">{totalText}</span>
        <div className="pagination-meta">
          <button className="icon-button" type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1 || loading}>
            <ChevronLeft size={17} />
          </button>
          <span className="pagination-page">{currentPage} / {totalPages}</span>
          <button className="icon-button" type="button" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage >= totalPages || loading}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
    </>
  );
}
