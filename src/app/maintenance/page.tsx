"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronLeft, ChevronRight, Eye, Pencil, RefreshCw } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { Modal } from "@/components/Modal";
import { MaintenanceStatusBadge } from "@/components/StatusBadge";
import { formatCurrency, formatDate } from "@/lib/format";
import { logAuditAction } from "@/lib/audit";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ContractWithTenant, MaintenanceRecord, MaintenanceStatus, Room } from "@/lib/types";

const PAGE_SIZE = 100;

type MaintenanceFilter = "open" | "all" | MaintenanceStatus;

const FILTER_OPTIONS: { value: MaintenanceFilter; label: string }[] = [
  { value: "open", label: "未完成" },
  { value: "pending", label: "待處理" },
  { value: "processing", label: "處理中" },
  { value: "completed", label: "已完成" },
  { value: "all", label: "全部" }
];

const MAINTENANCE_STATUS_OPTIONS: { value: MaintenanceStatus; label: string }[] = [
  { value: "pending", label: "待處理" },
  { value: "processing", label: "處理中" },
  { value: "completed", label: "已完成" }
];

interface MaintenanceRow extends MaintenanceRecord {
  rooms: Room | null;
  contracts: ContractWithTenant | null;
}

function normalizeMaintenanceRows(data: unknown[] | null): MaintenanceRow[] {
  return (data ?? []).map((item) => {
    const row = item as MaintenanceRecord & {
      rooms?: Room | Room[] | null;
      contracts?: ContractWithTenant | ContractWithTenant[] | null;
    };

    return {
      ...row,
      rooms: Array.isArray(row.rooms) ? row.rooms[0] ?? null : row.rooms ?? null,
      contracts: Array.isArray(row.contracts) ? row.contracts[0] ?? null : row.contracts ?? null
    };
  });
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function MaintenancePage() {
  return (
    <AuthGuard allowedRoles={["super_admin"]}>
      {() => <MaintenanceContent />}
    </AuthGuard>
  );
}

function MaintenanceContent() {
  const supabase = getSupabaseBrowserClient();
  const [records, setRecords] = useState<MaintenanceRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<MaintenanceFilter>("open");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [monthCreatedCount, setMonthCreatedCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [editingRecord, setEditingRecord] = useState<MaintenanceRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadRecords = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError("");

    let query = supabase
      .from("maintenance_records")
      .select("*, rooms(*), contracts(*, tenants(*))", { count: "exact" })
      .order("created_at", { ascending: false });

    if (statusFilter === "open") {
      query = query.in("status", ["pending", "processing"]);
    } else if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const from = (currentPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, count, error: queryError } = await query.range(from, to);

    if (queryError) {
      setError(queryError.message);
      setRecords([]);
      setTotalCount(0);
      setLoading(false);
      return;
    }

    setRecords(normalizeMaintenanceRows(data as unknown[] | null));
    setTotalCount(count ?? 0);
    setLastSyncedAt(formatTimestamp(new Date().toISOString()));
    setLoading(false);
  }, [currentPage, statusFilter, supabase]);

  const loadStats = useCallback(async () => {
    if (!supabase) return;

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00:00`;
    const [pendingResult, processingResult, monthCreatedResult] = await Promise.all([
      supabase.from("maintenance_records").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("maintenance_records").select("id", { count: "exact", head: true }).eq("status", "processing"),
      supabase.from("maintenance_records").select("id", { count: "exact", head: true }).gte("created_at", monthStart)
    ]);

    setPendingCount(pendingResult.count ?? 0);
    setProcessingCount(processingResult.count ?? 0);
    setMonthCreatedCount(monthCreatedResult.count ?? 0);
  }, [supabase]);

  useEffect(() => {
    void loadRecords();
    void loadStats();
  }, [loadRecords, loadStats]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadRecords();
      void loadStats();
    }, 30000);

    return () => window.clearInterval(timer);
  }, [loadRecords, loadStats]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const startItem = totalCount === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(currentPage * PAGE_SIZE, totalCount);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const totalText = useMemo(() => {
    if (totalCount === 0) return "共 0 筆";
    return `第 ${startItem}-${endItem} 筆，共 ${totalCount} 筆`;
  }, [endItem, startItem, totalCount]);

  async function markCompleted(record: MaintenanceRow) {
    if (!supabase || record.status === "completed") return;
    const roomNumber = record.rooms?.room_number ?? "此房間";
    const confirmed = window.confirm(`確定將 ${roomNumber} 的「${record.title}」標記為已完成？`);
    if (!confirmed) return;

    setError("");
    setNotice("");
    const { error: updateError } = await supabase
      .from("maintenance_records")
      .update({ status: "completed" })
      .eq("id", record.id);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    await logAuditAction(supabase, {
      action: "update_maintenance_record",
      target_table: "maintenance_records",
      target_id: record.id,
      room_id: record.room_id,
      detail: {
        room_number: record.rooms?.room_number ?? null,
        title: record.title,
        previous_status: record.status,
        next_status: "completed"
      }
    });
    setNotice(`已將 ${roomNumber} 的修繕標記為已完成。`);
    await loadRecords();
    await loadStats();
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h1>修繕管理</h1>
          <p>最新修繕記錄集中在這裡，預設顯示待處理與處理中的項目。</p>
        </div>
        <div className="toolbar">
          {lastSyncedAt ? <span className="sync-pill sync-synced">已同步 {lastSyncedAt}</span> : null}
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              void loadRecords();
              void loadStats();
            }}
            disabled={loading}
          >
            <RefreshCw size={17} />
            重新整理
          </button>
        </div>
      </div>

      <div className="summary-grid compact-summary-grid">
        <div className="summary-card">
          <span>待處理</span>
          <strong>{pendingCount}</strong>
        </div>
        <div className="summary-card">
          <span>處理中</span>
          <strong>{processingCount}</strong>
        </div>
        <div className="summary-card">
          <span>本月新增</span>
          <strong>{monthCreatedCount}</strong>
        </div>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="maintenance-status">狀態</label>
          <select
            id="maintenance-status"
            className="select"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as MaintenanceFilter);
              setCurrentPage(1);
            }}
          >
            {FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}
      {notice ? <div className="notice" style={{ marginBottom: 14 }}>{notice}</div> : null}

      <div className="table-shell">
        <table className="data-table">
          <thead>
            <tr>
              <th>建立時間</th>
              <th>房號</th>
              <th>棟別</th>
              <th>租客</th>
              <th>修繕日期</th>
              <th>修繕項目</th>
              <th>狀態</th>
              <th>費用</th>
              <th>負責人員</th>
              <th>備註</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && records.length === 0 ? (
              <tr>
                <td colSpan={11}>載入中...</td>
              </tr>
            ) : records.length === 0 ? (
              <tr>
                <td colSpan={11}>目前沒有符合條件的修繕記錄。</td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td>{formatTimestamp(record.created_at)}</td>
                  <td><strong>{record.rooms?.room_number ?? "-"}</strong></td>
                  <td>{record.rooms?.building ?? "-"}</td>
                  <td>{record.contracts?.tenants?.name ?? "-"}</td>
                  <td>{formatDate(record.repair_date)}</td>
                  <td>{record.title}</td>
                  <td><MaintenanceStatusBadge status={record.status} /></td>
                  <td className="number-cell">{formatCurrency(record.cost)}</td>
                  <td>{record.worker || "-"}</td>
                  <td>{record.note || record.description || "-"}</td>
                  <td>
                    <div className="toolbar">
                      {record.rooms ? (
                        <Link className="icon-button" href={`/rooms/${record.rooms.id}`} title="房間詳情">
                          <Eye size={17} />
                        </Link>
                      ) : null}
                      <button className="icon-button" type="button" onClick={() => setEditingRecord(record)} title="編輯修繕">
                        <Pencil size={17} />
                      </button>
                      {record.status !== "completed" ? (
                        <button className="icon-button" type="button" onClick={() => markCompleted(record)} title="標記完成">
                          <CheckCircle2 size={17} />
                        </button>
                      ) : null}
                    </div>
                  </td>
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

      {editingRecord ? (
        <MaintenanceEditDialog
          record={editingRecord}
          onClose={() => setEditingRecord(null)}
          onSaved={async () => {
            setEditingRecord(null);
            setNotice("修繕記錄已更新。");
            await loadRecords();
            await loadStats();
          }}
        />
      ) : null}
    </>
  );
}

function MaintenanceEditDialog({
  record,
  onClose,
  onSaved
}: {
  record: MaintenanceRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [repairDate, setRepairDate] = useState(record.repair_date ?? "");
  const [title, setTitle] = useState(record.title);
  const [description, setDescription] = useState(record.description ?? "");
  const [status, setStatus] = useState<MaintenanceStatus>(record.status);
  const [cost, setCost] = useState(String(record.cost ?? 0));
  const [worker, setWorker] = useState(record.worker ?? "");
  const [note, setNote] = useState(record.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setSaving(true);
    setError("");
    const payload = {
      repair_date: repairDate,
      title,
      description: description || null,
      status,
      cost: Number(cost) || 0,
      worker: worker || null,
      note: note || null
    };

    const { error: updateError } = await supabase
      .from("maintenance_records")
      .update(payload)
      .eq("id", record.id);

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    await logAuditAction(supabase, {
      action: "update_maintenance_record",
      target_table: "maintenance_records",
      target_id: record.id,
      room_id: record.room_id,
      detail: {
        room_number: record.rooms?.room_number ?? null,
        title,
        previous_status: record.status,
        next_status: status
      }
    });
    await onSaved();
  }

  return (
    <Modal title="編輯修繕記錄" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field">
              <label>房號</label>
              <input className="input" value={record.rooms?.room_number ?? "-"} disabled />
            </div>
            <div className="form-field">
              <label htmlFor="maintenance-edit-date">日期</label>
              <input id="maintenance-edit-date" className="input" type="date" value={repairDate} onChange={(event) => setRepairDate(event.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="maintenance-edit-title">修繕項目</label>
              <input id="maintenance-edit-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="maintenance-edit-status">狀態</label>
              <select id="maintenance-edit-status" className="select" value={status} onChange={(event) => setStatus(event.target.value as MaintenanceStatus)}>
                {MAINTENANCE_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="maintenance-edit-cost">費用</label>
              <input id="maintenance-edit-cost" className="input" type="number" min="0" value={cost} onChange={(event) => setCost(event.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="maintenance-edit-worker">負責人員</label>
              <input id="maintenance-edit-worker" className="input" value={worker} onChange={(event) => setWorker(event.target.value)} />
            </div>
            <div className="form-field full">
              <label htmlFor="maintenance-edit-description">說明</label>
              <textarea id="maintenance-edit-description" className="textarea" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div className="form-field full">
              <label htmlFor="maintenance-edit-note">備註</label>
              <textarea id="maintenance-edit-note" className="textarea" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          </div>
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button>
          <button className="button" type="submit" disabled={saving}>
            {saving ? "儲存中..." : "儲存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
