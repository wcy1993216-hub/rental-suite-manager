"use client";

import { ChangeEvent, useState } from "react";
import * as XLSX from "xlsx";
import { FileSpreadsheet, Upload } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { PaymentMethodBadge, PaymentStatusBadge } from "@/components/StatusBadge";
import { formatCurrency, getCurrentMonthInputValue, monthInputToBillMonth, normalizeText, parseMoney, todayString } from "@/lib/format";
import { inferRoomMeta } from "@/lib/rooms";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ContractWithTenant, PaymentMethod, PaymentStatus, RentPaymentCycle, Room, Tenant } from "@/lib/types";

interface ImportRow {
  sheetName: string;
  rowIndex: number;
  roomNumber: string;
  tenantName: string;
  rentAmount: number;
  electricityFee: number;
  waterCommonElectricityFee: number;
  miscFee: number;
  totalAmount: number;
  paymentDueDay: number | null;
  rentPaymentCycle: RentPaymentCycle;
  rentPaidUntil: string | null;
  hasRentPrepaidInfo: boolean;
  paidDate: string | null;
  transferLast5: string;
  statusText: string;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  note: string;
}

interface ImportResult {
  rowIndex: number;
  roomNumber: string;
  ok: boolean;
  message: string;
}

const aliases = {
  roomNumber: ["房號", "房間", "房間", "room_number", "room"],
  tenantName: ["租客姓名", "租客", "姓名", "tenant", "tenant_name"],
  rentAmount: ["房租", "租金", "月租", "rent", "rent_amount"],
  electricityFee: ["電費", "电费", "electricity_fee"],
  waterCommonElectricityFee: ["水費/公電", "水费/公电", "水費", "水费", "公電", "公电", "水电", "水電", "water_common_electricity_fee"],
  miscFee: ["其他", "其他項目", "其他项目", "雜支", "雜項", "other_fee", "misc_fee"],
  totalAmount: ["當月應繳總額", "應繳總額", "應收總額", "應收", "total_amount"],
  rentPaymentCycle: ["房租週期", "繳費週期", "付款週期", "週期", "租金週期", "rent_payment_cycle"],
  rentPaidUntil: ["預繳房租至", "房租已繳至", "已繳至", "預繳至", "rent_paid_until"],
  paidDate: ["繳款日", "繳款日", "付款日期", "paid_date"],
  transferLast5: ["匯款後五碼", "匯款後五碼", "後五碼", "後五碼", "transfer_last5"],
  statusText: ["完成狀態", "完成狀態", "狀態", "狀態", "payment_status"],
  note: ["備註", "備註", "note"]
};

function normalizeHeader(value: unknown) {
  return normalizeText(value)
    .replace(/\s/g, "")
    .replace(/[：:]/g, "")
    .toLowerCase();
}

function normalizeTenantName(value: unknown) {
  const text = normalizeText(value);
  return ["", "-", "—", "－", "無", "空房", "姓名", "租客姓名"].includes(text) ? "" : text;
}

function isImportableRoomNumber(roomNumber: string, sheetName: string) {
  const text = normalizeText(roomNumber);
  const normalized = normalizeHeader(text);
  const sheet = normalizeHeader(sheetName);
  const invalidExactValues = new Set(["房號", "房间", "房間", "room", "room_number"]);
  const invalidFragments = ["收租表", "租金表", "現金收", "现金收", "姓名", "租客", "合計", "总计", "總計", "小計", "月份"];

  if (!text || invalidExactValues.has(normalized)) return false;
  if (invalidFragments.some((fragment) => text.includes(fragment))) return false;
  if (/^[A-Za-z]\s*\d+-\d+/.test(text)) return true;
  if (sheet.includes("橋") || sheet.includes("桥")) return true;
  return false;
}

function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    for (const [rowKey, rowValue] of Object.entries(row)) {
      if (normalizeHeader(rowKey) === normalizedKey && normalizeText(rowValue) !== "") {
        return rowValue;
      }
    }
  }
  return "";
}

