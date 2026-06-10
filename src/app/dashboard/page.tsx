"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as XLSX from "xlsx";
import { Banknote, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Eye, Landmark, Lock, RefreshCw, RotateCcw, Search, Undo2, Unlock } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { Modal } from "@/components/Modal";
import { PaymentStatusBadge } from "@/components/StatusBadge";
import { useDashboardPagination } from "@/hooks/useDashboardPagination";
import { logAuditAction } from "@/lib/audit";
import { getActiveContractBillNote } from "@/lib/billNotes";
import { formatCurrency, formatDate, getCurrentMonthInputValue, monthInputToBillMonth, todayString } from "@/lib/format";
import { canConfirmCash, canManageEverything, canRegisterBankTransfer, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/permissions";
import { getRoomBuilding } from "@/lib/rooms";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ContractWithTenant, DashboardBill, MonthlyLock, PaymentMethod, PaymentStatus, RentPaymentCycle, Room, Role } from "@/lib/types";

type StatusFilter = "all" | PaymentStatus;
type SyncStatus = "idle" | "syncing" | "synced";

const DASHBOARD_CACHE_PREFIX = "rental-dashboard-rows";
const DASHBOARD_SYNC_REASON_KEY = "rental-dashboard-needs-sync";
const DASHBOARD_FOCUS_ROOM_KEY = "rental-dashboard-focus-room-id";
const DASHBOARD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface MonthlyBillInsertPayload {
  room_id: string;
  contract_id: string | null;
  bill_month: string;
  rent_amount: number;
  recurring_fee: number;
  electricity_fee: number;
  water_common_electricity_fee: number;
  misc_fee: number;
  total_amount: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  paid_date: string | null;
  note: string | null;
}

interface DashboardRowsCachePayload {
  savedAt: number;
  rows: DashboardBill[];
}

function normalizeBillRows(data: unknown[] | null): DashboardBill[] {
  return (data ?? []).map((item) => {
    const row = item as DashboardBill & {
      rooms?: Room | Room[] | null;
      contracts?: ContractWithTenant | ContractWithTenant[] | null;
    };
    return {
      ...row,
      rooms: Array.isArray(row.rooms) ? row.rooms[0] ?? null : row.rooms ?? null,
      contracts: Array.isArray(row.contracts) ? row.contracts[0] ?? null : row.contracts ?? null,
      note: row.contract_id || row.contracts ? getActiveContractBillNote(row.note, row.payment_status) : row.note
    };
  });
}

interface ActiveContractForGeneration extends ContractWithTenant {
  rooms: Room | null;
}

const RENT_PAYMENT_CYCLE_LABELS: Record<RentPaymentCycle, string> = {
  monthly: "月繳",
  semiannual: "半年繳",
  annual: "年繳"
};

function isPaymentStatus(value: string | null): value is PaymentStatus {
  return Boolean(value && value in PAYMENT_STATUS_LABELS);
}

function isMonthWithinContract(monthDate: string, contract: ContractWithTenant) {
  if (contract.start_date && monthDate < contract.start_date.slice(0, 7) + "-01") return false;
  if (contract.end_date && monthDate > contract.end_date.slice(0, 7) + "-01") return false;
  return true;
}

function isRentPrepaidForMonth(monthDate: string, contract: ContractWithTenant) {
  return contract.rent_payment_cycle !== "monthly" && Boolean(contract.rent_paid_until && contract.rent_paid_until >= monthDate);
}

function buildPaymentDueDate(billMonth: string, dueDay: number | null | undefined) {
  if (!dueDay) return null;
  const [yearText, monthText] = billMonth.slice(0, 7).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const lastDay = new Date(year, month, 0).getDate();
  const day = Math.min(Math.max(Number(dueDay), 1), lastDay);
  return `${yearText}-${monthText}-${String(day).padStart(2, "0")}`;
}

function calculateBillTotal(bill: {
  rent_amount?: number | null;
  recurring_fee?: number | null;
  electricity_fee?: number | null;
  water_common_electricity_fee?: number | null;
  misc_fee?: number | null;
}) {
  return (
    Number(bill.rent_amount ?? 0) +
    Number(bill.electricity_fee ?? 0) +
    Number(bill.water_common_electricity_fee ?? 0) +
    Number(bill.recurring_fee ?? 0) +
    Number(bill.misc_fee ?? 0)
  );
}

function getReceivedAmount(row: Pick<DashboardBill, "payment_status" | "payment_method" | "total_amount" | "transfer_amount">) {
  const totalAmount = Number(row.total_amount ?? 0);
  if (row.payment_status === "cash_paid") return totalAmount;
  if (row.payment_status === "bank_paid") return Number(row.transfer_amount ?? totalAmount);
  if (row.payment_status === "partial_paid") return Math.min(Number(row.transfer_amount ?? 0), totalAmount);
  return 0;
}

function getUnpaidBalance(row: Pick<DashboardBill, "payment_status" | "payment_method" | "total_amount" | "transfer_amount">) {
  if (row.payment_status === "vacant") return 0;
  return Math.max(Number(row.total_amount ?? 0) - getReceivedAmount(row), 0);
}

function createVacantBillPayload(roomId: string, billMonth: string): MonthlyBillInsertPayload {
  return {
    room_id: roomId,
    contract_id: null,
    bill_month: billMonth,
    rent_amount: 0,
    recurring_fee: 0,
    electricity_fee: 0,
    water_common_electricity_fee: 0,
    misc_fee: 0,
    total_amount: 0,
    payment_method: "none" as PaymentMethod,
    payment_status: "vacant" as PaymentStatus,
    paid_date: null,
    note: "空房"
  };
}

function createContractBillPayload(contract: ContractWithTenant, billMonth: string): MonthlyBillInsertPayload {
  const rentPrepaid = isRentPrepaidForMonth(billMonth, contract);
  const rentAmount = rentPrepaid ? 0 : Number(contract.monthly_rent ?? 0);
  const recurringFee = Number(contract.cleaning_fee ?? 0) + Number(contract.parking_fee ?? 0);
  const totalAmount = rentAmount + recurringFee;
  const note = rentPrepaid
    ? `房租已${RENT_PAYMENT_CYCLE_LABELS[contract.rent_payment_cycle ?? "monthly"]}至 ${formatDate(contract.rent_paid_until)}`
    : null;

  return {
    room_id: contract.room_id,
    contract_id: contract.id,
    bill_month: billMonth,
    rent_amount: rentAmount,
    recurring_fee: recurringFee,
    electricity_fee: 0,
    water_common_electricity_fee: 0,
    misc_fee: 0,
    total_amount: totalAmount,
    payment_method: "none" as PaymentMethod,
    payment_status: rentPrepaid && totalAmount === 0 ? ("rent_prepaid" as PaymentStatus) : ("unpaid" as PaymentStatus),
    paid_date: buildPaymentDueDate(billMonth, contract.payment_due_day),
    note
  };
}

