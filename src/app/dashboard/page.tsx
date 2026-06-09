"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as XLSX from "xlsx";
import { Banknote, Download, Eye, Landmark, Lock, RefreshCw, RotateCcw, Search, Undo2, Unlock } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { Modal } from "@/components/Modal";
import { PaymentMethodBadge, PaymentStatusBadge } from "@/components/StatusBadge";
import { logAuditAction } from "@/lib/audit";
import { formatCurrency, formatDate, getCurrentMonthInputValue, monthInputToBillMonth, todayString } from "@/lib/format";
import { canConfirmCash, canManageEverything, canRegisterBankTransfer, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/permissions";
import { getRoomBuilding } from "@/lib/rooms";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ContractWithTenant, DashboardBill, MonthlyLock, PaymentMethod, PaymentStatus, RentPaymentCycle, Room, Role } from "@/lib/types";

type StatusFilter = "all" | PaymentStatus;
type MethodFilter = "all" | PaymentMethod;

interface MonthlyBillInsertPayload {
  room_id: string;
  contract_id: string | null;
  bill_month: string;
  rent_amount: number;
  recurring_fee: number;
  electricity_fee: number;
  misc_fee: number;
  total_amount: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  paid_date: string | null;
  note: string | null;
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
      contracts: Array.isArray(row.contracts) ? row.contracts[0] ?? null : row.contracts ?? null
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

function isPaymentMethod(value: string | null): value is PaymentMethod {
  return Boolean(value && value in PAYMENT_METHOD_LABELS);
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

function createVacantBillPayload(roomId: string, billMonth: string): MonthlyBillInsertPayload {
  return {
    room_id: roomId,
    contract_id: null,
    bill_month: billMonth,
    rent_amount: 0,
    recurring_fee: 0,
    electricity_fee: 0,
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
  const methodParam = searchParams.get("method");
  const [month, setMonth] = useState(searchParams.get("month") || getCurrentMonthInputValue());
  const [building, setBuilding] = useState(searchParams.get("building") || "all");
  const [status, setStatus] = useState<StatusFilter>(isPaymentStatus(statusParam) ? statusParam : "all");
  const [method, setMethod] = useState<MethodFilter>(isPaymentMethod(methodParam) ? methodParam : "all");
  const [keyword, setKeyword] = useState(searchParams.get("keyword") || "");
  const [rows, setRows] = useState<DashboardBill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bankBill, setBankBill] = useState<DashboardBill | null>(null);
  const [savingBillId, setSavingBillId] = useState<string | null>(null);
  const [monthLock, setMonthLock] = useState<MonthlyLock | null>(null);

  const loadBills = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
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
      setRows([]);
      setLoading(false);
      return;
    }

    const { data, error: queryError } = await supabase
      .from("monthly_bills")
      .select("*, rooms(*), contracts(*, tenants(*))")
      .eq("bill_month", billMonth);

    if (queryError) {
      setError(queryError.message);
      setRows([]);
    } else {
      let normalizedRows = normalizeBillRows(data as unknown[] | null);
      const existingRoomIds = new Set(normalizedRows.map((bill) => bill.room_id));

      if (currentMonthLock) {
        normalizedRows = normalizedRows.sort((a, b) => {
          const buildingCompare = getRoomBuilding(a.rooms).localeCompare(getRoomBuilding(b.rooms), "zh-Hant");
          if (buildingCompare !== 0) return buildingCompare;
          return String(a.rooms?.room_number ?? "").localeCompare(String(b.rooms?.room_number ?? ""), "zh-Hant", {
            numeric: true
          });
        });
        setRows(normalizedRows);
        setLoading(false);
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
        setRows([]);
        setLoading(false);
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
          setRows([]);
          setLoading(false);
          return;
        }

        const { data: refreshedData, error: refreshedError } = await supabase
          .from("monthly_bills")
          .select("*, rooms(*), contracts(*, tenants(*))")
          .eq("bill_month", billMonth);

        if (refreshedError) {
          setError(refreshedError.message);
          setRows([]);
          setLoading(false);
          return;
        }

        normalizedRows = normalizeBillRows(refreshedData as unknown[] | null);
      }

      normalizedRows = normalizedRows.sort((a, b) => {
        const buildingCompare = getRoomBuilding(a.rooms).localeCompare(getRoomBuilding(b.rooms), "zh-Hant");
        if (buildingCompare !== 0) return buildingCompare;
        return String(a.rooms?.room_number ?? "").localeCompare(String(b.rooms?.room_number ?? ""), "zh-Hant", {
          numeric: true
        });
      });
      setRows(normalizedRows);
    }