function normalizeDate(value: unknown, selectedMonth?: string) {
  const text = normalizeText(value);
  if (!text) return null;
  if (selectedMonth && /^\d{1,2}$/.test(text)) {
    const day = Number(text);
    if (day >= 1 && day <= 31) {
      return `${monthInputToBillMonth(selectedMonth).slice(0, 8)}${String(day).padStart(2, "0")}`;
    }
  }
  const normalized = text.replace(/\//g, "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getDate()}`.padStart(2, "0");
  return `${parsed.getFullYear()}-${month}-${day}`;
}

function derivePayment(statusText: string, transferLast5: string): { paymentMethod: PaymentMethod; paymentStatus: PaymentStatus } {
  const text = statusText.toLowerCase();
  if (text.includes("部分") || text.includes("partial")) {
    return { paymentMethod: transferLast5 ? "bank_transfer" : "none", paymentStatus: "partial_paid" };
  }
  if (text.includes("異常") || text.includes("異常") || text.includes("abnormal")) {
    return { paymentMethod: transferLast5 ? "bank_transfer" : "none", paymentStatus: "abnormal" };
  }
  if (text.includes("待") || text.includes("pending")) {
    return { paymentMethod: "bank_transfer", paymentStatus: "pending" };
  }
  if (text.includes("現金") || text.includes("現金") || text.includes("cash")) {
    return { paymentMethod: "cash", paymentStatus: "cash_paid" };
  }
  if (text.includes("匯") || text.includes("bank") || transferLast5) {
    return { paymentMethod: "bank_transfer", paymentStatus: "bank_paid" };
  }
  return { paymentMethod: "none", paymentStatus: "unpaid" };
}

function deriveRentPaymentCycle(text: string): RentPaymentCycle {
  const normalized = text.toLowerCase();
  if (normalized.includes("年繳") || normalized.includes("年付") || normalized.includes("annual")) return "annual";
  if (normalized.includes("半年") || normalized.includes("半年度") || normalized.includes("semi")) return "semiannual";
  return "monthly";
}

function addMonthsMinusOneDay(month: string, months: number) {
  const date = new Date(`${month}T00:00:00`);
  date.setMonth(date.getMonth() + months);
  date.setDate(date.getDate() - 1);
  const nextMonth = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${nextMonth}-${day}`;
}

function parseRows(sheetRows: Record<string, unknown>[], selectedMonth: string, sheetName: string, headerRowIndex: number) {
  return sheetRows
    .map((row, index): ImportRow => {
      const rentAmount = parseMoney(pick(row, aliases.rentAmount));
      const electricityFee = parseMoney(pick(row, aliases.electricityFee));
      const waterCommonElectricityFee = parseMoney(pick(row, aliases.waterCommonElectricityFee));
      const miscFee = parseMoney(pick(row, aliases.miscFee));
      const transferLast5 = normalizeText(pick(row, aliases.transferLast5));
      const statusText = normalizeText(pick(row, aliases.statusText));
      const rentText = normalizeText(pick(row, aliases.rentAmount));
      const explicitCycleText = normalizeText(pick(row, aliases.rentPaymentCycle));
      const tenantName = normalizeTenantName(pick(row, aliases.tenantName));
      const rentPaymentCycle = tenantName
        ? deriveRentPaymentCycle(`${explicitCycleText} ${rentText} ${statusText}`)
        : "monthly";
      const explicitRentPaidUntil = normalizeDate(pick(row, aliases.rentPaidUntil), selectedMonth);
      const hasRentPrepaidInfo = tenantName
        ? Boolean(explicitCycleText || explicitRentPaidUntil) ||
          rentText.includes("年繳") ||
          rentText.includes("半年") ||
          statusText.includes("年繳") ||
          statusText.includes("半年")
        : false;
      const payment = derivePayment(statusText, transferLast5);
      const billMonth = monthInputToBillMonth(selectedMonth);
      const paidDate = normalizeDate(pick(row, aliases.paidDate), selectedMonth);
      const paymentDueDay = paidDate ? Number(paidDate.slice(8, 10)) : null;
      const inferredRentPaidUntil =
        explicitRentPaidUntil ||
        (rentPaymentCycle === "annual"
          ? addMonthsMinusOneDay(billMonth, 12)
          : rentPaymentCycle === "semiannual"
            ? addMonthsMinusOneDay(billMonth, 6)
            : null);
      return {
        sheetName,
        rowIndex: headerRowIndex + index + 2,
        roomNumber: normalizeText(pick(row, aliases.roomNumber)),
        tenantName,
        rentAmount,
        electricityFee,
        waterCommonElectricityFee,
        miscFee,
        totalAmount: rentAmount + electricityFee + waterCommonElectricityFee + miscFee,
        paymentDueDay,
        rentPaymentCycle,
        rentPaidUntil: inferredRentPaidUntil,
        hasRentPrepaidInfo,
        paidDate,
        transferLast5,
        statusText,
        paymentMethod: payment.paymentMethod,
        paymentStatus: payment.paymentStatus,
        note: normalizeText(pick(row, aliases.note))
      };
    })
    .filter((row) => isImportableRoomNumber(row.roomNumber, row.sheetName));
}

function parseWorksheet(sheet: XLSX.WorkSheet, selectedMonth: string, sheetName: string) {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false
  });

  const headerRowIndex = grid.findIndex((row) =>
    row.some((cell) => aliases.roomNumber.some((alias) => normalizeHeader(cell) === normalizeHeader(alias)))
  );

  if (headerRowIndex === -1) {
    return [];
  }

  const headers = grid[headerRowIndex].map((header, index) => normalizeText(header) || `未命名${index + 1}`);
  const records = grid.slice(headerRowIndex + 1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))
  );

  return parseRows(records, selectedMonth, sheetName, headerRowIndex);
}

function normalizeContract(item: unknown): ContractWithTenant | null {
  if (!item) return null;
  const row = item as ContractWithTenant & { tenants?: Tenant | Tenant[] | null };
  return {
    ...row,
    tenants: Array.isArray(row.tenants) ? row.tenants[0] ?? null : row.tenants ?? null
  };
}

export default function ImportPage() {
  return (
    <AuthGuard allowedRoles={["super_admin"]}>
      {() => <ImportContent />}
    </AuthGuard>
  );
}

function ImportContent() {
  const supabase = getSupabaseBrowserClient();
  const [month, setMonth] = useState(getCurrentMonthInputValue());
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError("");
    setResults([]);

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const parsedRows = workbook.SheetNames.flatMap((sheetName) => parseWorksheet(workbook.Sheets[sheetName], month, sheetName));
    setRows(parsedRows);
    if (parsedRows.length === 0) {
      setError("沒有解析到可匯入資料。請確認 Excel 內有「房號」欄位，且房號下方有資料。");
    }
  }

  async function ensureRoom(row: ImportRow): Promise<Room> {
    if (!supabase) throw new Error("Supabase is not configured.");

    const existing = await supabase
      .from("rooms")
      .select("*")
      .eq("room_number", row.roomNumber)
      .maybeSingle();

    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      const inferred = inferRoomMeta(row.roomNumber, row.sheetName);
      const roomUpdate: Partial<Room> = {};
      if (row.tenantName && existing.data.status === "vacant") {
        roomUpdate.status = "occupied";
      } else if (!row.tenantName && existing.data.status !== "disabled") {
        roomUpdate.status = "vacant";
      }
      if (inferred.building && existing.data.building !== inferred.building) {
        roomUpdate.building = inferred.building;
      }
      if (inferred.floor && existing.data.floor !== inferred.floor) {
        roomUpdate.floor = inferred.floor;
      }
      if (Object.keys(roomUpdate).length > 0) {
        await supabase.from("rooms").update(roomUpdate).eq("id", existing.data.id);
      }
      return existing.data as Room;
    }

    const inferred = inferRoomMeta(row.roomNumber, row.sheetName);
    const inserted = await supabase
      .from("rooms")
      .insert({
        room_number: row.roomNumber,
        building: inferred.building || "未設定",
        floor: inferred.floor || null,
        status: row.tenantName ? "occupied" : "vacant"
      })
      .select("*")
      .single();

    if (inserted.error) throw new Error(inserted.error.message);
    return inserted.data as Room;
  }

  async function ensureContract(room: Room, row: ImportRow) {
    if (!supabase || !row.tenantName) return null;

    const active = await supabase
      .from("contracts")
      .select("*, tenants(*)")
      .eq("room_id", room.id)
      .eq("status", "active")
      .maybeSingle();

    if (active.error) throw new Error(active.error.message);
    const activeContract = normalizeContract(active.data);

    if (activeContract?.tenants?.name === row.tenantName) {
      const contractUpdate: Partial<ContractWithTenant> = {
        monthly_rent: row.rentAmount || activeContract.monthly_rent
      };
      if (row.paymentDueDay) {
        contractUpdate.payment_due_day = row.paymentDueDay;
      }
      if (row.hasRentPrepaidInfo) {
        contractUpdate.rent_payment_cycle = row.rentPaymentCycle;
        contractUpdate.rent_paid_until = row.rentPaidUntil;
      }
      const updateResult = await supabase
        .from("contracts")
        .update(contractUpdate)
        .eq("id", activeContract.id);
      if (updateResult.error) throw new Error(updateResult.error.message);
      return activeContract.id;
    }

    if (activeContract) {
      const endOld = await supabase
        .from("contracts")
        .update({ status: "ended", move_out_date: todayString() })
        .eq("id", activeContract.id);
      if (endOld.error) throw new Error(endOld.error.message);
    }

    const tenantResult = await supabase
      .from("tenants")
      .insert({
        name: row.tenantName
      })
      .select("*")
      .single();

    if (tenantResult.error) throw new Error(tenantResult.error.message);

    const contractResult = await supabase
      .from("contracts")
      .insert({
        room_id: room.id,
        tenant_id: tenantResult.data.id,
        start_date: monthInputToBillMonth(month),
        move_in_date: monthInputToBillMonth(month),
        monthly_rent: row.rentAmount,
        payment_due_day: row.paymentDueDay,
        rent_payment_cycle: row.rentPaymentCycle,
        rent_paid_until: row.rentPaidUntil,
        deposit: 0,
        status: "active"
      })
      .select("id")
      .single();

    if (contractResult.error) throw new Error(contractResult.error.message);
    return contractResult.data.id as string;
  }

  async function importRows() {
    if (!supabase) return;
    setImporting(true);
    setError("");
    const importResults: ImportResult[] = [];

    for (const row of rows) {
      try {
        const room = await ensureRoom(row);

        const contractId = await ensureContract(room, row);
        const billResult = await supabase.from("monthly_bills").upsert(
          {
            room_id: room.id,
            contract_id: contractId,
            bill_month: monthInputToBillMonth(month),
            rent_amount: row.tenantName ? row.rentAmount : 0,
            recurring_fee: 0,
            electricity_fee: row.tenantName ? row.electricityFee : 0,
            water_common_electricity_fee: row.tenantName ? row.waterCommonElectricityFee : 0,
            misc_fee: row.tenantName ? row.miscFee : 0,
            total_amount: row.tenantName ? row.totalAmount : 0,
            payment_method: row.paymentMethod,
            payment_status: row.tenantName ? row.paymentStatus : "vacant",
            paid_date: row.paidDate,
            transfer_last5: row.transferLast5 || null,
            transfer_amount: row.tenantName && row.paymentStatus === "bank_paid" ? row.totalAmount : null,
            note: row.tenantName ? row.note || null : row.note || "空房"
          },
          {
            onConflict: "room_id,bill_month"
          }
        );

        if (billResult.error) throw new Error(billResult.error.message);

        importResults.push({
          rowIndex: row.rowIndex,
          roomNumber: row.roomNumber,
          ok: true,
          message: "已匯入"
        });
      } catch (importError) {
        importResults.push({
          rowIndex: row.rowIndex,
          roomNumber: row.roomNumber,
          ok: false,
          message: importError instanceof Error ? importError.message : "匯入失敗"
        });
      }
    }

    setResults(importResults);
    setImporting(false);
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h1>Excel 匯入</h1>
          <p>依房號匯入資料；房號已存在則更新該月份帳單，不存在則新增房號。</p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="import-month">匯入月份</label>
          <input id="import-month" className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="excel-file">收租 Excel</label>
          <input id="excel-file" className="input" type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} />
        </div>
        <button className="button" type="button" disabled={rows.length === 0 || importing} onClick={importRows}>
          <Upload size={17} />
          {importing ? "匯入中..." : "開始匯入"}
        </button>
      </div>

      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}

      {rows.length > 0 ? (
        <section className="panel import-preview">
          <div className="panel-header">
            <h2>
              <FileSpreadsheet size={17} /> 預覽 {rows.length} 筆
            </h2>
          </div>
          <div className="table-shell" style={{ border: 0, borderRadius: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Excel 列</th>
                  <th>工作表</th>
                  <th>房號</th>
                  <th>租客姓名</th>
                  <th className="number-cell">房租</th>
                  <th className="number-cell">電費</th>
                  <th className="number-cell">水費/公電</th>
                  <th className="number-cell">其他</th>
                  <th className="number-cell">當月應繳總額</th>
                  <th>房租週期</th>
                  <th>預繳房租至</th>
                  <th>繳款日</th>
                  <th>匯款後五碼</th>
                  <th>狀態</th>
                  <th>備註</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.sheetName}-${row.rowIndex}-${row.roomNumber}`}>
                    <td>{row.rowIndex}</td>
                    <td>{row.sheetName}</td>
                    <td>{row.roomNumber}</td>
                    <td>{row.tenantName || "-"}</td>
                    <td className="number-cell">{formatCurrency(row.rentAmount)}</td>
                    <td className="number-cell">{formatCurrency(row.electricityFee)}</td>
                    <td className="number-cell">{formatCurrency(row.waterCommonElectricityFee)}</td>
                    <td className="number-cell">{formatCurrency(row.miscFee)}</td>
                    <td className="number-cell">{formatCurrency(row.totalAmount)}</td>
                    <td>{row.rentPaymentCycle === "annual" ? "年繳" : row.rentPaymentCycle === "semiannual" ? "半年繳" : "月繳"}</td>
                    <td>{row.rentPaidUntil || "-"}</td>
                    <td>{row.paidDate || "-"}</td>
                    <td>{row.transferLast5 || "-"}</td>
                    <td>
                      <div className="toolbar">
                        <PaymentMethodBadge method={row.paymentMethod} />
                        <PaymentStatusBadge status={row.paymentStatus} />
                      </div>
                    </td>
                    <td>{row.note || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {results.length > 0 ? (
        <section className="panel import-preview">
          <div className="panel-header">
            <h2>匯入結果</h2>
          </div>
          <div className="table-shell" style={{ border: 0, borderRadius: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Excel 列</th>
                  <th>房號</th>
                  <th>結果</th>
                  <th>說明</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={`${result.rowIndex}-${result.roomNumber}`}>
                    <td>{result.rowIndex}</td>
                    <td>{result.roomNumber}</td>
                    <td>{result.ok ? "成功" : "失敗"}</td>
                    <td>{result.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}