function normalizeActiveContracts(data: unknown[] | null): ActiveContractForGeneration[] {
  return (data ?? []).map((item) => {
    const row = item as ActiveContractForGeneration & {
      rooms?: Room | Room[] | null;
    };
    return {
      ...row,
      rooms: Array.isArray(row.rooms) ? row.rooms[0] ?? null : row.rooms ?? null
    };
  });
}

function isMissingTableError(error: { message?: string; code?: string } | null) {
  return Boolean(error?.code === "42P01" || error?.message?.includes("does not exist"));
}

function sortDashboardRows(rows: DashboardBill[]) {
  return [...rows].sort((a, b) => {
    const buildingCompare = getRoomBuilding(a.rooms).localeCompare(getRoomBuilding(b.rooms), "zh-Hant");
    if (buildingCompare !== 0) return buildingCompare;
    return String(a.rooms?.room_number ?? "").localeCompare(String(b.rooms?.room_number ?? ""), "zh-Hant", {
      numeric: true
    });
  });
}

function dashboardCacheKey(month: string) {
  return `${DASHBOARD_CACHE_PREFIX}:${month}`;
}

function readDashboardRowsCache(month: string) {
  if (typeof window === "undefined") return null;
  const key = dashboardCacheKey(month);

  try {
    const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DashboardBill[] | DashboardRowsCachePayload;
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    const savedAt = Array.isArray(parsed) ? Date.now() : parsed.savedAt;
    if (!Array.isArray(rows)) return null;
    if (Date.now() - savedAt > DASHBOARD_CACHE_TTL_MS) return null;
    return rows;
  } catch {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
    return null;
  }
}

function writeDashboardRowsCache(month: string, rows: DashboardBill[]) {
  if (typeof window === "undefined") return;
  const key = dashboardCacheKey(month);
  const payload: DashboardRowsCachePayload = {
    savedAt: Date.now(),
    rows
  };

  try {
    const serialized = JSON.stringify(payload);
    sessionStorage.setItem(key, serialized);
    localStorage.setItem(key, serialized);
  } catch {
    // Cache failure should never block the dashboard.
  }
}

export default function DashboardPage() {
  return (
    <AuthGuard>
      {({ role }) => <DashboardContent role={role} />}
    </AuthGuard>
  );
}