    setLoading(false);
  }, [month, supabase]);

  useEffect(() => {
    void loadBills();
  }, [loadBills]);

  useEffect(() => {
    const nextParams = new URLSearchParams();
    if (month) nextParams.set("month", month);
    if (building !== "all") nextParams.set("building", building);
    if (status !== "all") nextParams.set("status", status);
    if (method !== "all") nextParams.set("method", method);
    if (keyword.trim()) nextParams.set("keyword", keyword.trim());

    const nextUrl = nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname;
    const currentUrl = searchParams.toString() ? `${pathname}?${searchParams.toString()}` : pathname;
    if (nextUrl !== currentUrl) {
      router.replace(nextUrl, { scroll: false });
    }
  }, [building, keyword, method, month, pathname, router, searchParams, status]);

  const currentDashboardParams = useMemo(() => {
    const params = new URLSearchParams();
    if (month) params.set("month", month);
    if (building !== "all") params.set("building", building);
    if (status !== "all") params.set("status", status);
    if (method !== "all") params.set("method", method);
    if (keyword.trim()) params.set("keyword", keyword.trim());
    return params.toString();
  }, [building, keyword, method, month, status]);

  const buildings = useMemo(() => {
    const unique = new Set(rows.map((row) => getRoomBuilding(row.rooms)).filter(Boolean));
    return Array.from(unique).sort((a, b) => String(a).localeCompare(String(b), "zh-Hant"));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const loweredKeyword = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      const tenantName = row.contracts?.tenants?.name ?? "";
      const roomNumber = row.rooms?.room_number ?? "";
      const matchBuilding = building === "all" || getRoomBuilding(row.rooms) === building;
      const matchStatus = status === "all" || row.payment_status === status;
      const matchMethod = method === "all" || row.payment_method === method;
      const matchKeyword =
        loweredKeyword.length === 0 ||
        tenantName.toLowerCase().includes(loweredKeyword) ||
        roomNumber.toLowerCase().includes(loweredKeyword);
      return matchBuilding && matchStatus && matchMethod && matchKeyword;
    });
  }, [building, keyword, method, rows, status]);

  const summary = useMemo(() => {
    const total = filteredRows.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
    const bankReceived = filteredRows
      .filter((row) => row.payment_status === "bank_paid")
      .reduce((sum, row) => sum + Number(row.transfer_amount ?? row.total_amount ?? 0), 0);
    const cashReceived = filteredRows
      .filter((row) => row.payment_status === "cash_paid")
      .reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
    const received = bankReceived + cashReceived;
    const unpaidRows = filteredRows.filter((row) => row.payment_status !== "vacant" && Number(row.total_amount ?? 0) > 0 && !["bank_paid", "cash_paid"].includes(row.payment_status));
    return {
      total,
      received,
      unpaid: total - received,
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
    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        payment_method: "cash",
        payment_status: "cash_paid",
        paid_date: todayString()
      })
      .eq("id", bill.id);

    if (updateError) {
      setError(updateError.message);
      return;
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
    await loadBills();
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
        total_amount: Number(bill.rent_amount ?? 0) + Number(bill.recurring_fee ?? 0) + Number(bill.misc_fee ?? 0) + nextElectricityFee
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
        total_amount: Number(bill.rent_amount ?? 0) + Number(bill.recurring_fee ?? 0) + Number(bill.electricity_fee ?? 0) + nextMiscFee
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
        const bankAmount = row.payment_status === "bank_paid" ? Number(row.transfer_amount ?? totalAmount) : 0;
        const cashAmount = row.payment_status === "cash_paid" ? totalAmount : 0;
        return {
          total: sum.total + totalAmount,
          bank: sum.bank + bankAmount,
          cash: sum.cash + cashAmount,
          unpaid:
            row.payment_status !== "vacant" && totalAmount > 0 && !["bank_paid", "cash_paid"].includes(row.payment_status)
              ? sum.unpaid + totalAmount
              : sum.unpaid,
          unpaidCount:
            row.payment_status !== "vacant" && totalAmount > 0 && !["bank_paid", "cash_paid"].includes(row.payment_status)
              ? sum.unpaidCount + 1
              : sum.unpaidCount
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
      雜支: Number(row.misc_fee ?? 0),
      電費: Number(row.electricity_fee ?? 0),
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
          <button className="secondary-button" type="button" onClick={loadBills}>
            <RefreshCw size={17} />
            重新整理
          </button>
          <button className="secondary-button" type="button" onClick={exportMonthlyReconciliation} disabled={loading || rows.length === 0}>
            <Download size={17} />
            匯出本月對帳單
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="month">目前月份</label>
          <input id="month" className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="building">棟別</label>
          <select id="building" className="select" value={building} onChange={(event) => setBuilding(event.target.value)}>
            <option value="all">全部棟別</option>
            {buildings.map((item) => (
              <option key={item} value={item ?? ""}>
                {item}
              </option>
            ))}
          </select>
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

        <div className="field">
          <label htmlFor="method">付款方式</label>
          <select id="method" className="select" value={method} onChange={(event) => setMethod(event.target.value as MethodFilter)}>
            <option value="all">全部方式</option>
            {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
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

      <div className="table-shell">
        <table className="data-table">
          <thead>
            <tr>
              <th>房號</th>
              <th>租客</th>
              <th className="number-cell">房租</th>
              <th className="number-cell">清潔/車位</th>
              <th className="number-cell">雜支</th>
              <th className="number-cell">電費</th>
              <th className="number-cell">當月應繳總額</th>
              <th>付款方式</th>
              <th>狀態</th>
              <th>繳款日</th>
              <th>匯款後五碼</th>
              <th>備註</th>
              <th>詳情</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={13}>載入中...</td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={13}>本月尚未建立帳單，請按「產生本月帳單」。</td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <tr key={row.id} className={row.payment_status === "cash_paid" ? "row-cash-paid" : undefined}>
                  <td>
                    <strong>{row.rooms?.room_number ?? "-"}</strong>
                    <div className="muted">{getRoomBuilding(row.rooms) || "未設定棟別"}</div>
                  </td>
                  <td>{row.contracts?.tenants?.name ?? (row.payment_status === "vacant" || row.note === "空房" ? "未出租" : "-")}</td>
                  <td className="number-cell">{formatCurrency(row.rent_amount)}</td>
                  <td className="number-cell">{formatCurrency(row.recurring_fee ?? 0)}</td>
                  <td className="number-cell">
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
                  <td className="number-cell">
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
                  <td className="number-cell">{formatCurrency(row.total_amount)}</td>
                  <td><PaymentMethodBadge method={row.payment_method} /></td>
                  <td><PaymentStatusBadge status={row.payment_status} /></td>
                  <td>{formatDate(row.paid_date)}</td>
                  <td>{row.transfer_last5 || "-"}</td>
                  <td>{row.note || "-"}</td>
                  <td>
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
                      {canConfirmCash(role) && row.payment_status !== "cash_paid" && row.payment_status !== "vacant" && !monthLock ? (
                        <button className="icon-button" type="button" onClick={() => confirmCashPayment(row)} title="確認收到現金">
                          <Banknote size={17} />
                        </button>
                      ) : null}
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
    const { error: updateError } = await supabase
      .from("monthly_bills")
      .update({
        payment_method: "bank_transfer",
        payment_status: finalStatus,
        paid_date: paidDate || null,
        transfer_last5: last5 || null,
        transfer_amount: Number(amount) || null,
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
        transfer_amount: Number(amount) || null
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
          <button className="button" type="button" disabled={saving} onClick={(event) => saveTransfer(event as unknown as FormEvent<HTMLFormElement>, "bank_paid")}>
            確認到帳
          </button>
        </div>
      </form>
    </Modal>
  );
}


