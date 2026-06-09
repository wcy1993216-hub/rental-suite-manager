"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AuditLog } from "@/lib/types";

const ACTION_LABELS: Record<string, string> = {
  lock_month: "鎖定月份",
  unlock_month: "解除月結",
  disable_room: "停用房間",
  enable_room: "恢復房間",
  generate_monthly_bills: "產生本月帳單",
  clear_monthly_bills: "清除本月帳單",
  update_room_bill: "更新房間帳單",
  update_electricity_fee: "修改電費",
  update_misc_fee: "修改雜支",
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadLogs = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError("");

    const { data, error: queryError } = await supabase
      .from("audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);

    if (queryError) {
      setError(queryError.message);
      setLogs([]);
      setLoading(false);
      return;
    }

    setLogs((data ?? []) as AuditLog[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const totalText = useMemo(() => `最近 ${logs.length} 筆`, [logs.length]);

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
            {loading ? (
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

      <p className="muted" style={{ marginTop: 12 }}>{totalText}</p>
    </>
  );
}