function DashboardContent({ role }: { role: Role }) {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");
  const [month, setMonth] = useState(searchParams.get("month") || getCurrentMonthInputValue());
  const [building, setBuilding] = useState(searchParams.get("building") || "all");
  const [status, setStatus] = useState<StatusFilter>(isPaymentStatus(statusParam) ? statusParam : "all");
  const [keyword, setKeyword] = useState(searchParams.get("keyword") || "");
  const [rows, setRows] = useState<DashboardBill[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncMessage, setSyncMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bankBill, setBankBill] = useState<DashboardBill | null>(null);
  const [savingBillId, setSavingBillId] = useState<string | null>(null);
  const [rowSyncingIds, setRowSyncingIds] = useState<Set<string>>(() => new Set());
  const [rowSyncedIds, setRowSyncedIds] = useState<Set<string>>(() => new Set());
  const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null);
  const [monthLock, setMonthLock] = useState<MonthlyLock | null>(null);
  const rowsRef = useRef<DashboardBill[]>([]);
  const loadRequestIdRef = useRef(0);
  const syncMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localMutationIdsRef = useRef<Set<string>>(new Set());

  const showSyncMessage = useCallback((status: SyncStatus, message: string) => {
    if (syncMessageTimerRef.current) {
      clearTimeout(syncMessageTimerRef.current);
    }
    setSyncStatus(status);
    setSyncMessage(message);
    if (status === "synced") {
      syncMessageTimerRef.current = setTimeout(() => {
        setSyncStatus("idle");
        setSyncMessage("");
      }, 2400);
    }
  }, []);

  const replaceOneRow = useCallback((nextRow: DashboardBill) => {
    setRows((currentRows) => sortDashboardRows(currentRows.map((row) => (row.id === nextRow.id ? nextRow : row))));
  }, []);

  const loadBills = useCallback(async (options: { background?: boolean; reason?: "manual" | "navigation" | "realtime" | "mutation" } = {}) => {
    if (!supabase) return;
    const background = options.background ?? rowsRef.current.length > 0;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    if (background) {
      showSyncMessage("syncing", "同步中...");
    } else {
      setInitialLoading(true);
    }
    setError("");

    const billMonth = monthInputToBillMonth(month);
    const { data: lockData, error: lockError } = await supabase
      .from("monthly_locks")
      .select("*")
      .eq("bill_month", billMonth)
      .maybeSingle();

    const currentMonthLock = lockError && !isMissingTableError(lockError) ? null : (lockData as MonthlyLock | null);
    setMonthLock(currentMonthLock);

    if (lockError && !isMissingTableError(lockError)) {
      setError(lockError.message);
      setInitialLoading(false);
      setSyncStatus("idle");
      return;
    }

    const { data, error: queryError } = await supabase
      .from("monthly_bills")
      .select("*, rooms(*), contracts(*, tenants(*))")
      .eq("bill_month", billMonth);

    if (queryError) {
      setError(queryError.message);
      setInitialLoading(false);
      setSyncStatus("idle");
    } else {
      let normalizedRows = normalizeBillRows(data as unknown[] | null);
      const existingRoomIds = new Set(normalizedRows.map((bill) => bill.room_id));

      if (currentMonthLock) {
        if (requestId === loadRequestIdRef.current) {
          setRows(sortDashboardRows(normalizedRows));
          setInitialLoading(false);
          showSyncMessage("synced", options.reason === "realtime" ? "資料已更新" : "已同步");
        }
        return;
      }

      const [{ data: roomData, error: roomError }, { data: activeContractData, error: activeContractError }] = await Promise.all([
        supabase
          .from("rooms")
          .select("*")
          .neq("status", "disabled"),
        supabase
          .from("contracts")
          .select("*, tenants(*), rooms(*)")
          .eq("status", "active")
      ]);

      if (roomError || activeContractError) {
        setError(roomError?.message ?? activeContractError?.message ?? "補齊空房帳單失敗。");
        setInitialLoading(false);
        setSyncStatus("idle");
        return;
      }

      const coveredContractRoomIds = new Set(
        normalizeActiveContracts(activeContractData as unknown[] | null)
          .filter((contract) => isMonthWithinContract(billMonth, contract))
          .map((contract) => contract.room_id)
      );
      const vacantBillsToInsert = ((roomData ?? []) as Room[])
        .filter((room) => !existingRoomIds.has(room.id) && !coveredContractRoomIds.has(room.id))
        .map((room) => createVacantBillPayload(room.id, billMonth));

      if (vacantBillsToInsert.length > 0) {
        const { error: insertError } = await supabase.from("monthly_bills").insert(vacantBillsToInsert);
        if (insertError) {
          setError(insertError.message);
          setInitialLoading(false);
          setSyncStatus("idle");
          return;
        }

        const { data: refreshedData, error: refreshedError } = await supabase
          .from("monthly_bills")
          .select("*, rooms(*), contracts(*, tenants(*))")
          .eq("bill_month", billMonth);

        if (refreshedError) {
          setError(refreshedError.message);
          setInitialLoading(false);
          setSyncStatus("idle");
          return;
        }

        normalizedRows = normalizeBillRows(refreshedData as unknown[] | null);
      }

      if (requestId === loadRequestIdRef.current) {
        setRows(sortDashboardRows(normalizedRows));
        setInitialLoading(false);
        showSyncMessage("synced", options.reason === "realtime" ? "資料已更新" : "已同步");
      }
    }
  }, [month, showSyncMessage, supabase]);

  useEffect(() => {
    rowsRef.current = rows;
    if (typeof window !== "undefined" && rows.length > 0) {
      writeDashboardRowsCache(month, rows);
    }
  }, [month, rows]);

  useEffect(() => {
    let hasCachedRows = false;
    if (typeof window !== "undefined") {
      const cachedRows = readDashboardRowsCache(month);
      if (cachedRows) {
        setRows(sortDashboardRows(cachedRows));
        rowsRef.current = cachedRows;
        setInitialLoading(false);
        hasCachedRows = cachedRows.length > 0;
      } else {
        setRows([]);
        rowsRef.current = [];
        setInitialLoading(true);
      }
    }

    const syncReason = typeof window !== "undefined" ? sessionStorage.getItem(DASHBOARD_SYNC_REASON_KEY) : null;
    const focusRoomId = typeof window !== "undefined" ? sessionStorage.getItem(DASHBOARD_FOCUS_ROOM_KEY) : null;
    if (syncReason) {
      sessionStorage.removeItem(DASHBOARD_SYNC_REASON_KEY);
    }
    if (focusRoomId) {
      sessionStorage.removeItem(DASHBOARD_FOCUS_ROOM_KEY);
      setFocusedRoomId(focusRoomId);
    }
    void loadBills({
      background: hasCachedRows,
      reason: syncReason ? "navigation" : "manual"
    });
  }, [loadBills, month]);

  useEffect(() => {
    return () => {
      if (syncMessageTimerRef.current) {
        clearTimeout(syncMessageTimerRef.current);
      }
      if (realtimeTimerRef.current) {
        clearTimeout(realtimeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const nextParams = new URLSearchParams();
    if (month) nextParams.set("month", month);
    if (building !== "all") nextParams.set("building", building);
    if (status !== "all") nextParams.set("status", status);
    if (keyword.trim()) nextParams.set("keyword", keyword.trim());

    const nextUrl = nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname;
    const currentUrl = searchParams.toString() ? `${pathname}?${searchParams.toString()}` : pathname;
    if (nextUrl !== currentUrl) {
      router.replace(nextUrl, { scroll: false });
    }
  }, [building, keyword, month, pathname, router, searchParams, status]);

  const queueRealtimeSync = useCallback((payload?: { table?: string; new?: { id?: string }; old?: { id?: string } }) => {
    const changedId = payload?.new?.id ?? payload?.old?.id;
    if (payload?.table === "monthly_bills" && changedId && localMutationIdsRef.current.has(changedId)) {
      return;
    }
    if (realtimeTimerRef.current) {
      clearTimeout(realtimeTimerRef.current);
    }
    showSyncMessage("syncing", "同步中...");
    realtimeTimerRef.current = setTimeout(() => {
      void loadBills({ background: true, reason: "realtime" });
    }, 650);
  }, [loadBills, showSyncMessage]);

  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel(`dashboard-realtime-${month}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, queueRealtimeSync)
      .on("postgres_changes", { event: "*", schema: "public", table: "tenants" }, queueRealtimeSync)
      .on("postgres_changes", { event: "*", schema: "public", table: "contracts" }, queueRealtimeSync)
      .on("postgres_changes", { event: "*", schema: "public", table: "monthly_bills" }, queueRealtimeSync)
      .subscribe();

    return () => {
      if (realtimeTimerRef.current) {
        clearTimeout(realtimeTimerRef.current);
      }
      void supabase.removeChannel(channel);
    };
  }, [month, queueRealtimeSync, supabase]);

  const currentDashboardParams = useMemo(() => {
    const params = new URLSearchParams();
    if (month) params.set("month", month);
    if (building !== "all") params.set("building", building);
    if (status !== "all") params.set("status", status);
    if (keyword.trim()) params.set("keyword", keyword.trim());
    return params.toString();
  }, [building, keyword, month, status]);

  const buildingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      const name = getRoomBuilding(row.rooms);
      if (!name) return;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    return counts;
  }, [rows]);

  const buildings = useMemo(() => {
    return Array.from(buildingCounts.keys()).sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [buildingCounts]);

  const totalBuildingCount = useMemo(() => {
    return Array.from(buildingCounts.values()).reduce((sum, count) => sum + count, 0);
  }, [buildingCounts]);

  useEffect(() => {
    if (rows.length > 0 && building !== "all" && !buildings.includes(building)) {
      setBuilding("all");
    }
  }, [building, buildings, rows.length]);

  const buildingFilterOptions = useMemo(() => {
    return [
      { value: "all", label: "全部", count: totalBuildingCount },
      ...buildings.map((item) => ({
        value: item,
        label: item,
        count: buildingCounts.get(item) ?? 0
      }))
    ];
  }, [buildingCounts, buildings, totalBuildingCount]);

  const shouldUseBuildingSelect = buildingFilterOptions.length > 7;

  const filteredRows = useMemo(() => {
    const loweredKeyword = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      const tenantName = row.contracts?.tenants?.name ?? "";
      const roomNumber = row.rooms?.room_number ?? "";
      const matchBuilding = building === "all" || getRoomBuilding(row.rooms) === building;
      const matchStatus = status === "all" || row.payment_status === status;
      const matchKeyword =
        loweredKeyword.length === 0 ||
        tenantName.toLowerCase().includes(loweredKeyword) ||
        roomNumber.toLowerCase().includes(loweredKeyword);
      return matchBuilding && matchStatus && matchKeyword;
    });
  }, [building, keyword, rows, status]);

  const {
    currentPage,
    endItem,
    pageItems: paginatedRows,
    pageSize,
    setCurrentPage,
    setPageSize,
    startItem,
    totalItems,
    totalPages
  } = useDashboardPagination(filteredRows, 50);

  useEffect(() => {
    setCurrentPage(1);
  }, [building, keyword, month, pageSize, setCurrentPage, status]);

  useEffect(() => {
    if (!focusedRoomId || filteredRows.length === 0) return;

    const focusedIndex = filteredRows.findIndex((row) => row.room_id === focusedRoomId);
    if (focusedIndex < 0) return;

    const focusedPage = Math.floor(focusedIndex / pageSize) + 1;
    if (currentPage !== focusedPage) {
      setCurrentPage(focusedPage);
      return;
    }

    const timer = setTimeout(() => {
      const targetRow = document.querySelector<HTMLTableRowElement>(`[data-room-row-id="${focusedRoomId}"]`);
      targetRow?.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => setFocusedRoomId(null), 3600);
    }, 180);

    return () => clearTimeout(timer);
  }, [currentPage, filteredRows, focusedRoomId, pageSize, setCurrentPage]);

  const summary = useMemo(() => {
    const total = filteredRows.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
    const bankReceived = filteredRows
      .filter((row) => row.payment_method === "bank_transfer" && ["bank_paid", "partial_paid"].includes(row.payment_status))
      .reduce((sum, row) => sum + getReceivedAmount(row), 0);
    const cashReceived = filteredRows
      .filter((row) => row.payment_status === "cash_paid")
      .reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
    const received = bankReceived + cashReceived;
    const unpaidRows = filteredRows.filter((row) => getUnpaidBalance(row) > 0);
    return {
      total,
      received,
      unpaid: filteredRows.reduce((sum, row) => sum + getUnpaidBalance(row), 0),
      bankReceived,
      cashReceived,
      unpaidCount: unpaidRows.length
    };
  }, [filteredRows]);

  function ensureMonthUnlocked() {
    if (!monthLock) return true;
    setError(`${month} 已月結鎖定，請先解除月結再修改帳單。`);
    return false;
  }

  async function lockMonth() {
    if (!supabase || !canManageEverything(role)) return;
    const confirmed = window.confirm(`確定將 ${month} 月結鎖定？鎖定後不能再修改本月帳單，除非先解除月結。`);
    if (!confirmed) return;

    setError("");
    setNotice("");
    const billMonth = monthInputToBillMonth(month);
    const { data: userData } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from("monthly_locks").insert({
      bill_month: billMonth,
      locked_by: userData.user?.id ?? null
    });

    if (insertError) {
      setError(insertError.message);
      return;
    }

    await logAuditAction(supabase, {
      action: "lock_month",
      target_table: "monthly_locks",
      target_id: billMonth,
      bill_month: billMonth,
      detail: { month }
    });
    await loadBills();
    setNotice(`${month} 已月結鎖定。`);
  }

  async function unlockMonth() {
    if (!supabase || !canManageEverything(role)) return;
    const confirmed = window.confirm(`確定解除 ${month} 月結？解除後可以再次修改本月帳單。`);
    if (!confirmed) return;

    setError("");
    setNotice("");
    const billMonth = monthInputToBillMonth(month);
    const { error: deleteError } = await supabase
      .from("monthly_locks")
      .delete()
      .eq("bill_month", billMonth);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    await logAuditAction(supabase, {
      action: "unlock_month",
      target_table: "monthly_locks",
      target_id: billMonth,
      bill_month: billMonth,
      detail: { month }
    });
    await loadBills();
    setNotice(`${month} 已解除月結。`);
  }

  async function confirmCashPayment(bill: DashboardBill) {
    if (!supabase) return;
    if (!ensureMonthUnlocked()) return;
    const paidDate = todayString();
    const previousBill = bill;

    setError("");
    setNotice("");
    setRowSyncedIds((current) => {
      const next = new Set(current);
      next.delete(bill.id);
      return next;
    });
    localMutationIdsRef.current.add(bill.id);
    setRowSyncingIds((current) => new Set(current).add(bill.id));
    setRows((currentRows) =>
      currentRows.map((row) =>
        row.id === bill.id
          ? {
              ...row,
              payment_method: "cash",
              payment_status: "cash_paid",
              paid_date: paidDate
            }
          : row
      )
    );

    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        payment_method: "cash",
        payment_status: "cash_paid",
        paid_date: paidDate
      })
      .eq("id", bill.id);

    if (updateError) {
      replaceOneRow(previousBill);
      setError(updateError.message);
      setRowSyncingIds((current) => {
        const next = new Set(current);
        next.delete(bill.id);
        return next;
      });
      localMutationIdsRef.current.delete(bill.id);
      return;
    }

    const { data: refreshedBill } = await supabase
      .from("monthly_bills")
      .select("*, rooms(*), contracts(*, tenants(*))")
      .eq("id", bill.id)
      .single();

    if (refreshedBill) {
      replaceOneRow(normalizeBillRows([refreshedBill])[0]);
    }

    await logAuditAction(supabase, {
      action: "confirm_cash_payment",
      target_table: "monthly_bills",
      target_id: bill.id,
      bill_month: bill.bill_month,
      room_id: bill.room_id,
      detail: {
        room_number: bill.rooms?.room_number ?? null,
        total_amount: bill.total_amount
      }
    });
    setRowSyncingIds((current) => {
      const next = new Set(current);
      next.delete(bill.id);
      return next;
    });
    setRowSyncedIds((current) => new Set(current).add(bill.id));
    setNotice("已同步");
    setTimeout(() => {
      setRowSyncedIds((current) => {
        const next = new Set(current);
        next.delete(bill.id);
        return next;
      });
      localMutationIdsRef.current.delete(bill.id);
    }, 2200);
  }

  async function resetPaymentStatus(bill: DashboardBill) {
    if (!supabase || !canManageEverything(role)) return;
    if (!ensureMonthUnlocked()) return;
    const roomNumber = bill.rooms?.room_number ?? "此房號";
    const confirmed = window.confirm(`確定將 ${roomNumber} 本月收款狀態撤回為未收？繳款日、匯款後五碼與匯款金額會一起清除。`);
    if (!confirmed) return;

    setError("");
    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        payment_method: "none",
        payment_status: "unpaid",
        paid_date: null,
        transfer_last5: null,
        transfer_amount: null
      })
      .eq("id", bill.id);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    await logAuditAction(supabase, {
      action: "reset_payment_status",
      target_table: "monthly_bills",
      target_id: bill.id,
      bill_month: bill.bill_month,
      room_id: bill.room_id,
      detail: {
        room_number: bill.rooms?.room_number ?? null,
        previous_payment_method: bill.payment_method,
        previous_payment_status: bill.payment_status
      }
    });
    await loadBills();
  }

  async function updateElectricityFee(bill: DashboardBill, value: string) {
    if (!supabase || !canManageEverything(role)) return;
    if (!ensureMonthUnlocked()) return;
    const nextElectricityFee = Number(value) || 0;
    if (nextElectricityFee === Number(bill.electricity_fee ?? 0)) return;

    setSavingBillId(bill.id);
    setError("");

    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        electricity_fee: nextElectricityFee,
        total_amount: calculateBillTotal({ ...bill, electricity_fee: nextElectricityFee })
      })
      .eq("id", bill.id);

    if (updateError) {
      setError(updateError.message);
      setSavingBillId(null);
      return;
    }

    await logAuditAction(supabase, {
      action: "update_electricity_fee",
      target_table: "monthly_bills",
      target_id: bill.id,
      bill_month: bill.bill_month,
      room_id: bill.room_id,
      detail: {
        room_number: bill.rooms?.room_number ?? null,
        previous_value: Number(bill.electricity_fee ?? 0),
        next_value: nextElectricityFee
      }
    });
    await loadBills();
    setSavingBillId(null);
  }

  async function updateWaterCommonElectricityFee(bill: DashboardBill, value: string) {
    if (!supabase || !canManageEverything(role)) return;
    if (!ensureMonthUnlocked()) return;
    const nextWaterCommonElectricityFee = Number(value) || 0;
    if (nextWaterCommonElectricityFee === Number(bill.water_common_electricity_fee ?? 0)) return;

    setSavingBillId(bill.id);
    setError("");

    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        water_common_electricity_fee: nextWaterCommonElectricityFee,
        total_amount: calculateBillTotal({ ...bill, water_common_electricity_fee: nextWaterCommonElectricityFee })
      })
      .eq("id", bill.id);

    if (updateError) {
      setError(updateError.message);
      setSavingBillId(null);
      return;
    }

    await logAuditAction(supabase, {
      action: "update_water_common_electricity_fee",
      target_table: "monthly_bills",
      target_id: bill.id,
      bill_month: bill.bill_month,
      room_id: bill.room_id,
      detail: {
        room_number: bill.rooms?.room_number ?? null,
        previous_value: Number(bill.water_common_electricity_fee ?? 0),
        next_value: nextWaterCommonElectricityFee
      }
    });
    await loadBills();
    setSavingBillId(null);
  }

  async function updateMiscFee(bill: DashboardBill, value: string) {
    if (!supabase || !canManageEverything(role)) return;
    if (!ensureMonthUnlocked()) return;
    const nextMiscFee = Number(value) || 0;
    if (nextMiscFee === Number(bill.misc_fee ?? 0)) return;

    setSavingBillId(bill.id);
    setError("");

    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        misc_fee: nextMiscFee,
        total_amount: calculateBillTotal({ ...bill, misc_fee: nextMiscFee })
      })
      .eq("id", bill.id);

    if (updateError) {
      setError(updateError.message);
      setSavingBillId(null);
      return;
    }

    await logAuditAction(supabase, {
      action: "update_misc_fee",
      target_table: "monthly_bills",
      target_id: bill.id,
      bill_month: bill.bill_month,
      room_id: bill.room_id,
      detail: {
        room_number: bill.rooms?.room_number ?? null,
        previous_value: Number(bill.misc_fee ?? 0),
        next_value: nextMiscFee
      }
    });
    await loadBills();
    setSavingBillId(null);
  }

  async function generateMonthlyBills(options: { silent?: boolean } = {}) {
    if (!supabase) return;
    if (!ensureMonthUnlocked()) return;

    setLoading(true);
    setError("");
    if (!options.silent) {
      setNotice("");
    }

    const billMonth = monthInputToBillMonth(month);
    const [
      { data: contractData, error: contractError },
      { data: billData, error: billError },
      { data: roomData, error: roomError }
    ] = await Promise.all([
      supabase
        .from("contracts")
        .select("*, tenants(*), rooms(*)")
        .eq("status", "active"),
      supabase
        .from("monthly_bills")
        .select("room_id")
        .eq("bill_month", billMonth),
      supabase
        .from("rooms")
        .select("*")
        .neq("status", "disabled")
    ]);

    if (contractError || billError || roomError) {
      setError(contractError?.message ?? billError?.message ?? roomError?.message ?? "產生帳單失敗。");
      setLoading(false);
      return;
    }

    const existingRoomIds = new Set((billData ?? []).map((bill) => bill.room_id as string));
    const activeContracts = normalizeActiveContracts(contractData as unknown[] | null);
    const activeContractRoomIds = new Set(
      activeContracts
        .filter((contract) => isMonthWithinContract(billMonth, contract))
        .map((contract) => contract.room_id)
    );
    const activeContractBillsToInsert = activeContracts
      .filter((contract) => contract.rooms && isMonthWithinContract(billMonth, contract) && !existingRoomIds.has(contract.room_id))
      .map((contract) => createContractBillPayload(contract, billMonth));
    const vacantBillsToInsert = ((roomData ?? []) as Room[])
      .filter((room) => !existingRoomIds.has(room.id) && !activeContractRoomIds.has(room.id))
      .map((room) => createVacantBillPayload(room.id, billMonth));
    const billsToInsert = [...activeContractBillsToInsert, ...vacantBillsToInsert];

    if (billsToInsert.length > 0) {
      const { error: insertError } = await supabase.from("monthly_bills").insert(billsToInsert);
      if (insertError) {
        setError(insertError.message);
        setLoading(false);
        return;
      }
    }

    await loadBills();
    await logAuditAction(supabase, {
      action: "generate_monthly_bills",
      target_table: "monthly_bills",
      bill_month: billMonth,
      detail: {
        month,
        inserted_count: billsToInsert.length
      }
    });
    if (!options.silent || billsToInsert.length > 0) {
      setNotice(`已產生 ${billsToInsert.length} 筆 ${month} 帳單；既有帳單未覆蓋。`);
    }
    setLoading(false);
  }

  async function rebuildRoomMonthlyBill(row: DashboardBill) {
    if (!supabase) return;
    if (!ensureMonthUnlocked()) return;
    const billMonth = monthInputToBillMonth(month);
    const roomNumber = row.rooms?.room_number ?? "此房號";
    const confirmed = window.confirm(
      `確定更新 ${month} ${roomNumber} 的帳單？會刪除這一間本月原帳單，重新依目前租約產生。`
    );
    if (!confirmed) return;

    setLoading(true);
    setError("");
    setNotice("");

    const { error: deleteError } = await supabase
      .from("monthly_bills")
      .delete()
      .eq("id", row.id);

    if (deleteError) {
      setError(deleteError.message);
      setLoading(false);
      return;
    }

    const { data: contractData, error: contractError } = await supabase
      .from("contracts")
      .select("*, tenants(*)")
      .eq("room_id", row.room_id)
      .eq("status", "active")
      .order("start_date", { ascending: false })
      .limit(1);

    if (contractError) {
      setError(contractError.message);
      setLoading(false);
      return;
    }

    const activeContract = normalizeActiveContracts(contractData as unknown[] | null)[0];
    const payload = activeContract && isMonthWithinContract(billMonth, activeContract)
      ? createContractBillPayload(activeContract, billMonth)
      : createVacantBillPayload(row.room_id, billMonth);

    const { error: insertError } = await supabase.from("monthly_bills").insert(payload);
    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    await loadBills();
    await logAuditAction(supabase, {
      action: "update_room_bill",
      target_table: "monthly_bills",
      target_id: row.id,
      bill_month: billMonth,
      room_id: row.room_id,
      detail: {
        room_number: row.rooms?.room_number ?? null
      }
    });
    setNotice(`已更新 ${month} ${roomNumber} 帳單。`);
    setLoading(false);
  }

  async function clearMonthlyBills() {
    if (!supabase) return;
    if (!ensureMonthUnlocked()) return;
    const confirmed = window.confirm(
      `確定清除 ${month} 全部帳單？這會刪除本月所有房間的帳單資料，清除後可重新按「產生本月帳單」。`
    );
    if (!confirmed) return;

    setLoading(true);
    setError("");
    setNotice("");

    const billMonth = monthInputToBillMonth(month);

    const { data: deletedBills, error: deleteError } = await supabase
      .from("monthly_bills")
      .delete()
      .eq("bill_month", billMonth)
      .select("id");

    if (deleteError) {
      setError(deleteError.message);
      setLoading(false);
      return;
    }

    await loadBills();
    await logAuditAction(supabase, {
      action: "clear_monthly_bills",
      target_table: "monthly_bills",
      bill_month: billMonth,
      detail: {
        month,
        deleted_count: deletedBills?.length ?? 0
      }
    });
    setNotice(`已清除 ${deletedBills?.length ?? 0} 筆 ${month} 帳單，可重新按「產生本月帳單」。`);
    setLoading(false);
  }

  function exportMonthlyReconciliation() {
    const sortedRows = [...rows].sort((a, b) => {
      const buildingCompare = getRoomBuilding(a.rooms).localeCompare(getRoomBuilding(b.rooms), "zh-Hant");
      if (buildingCompare !== 0) return buildingCompare;
      return String(a.rooms?.room_number ?? "").localeCompare(String(b.rooms?.room_number ?? ""), "zh-Hant", { numeric: true });
    });

    const totals = sortedRows.reduce(
      (sum, row) => {
        const totalAmount = Number(row.total_amount ?? 0);
        const bankAmount = row.payment_method === "bank_transfer" && ["bank_paid", "partial_paid"].includes(row.payment_status)
          ? getReceivedAmount(row)
          : 0;
        const cashAmount = row.payment_status === "cash_paid" ? totalAmount : 0;
        const unpaidBalance = getUnpaidBalance(row);
        return {
          total: sum.total + totalAmount,
          bank: sum.bank + bankAmount,
          cash: sum.cash + cashAmount,
          unpaid: sum.unpaid + unpaidBalance,
          unpaidCount: unpaidBalance > 0 ? sum.unpaidCount + 1 : sum.unpaidCount
        };
      },
      { total: 0, bank: 0, cash: 0, unpaid: 0, unpaidCount: 0 }
    );

    const summarySheet = XLSX.utils.aoa_to_sheet([
      ["每月收租對帳單"],
      ["月份", month],
      ["匯出時間", new Date().toLocaleString("zh-TW")],
      [],
      ["項目", "金額/數量"],
      ["本月應繳總額", totals.total],
      ["已收總額", totals.bank + totals.cash],
      ["未收總額", totals.unpaid],
      ["匯款已收", totals.bank],
      ["現金已收", totals.cash],
      ["未繳間數", totals.unpaidCount],
      ["帳單筆數", sortedRows.length]
    ]);

    const detailRows = sortedRows.map((row) => ({
      月份: row.bill_month.slice(0, 7),
      棟別: getRoomBuilding(row.rooms) || "未設定",
      房號: row.rooms?.room_number ?? "",
      租客: row.contracts?.tenants?.name ?? (row.payment_status === "vacant" || row.note === "空房" ? "未出租" : ""),
      房租: Number(row.rent_amount ?? 0),
      "清潔/車位": Number(row.recurring_fee ?? 0),
      電費: Number(row.electricity_fee ?? 0),
      "水費/公電": Number(row.water_common_electricity_fee ?? 0),
      其他: Number(row.misc_fee ?? 0),
      當月應繳總額: Number(row.total_amount ?? 0),
      付款方式: PAYMENT_METHOD_LABELS[row.payment_method],
      狀態: PAYMENT_STATUS_LABELS[row.payment_status],
      繳款日: row.paid_date ?? "",
      匯款後五碼: row.transfer_last5 ?? "",
      匯款金額: row.transfer_amount ?? "",
      備註: row.note ?? ""
    }));

    const detailSheet = XLSX.utils.json_to_sheet(detailRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, summarySheet, "對帳摘要");
    XLSX.utils.book_append_sheet(workbook, detailSheet, "明細");
    XLSX.writeFile(workbook, `套房租金對帳單-${month}.xlsx`);
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h1>每月收租表</h1>
          <p>主界面只保留收租必要資訊，合約、押金、修繕與歷史資料放在詳情頁。</p>
        </div>
        <div className="toolbar">
          {canManageEverything(role) ? (
            <>
              <button className="button" type="button" onClick={() => generateMonthlyBills()} disabled={loading || Boolean(monthLock)}>
                產生本月帳單
              </button>
              <button className="secondary-button" type="button" onClick={clearMonthlyBills} disabled={loading || Boolean(monthLock)}>
                清除本月帳單
              </button>
              {monthLock ? (
                <button className="secondary-button" type="button" onClick={unlockMonth} disabled={loading}>
                  <Unlock size={17} />
                  解除月結
                </button>
              ) : (
                <button className="secondary-button" type="button" onClick={lockMonth} disabled={loading}>
                  <Lock size={17} />
                  月結鎖定
                </button>
              )}
            </>
          ) : null}
          <button className="secondary-button" type="button" onClick={() => loadBills({ background: rows.length > 0, reason: "manual" })}>
            <RefreshCw size={17} />
            重新整理
          </button>
          <button className="secondary-button" type="button" onClick={exportMonthlyReconciliation} disabled={loading || rows.length === 0}>
            <Download size={17} />
            匯出本月對帳單
          </button>
          {syncStatus !== "idle" ? (
            <span className={`sync-pill sync-${syncStatus}`}>{syncMessage}</span>
          ) : null}
        </div>
      </div>

      <div className="dashboard-building-switch">
        <span className="building-switch-label">棟別</span>
        {shouldUseBuildingSelect ? (
          <select
            id="building"
            className="select compact-building-select"
            value={building}
            onChange={(event) => setBuilding(event.target.value)}
            aria-label="棟別"
          >
            {buildingFilterOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label} ({item.count})
              </option>
            ))}
          </select>
        ) : (
          <div className="segmented-control building-segments" role="group" aria-label="棟別">
            {buildingFilterOptions.map((item) => (
              <button
                key={item.value}
                className={`segmented-button${building === item.value ? " is-active" : ""}`}
                type="button"
                onClick={() => setBuilding(item.value)}
                aria-pressed={building === item.value}
              >
                <span>{item.label}</span>
                <span className="segment-count">{item.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="filter-bar dashboard-filter-bar">
        <div className="field">
          <label htmlFor="month">目前月份</label>
          <input id="month" className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="status">狀態</label>
          <select id="status" className="select" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            <option value="all">全部狀態</option>
            {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="field search-field">
          <label htmlFor="keyword">搜尋</label>
          <Search size={17} />
          <input
            id="keyword"
            className="input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="房號或租客姓名"
          />
        </div>
      </div>

      <div className="summary-grid">
        <SummaryCard label="本月應繳總額" value={formatCurrency(summary.total)} />
        <SummaryCard label="已收總額" value={formatCurrency(summary.received)} />
        <SummaryCard label="未收總額" value={formatCurrency(summary.unpaid)} />
        <SummaryCard label="匯款已收" value={formatCurrency(summary.bankReceived)} />
        <SummaryCard label="現金已收" value={formatCurrency(summary.cashReceived)} />
        <SummaryCard label="未繳間數" value={`${summary.unpaidCount} 間`} />
      </div>

      {monthLock ? (
        <div className="notice" style={{ marginBottom: 14 }}>
          {month} 已月結鎖定，帳單不能修改；匯出對帳單仍可使用。
        </div>
      ) : null}
      {notice ? <div className="notice" style={{ marginBottom: 14 }}>{notice}</div> : null}
      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="table-shell dashboard-table-shell">
        <table className="data-table dashboard-table">
          <colgroup>
            <col className="dashboard-col-room" />
            <col className="dashboard-col-tenant" />
            <col className="dashboard-col-money" />
            <col className="dashboard-col-fixed-fee" />
            <col className="dashboard-col-input-fee" />
            <col className="dashboard-col-water" />
            <col className="dashboard-col-input-fee" />
            <col className="dashboard-col-total" />
            <col className="dashboard-col-status" />
            <col className="dashboard-col-date" />
            <col className="dashboard-col-note" />
            <col className="dashboard-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="dashboard-sticky-room">房號</th>
              <th className="dashboard-sticky-tenant">租客</th>
              <th className="number-cell">房租</th>
              <th className="number-cell">清潔/車位</th>
              <th className="number-cell">電費</th>
              <th className="number-cell">水費/公電</th>
              <th className="number-cell">其他</th>
              <th className="number-cell dashboard-total-cell">當月應繳總額</th>
              <th className="dashboard-status-cell">狀態</th>
              <th>繳款日</th>
              <th>備註</th>
              <th>詳情</th>
            </tr>
          </thead>
          <tbody>
            {initialLoading && rows.length === 0 ? (
              <tr>
                <td colSpan={12}>載入中...</td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={12}>本月尚未建立帳單，請按「產生本月帳單」。</td>
              </tr>
            ) : (
              paginatedRows.map((row) => (
                <tr
                  key={row.id}
                  data-room-row-id={row.room_id}
                  className={
                    [
                      row.payment_status === "cash_paid" ? "row-cash-paid" : "",
                      row.payment_status === "bank_paid" ? "row-bank-paid" : "",
                      focusedRoomId === row.room_id ? "row-focus-highlight" : ""
                    ].filter(Boolean).join(" ") || undefined
                  }
                >
                  <td className="dashboard-sticky-room">
                    <strong>{row.rooms?.room_number ?? "-"}</strong>
                    <div className="muted">{getRoomBuilding(row.rooms) || "未設定棟別"}</div>
                  </td>
                  <td
                    className="dashboard-sticky-tenant dashboard-tenant-cell"
                    title={row.contracts?.tenants?.name ?? undefined}
                  >
                    {row.contracts?.tenants?.name ?? (row.payment_status === "vacant" || row.note === "空房" ? "未出租" : "-")}
                  </td>
                  <td className="number-cell">{formatCurrency(row.rent_amount)}</td>
                  <td className="number-cell">{formatCurrency(row.recurring_fee ?? 0)}</td>
                  <td className="number-cell dashboard-input-cell">
                    {canManageEverything(role) ? (
                      <input
                        className="input table-number-input"
                        type="number"
                        defaultValue={Number(row.electricity_fee ?? 0)}
                        disabled={savingBillId === row.id || Boolean(monthLock)}
                        onBlur={(event) => updateElectricityFee(row, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      formatCurrency(row.electricity_fee)
                    )}
                  </td>
                  <td className="number-cell dashboard-input-cell">
                    {canManageEverything(role) ? (
                      <input
                        className="input table-number-input"
                        type="number"
                        defaultValue={Number(row.water_common_electricity_fee ?? 0)}
                        disabled={savingBillId === row.id || Boolean(monthLock)}
                        onBlur={(event) => updateWaterCommonElectricityFee(row, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      formatCurrency(row.water_common_electricity_fee ?? 0)
                    )}
                  </td>
                  <td className="number-cell dashboard-input-cell">
                    {canManageEverything(role) ? (
                      <input
                        className="input table-number-input"
                        type="number"
                        defaultValue={Number(row.misc_fee ?? 0)}
                        disabled={savingBillId === row.id || Boolean(monthLock)}
                        onBlur={(event) => updateMiscFee(row, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      formatCurrency(row.misc_fee)
                    )}
                  </td>
                  <td className="number-cell dashboard-total-cell">{formatCurrency(row.total_amount)}</td>
                  <td className="dashboard-status-cell"><PaymentStatusBadge status={row.payment_status} /></td>
                  <td>{formatDate(row.paid_date)}</td>
                  <td className="dashboard-note-cell">
                    <span className="note-preview" title={row.note || undefined}>
                      {row.note || "-"}
                    </span>
                  </td>
                  <td className="dashboard-actions-cell">
                    <div className="toolbar">
                      <Link className="icon-button" href={`/rooms/${row.room_id}${currentDashboardParams ? `?return=${encodeURIComponent(`/dashboard?${currentDashboardParams}`)}` : ""}`} title="詳情">
                        <Eye size={17} />
                      </Link>
                      {canManageEverything(role) && !monthLock ? (
                        <button className="icon-button" type="button" onClick={() => rebuildRoomMonthlyBill(row)} title="更新">
                          <RotateCcw size={17} />
                        </button>
                      ) : null}
                      {canRegisterBankTransfer(role) && row.payment_method !== "cash" && !monthLock ? (
                        <button className="icon-button" type="button" onClick={() => setBankBill(row)} title="登記匯款">
                          <Landmark size={17} />
                        </button>
                      ) : null}
                      {canConfirmCash(role) && (row.payment_status !== "cash_paid" || rowSyncingIds.has(row.id)) && row.payment_status !== "vacant" && !monthLock ? (
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => confirmCashPayment(row)}
                          title={rowSyncingIds.has(row.id) ? "同步中..." : "確認收到現金"}
                          disabled={rowSyncingIds.has(row.id)}
                        >
                          <Banknote size={17} />
                        </button>
                      ) : null}
                      {rowSyncingIds.has(row.id) ? <span className="row-sync-text">同步中...</span> : null}
                      {rowSyncedIds.has(row.id) ? <span className="row-sync-text synced">已同步</span> : null}
                      {canManageEverything(role) && !["unpaid", "vacant", "rent_prepaid"].includes(row.payment_status) && !monthLock ? (
                        <button className="icon-button" type="button" onClick={() => resetPaymentStatus(row)} title="撤回為未收">
                          <Undo2 size={17} />
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

      {filteredRows.length > 0 ? (
        <DashboardPaginationControls
          currentPage={currentPage}
          endItem={endItem}
          pageSize={pageSize}
          setCurrentPage={setCurrentPage}
          setPageSize={setPageSize}
          startItem={startItem}
          totalItems={totalItems}
          totalPages={totalPages}
        />
      ) : null}

      {bankBill ? (
        <BankTransferDialog
          bill={bankBill}
          onClose={() => setBankBill(null)}
          onSaved={async () => {
            setBankBill(null);
            await loadBills();
          }}
        />
      ) : null}
    </>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DashboardPaginationControls({
  currentPage,
  endItem,
  pageSize,
  setCurrentPage,
  setPageSize,
  startItem,
  totalItems,
  totalPages
}: {
  currentPage: number;
  endItem: number;
  pageSize: number;
  setCurrentPage: (page: number) => void;
  setPageSize: (size: number) => void;
  startItem: number;
  totalItems: number;
  totalPages: number;
}) {
  return (
    <div className="pagination-bar">
      <div className="pagination-meta">
        顯示 {startItem}-{endItem} 筆，共 {totalItems} 筆
      </div>
      <div className="toolbar">
        <label className="pagination-size">
          每頁
          <select className="select compact-select" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </label>
        <button className="icon-button" type="button" onClick={() => setCurrentPage(1)} disabled={currentPage <= 1} title="第一頁">
          <ChevronsLeft size={17} />
        </button>
        <button className="icon-button" type="button" onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} title="上一頁">
          <ChevronLeft size={17} />
        </button>
        <span className="pagination-page">
          第 {currentPage} / {totalPages} 頁
        </span>
        <button className="icon-button" type="button" onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages} title="下一頁">
          <ChevronRight size={17} />
        </button>
        <button className="icon-button" type="button" onClick={() => setCurrentPage(totalPages)} disabled={currentPage >= totalPages} title="最後一頁">
          <ChevronsRight size={17} />
        </button>
      </div>
    </div>
  );
}

function BankTransferDialog({
  bill,
  onClose,
  onSaved
}: {
  bill: DashboardBill;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [paidDate, setPaidDate] = useState(bill.paid_date ?? todayString());
  const [last5, setLast5] = useState(bill.transfer_last5 ?? "");
  const [amount, setAmount] = useState(String(bill.transfer_amount ?? bill.total_amount ?? ""));
  const [note, setNote] = useState(bill.note ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveTransfer(event: FormEvent<HTMLFormElement>, finalStatus: PaymentStatus) {
    event.preventDefault();
    if (!supabase) return;

    setSaving(true);
    setError("");
    const numericAmount = Number(amount) || 0;
    const totalAmount = Number(bill.total_amount ?? 0);
    if (finalStatus === "partial_paid" && (numericAmount <= 0 || numericAmount >= totalAmount)) {
      setError("部分收款金額需大於 0 且小於當月應繳總額。");
      setSaving(false);
      return;
    }

    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        payment_method: "bank_transfer",
        payment_status: finalStatus,
        paid_date: paidDate || null,
        transfer_last5: last5 || null,
        transfer_amount: numericAmount || null,
        note: note || null
      })
      .eq("id", bill.id);

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    await logAuditAction(supabase, {
      action: "register_bank_transfer",
      target_table: "monthly_bills",
      target_id: bill.id,
      bill_month: bill.bill_month,
      room_id: bill.room_id,
      detail: {
        room_number: bill.rooms?.room_number ?? null,
        payment_status: finalStatus,
        paid_date: paidDate || null,
        transfer_last5: last5 || null,
        transfer_amount: numericAmount || null
      }
    });
    await onSaved();
  }

  return (
    <Modal title="登記匯款" onClose={onClose}>
      <form onSubmit={(event) => saveTransfer(event, "pending")}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field">
              <label>房號</label>
              <input className="input" value={bill.rooms?.room_number ?? ""} disabled />
            </div>
            <div className="form-field">
              <label>當月應繳總額</label>
              <input className="input" value={formatCurrency(bill.total_amount)} disabled />
            </div>
            <div className="form-field">
              <label htmlFor="paid-date">匯款日期</label>
              <input id="paid-date" className="input" type="date" value={paidDate} onChange={(event) => setPaidDate(event.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="last5">匯款後五碼</label>
              <input id="last5" className="input" value={last5} maxLength={5} onChange={(event) => setLast5(event.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="transfer-amount">匯款金額</label>
              <input id="transfer-amount" className="input" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </div>
            <div className="form-field full">
              <label htmlFor="transfer-note">備註</label>
              <textarea id="transfer-note" className="textarea" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          </div>
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="secondary-button" type="submit" disabled={saving}>
            存為待確認
          </button>
          <button className="secondary-button" type="button" disabled={saving} onClick={(event) => saveTransfer(event as unknown as FormEvent<HTMLFormElement>, "partial_paid")}>
            部分收款
          </button>
          <button className="button" type="button" disabled={saving} onClick={(event) => saveTransfer(event as unknown as FormEvent<HTMLFormElement>, "bank_paid")}>
            確認到帳
          </button>
        </div>
      </form>
    </Modal>
  );
}


