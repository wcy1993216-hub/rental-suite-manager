"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, LogOut, Pencil, Plus, RefreshCw, UserRoundCog, Wrench } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { Modal } from "@/components/Modal";
import { MaintenanceStatusBadge, PaymentMethodBadge, PaymentStatusBadge, RoomStatusBadge } from "@/components/StatusBadge";
import { formatCurrency, formatDate, todayString } from "@/lib/format";
import { canEditMaintenance, canManageEverything } from "@/lib/permissions";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ContractWithTenant, MaintenanceRecord, MaintenanceStatus, MonthlyBill, RentPaymentCycle, Role, Room, Tenant } from "@/lib/types";

const RENT_PAYMENT_CYCLE_LABELS: Record<RentPaymentCycle, string> = {
  monthly: "月繳",
  semiannual: "半年繳",
  annual: "年繳"
};

function normalizeContract(item: unknown): ContractWithTenant | null {
  if (!item) return null;
  const row = item as ContractWithTenant & { tenants?: Tenant | Tenant[] | null };
  return {
    ...row,
    tenants: Array.isArray(row.tenants) ? row.tenants[0] ?? null : row.tenants ?? null
  };
}

export default function RoomDetailPage() {
  return (
    <AuthGuard>
      {({ role }) => <RoomDetailContent role={role} />}
    </AuthGuard>
  );
}

function RoomDetailContent({ role }: { role: Role }) {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomId = params.roomId;
  const returnHref = searchParams.get("return") || "/dashboard";
  const supabase = getSupabaseBrowserClient();
  const [room, setRoom] = useState<Room | null>(null);
  const [activeContract, setActiveContract] = useState<ContractWithTenant | null>(null);
  const [bills, setBills] = useState<MonthlyBill[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editingTenant, setEditingTenant] = useState(false);
  const [changingTenant, setChangingTenant] = useState(false);
  const [addingMaintenance, setAddingMaintenance] = useState(false);
  const [movingOut, setMovingOut] = useState(false);

  function returnToDashboardWithSync() {
    if (typeof window !== "undefined") {
      sessionStorage.setItem("rental-dashboard-needs-sync", "room-detail-saved");
    }
    router.push(returnHref);
  }

  const loadRoomDetail = useCallback(async () => {
    if (!supabase || !roomId) return;
    setLoading(true);
    setError("");

    const [roomResult, contractResult, billsResult, maintenanceResult] = await Promise.all([
      supabase.from("rooms").select("*").eq("id", roomId).single(),
      supabase
        .from("contracts")
        .select("*, tenants(*)")
        .eq("room_id", roomId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .maybeSingle(),
      supabase.from("monthly_bills").select("*").eq("room_id", roomId).order("bill_month", { ascending: false }),
      supabase.from("maintenance_records").select("*").eq("room_id", roomId).order("repair_date", { ascending: false })
    ]);

    if (roomResult.error) {
      setError(roomResult.error.message);
      setRoom(null);
    } else {
      setRoom(roomResult.data as Room);
    }

    if (contractResult.error) {
      setError(contractResult.error.message);
      setActiveContract(null);
    } else {
      setActiveContract(normalizeContract(contractResult.data));
    }

    if (billsResult.error) {
      setError(billsResult.error.message);
      setBills([]);
    } else {
      setBills((billsResult.data ?? []) as MonthlyBill[]);
    }

    if (maintenanceResult.error) {
      setError(maintenanceResult.error.message);
      setMaintenance([]);
    } else {
      setMaintenance((maintenanceResult.data ?? []) as MaintenanceRecord[]);
    }

    setLoading(false);
  }, [roomId, supabase]);

  useEffect(() => {
    void loadRoomDetail();
  }, [loadRoomDetail]);

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <Link className="link-button" href={returnHref}>
            <ArrowLeft size={17} />
            回每月收租表
          </Link>
          <h1>{room ? `${room.room_number} 房間詳情` : "房間詳情"}</h1>
          <p>合約、押金、歷史租客、修繕記錄都集中在這裡處理。</p>
        </div>
        <button className="secondary-button" type="button" onClick={loadRoomDetail}>
          <RefreshCw size={17} />
          重新整理
        </button>
      </div>

      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}
      {loading ? <div className="loading" style={{ marginBottom: 14 }}>載入中...</div> : null}

      <div className="detail-grid">
        <div className="section-stack">
          <section className="panel">
            <div className="panel-header">
              <h2>房間基本資料</h2>
              {room ? <RoomStatusBadge status={room.status} /> : null}
            </div>
            <div className="panel-body">
              {room ? (
                <dl className="info-list">
                  <dt>房號</dt>
                  <dd>{room.room_number}</dd>
                  <dt>棟別</dt>
                  <dd>{room.building || "-"}</dd>
                  <dt>備註</dt>
                  <dd>{room.note || "-"}</dd>
                </dl>
              ) : (
                <p className="muted">找不到房間資料。</p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>目前租客資料</h2>
              {canManageEverything(role) ? (
                <div className="toolbar">
                  <button className="icon-button" type="button" onClick={() => setEditingTenant(true)} title="編輯租客">
                    <Pencil size={17} />
                  </button>
                  <button className="icon-button" type="button" onClick={() => setChangingTenant(true)} title="更換租客">
                    <UserRoundCog size={17} />
                  </button>
                  <button className="icon-button" type="button" onClick={() => setMovingOut(true)} title="退租">
                    <LogOut size={17} />
                  </button>
                </div>
              ) : null}
            </div>
            <div className="panel-body">
              {activeContract?.tenants ? (
                <dl className="info-list">
                  <dt>租客姓名</dt>
                  <dd>{activeContract.tenants.name}</dd>
                  <dt>電話</dt>
                  <dd>{activeContract.tenants.phone || "-"}</dd>
                  <dt>身分證後四碼</dt>
                  <dd>{activeContract.tenants.id_last4 || "-"}</dd>
                  <dt>入住日期</dt>
                  <dd>{formatDate(activeContract.move_in_date)}</dd>
                  <dt>合約開始日</dt>
                  <dd>{formatDate(activeContract.start_date)}</dd>
                  <dt>合約到期日</dt>
                  <dd>{formatDate(activeContract.end_date)}</dd>
                  <dt>房租</dt>
                  <dd>{formatCurrency(activeContract.monthly_rent)}</dd>
                  <dt>每月繳款日</dt>
                  <dd>{activeContract.payment_due_day ? `每月 ${activeContract.payment_due_day} 號` : "-"}</dd>
                  <dt>清潔費</dt>
                  <dd>{Number(activeContract.cleaning_fee ?? 0) > 0 ? formatCurrency(activeContract.cleaning_fee) : "未收"}</dd>
                  <dt>車位費</dt>
                  <dd>{Number(activeContract.parking_fee ?? 0) > 0 ? formatCurrency(activeContract.parking_fee) : "未租車位"}</dd>
                  <dt>房租週期</dt>
                  <dd>{RENT_PAYMENT_CYCLE_LABELS[activeContract.rent_payment_cycle ?? "monthly"]}</dd>
                  <dt>預繳房租至</dt>
                  <dd>{formatDate(activeContract.rent_paid_until)}</dd>
                  <dt>押金</dt>
                  <dd>{formatCurrency(activeContract.deposit)}</dd>
                  <dt>備註</dt>
                  <dd>{activeContract.note || activeContract.tenants.note || "-"}</dd>
                </dl>
              ) : (
                <p className="muted">目前沒有 active 租約。</p>
              )}
            </div>
          </section>
        </div>

        <div className="section-stack">
          <section className="panel">
            <div className="panel-header">
              <h2>歷史收租記錄</h2>
            </div>
            <div className="table-shell" style={{ border: 0, borderRadius: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>月份</th>
                    <th className="number-cell">當月應繳總額</th>
                    <th>付款方式</th>
                    <th>收款狀態</th>
                    <th>繳款日期</th>
                    <th>備註</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.length === 0 ? (
                    <tr>
                      <td colSpan={6}>尚無歷史收租記錄。</td>
                    </tr>
                  ) : (
                    bills.map((bill) => (
                      <tr key={bill.id} className={bill.payment_status === "cash_paid" ? "row-cash-paid" : undefined}>
                        <td>{bill.bill_month.slice(0, 7)}</td>
                        <td className="number-cell">{formatCurrency(bill.total_amount)}</td>
                        <td><PaymentMethodBadge method={bill.payment_method} /></td>
                        <td><PaymentStatusBadge status={bill.payment_status} /></td>
                        <td>{formatDate(bill.paid_date)}</td>
                        <td>{bill.note || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>修繕記錄</h2>
              {canEditMaintenance(role) ? (
                <button className="secondary-button" type="button" onClick={() => setAddingMaintenance(true)}>
                  <Plus size={17} />
                  新增修繕記錄
                </button>
              ) : null}
            </div>
            <div className="table-shell" style={{ border: 0, borderRadius: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>修繕項目</th>
                    <th>說明</th>
                    <th>狀態</th>
                    <th className="number-cell">费用</th>
                    <th>負責人員</th>
                    <th>備註</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenance.length === 0 ? (
                    <tr>
                      <td colSpan={7}>尚無修繕記錄。</td>
                    </tr>
                  ) : (
                    maintenance.map((record) => (
                      <tr key={record.id}>
                        <td>{formatDate(record.repair_date)}</td>
                        <td>{record.title}</td>
                        <td>{record.description || "-"}</td>
                        <td><MaintenanceStatusBadge status={record.status} /></td>
                        <td className="number-cell">{formatCurrency(record.cost)}</td>
                        <td>{record.worker || "-"}</td>
                        <td>{record.note || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {editingTenant && activeContract ? (
        <TenantEditDialog
          contract={activeContract}
          onClose={() => setEditingTenant(false)}
          onSaved={async () => {
            setEditingTenant(false);
            returnToDashboardWithSync();
          }}
        />
      ) : null}

      {changingTenant && room ? (
        <ChangeTenantDialog
          room={room}
          activeContract={activeContract}
          onClose={() => setChangingTenant(false)}
          onSaved={async () => {
            setChangingTenant(false);
            returnToDashboardWithSync();
          }}
        />
      ) : null}

      {addingMaintenance && room ? (
        <MaintenanceDialog
          room={room}
          activeContractId={activeContract?.id ?? null}
          onClose={() => setAddingMaintenance(false)}
          onSaved={async () => {
            setAddingMaintenance(false);
            await loadRoomDetail();
          }}
        />
      ) : null}

      {movingOut && room && activeContract ? (
        <MoveOutDialog
          room={room}
          contract={activeContract}
          onClose={() => setMovingOut(false)}
          onSaved={async () => {
            setMovingOut(false);
            returnToDashboardWithSync();
          }}
        />
      ) : null}
    </>
  );
}

function TenantEditDialog({
  contract,
  onClose,
  onSaved
}: {
  contract: ContractWithTenant;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const tenant = contract.tenants;
  const [name, setName] = useState(tenant?.name ?? "");
  const [phone, setPhone] = useState(tenant?.phone ?? "");
  const [idLast4, setIdLast4] = useState(tenant?.id_last4 ?? "");
  const [moveInDate, setMoveInDate] = useState(contract.move_in_date ?? "");
  const [startDate, setStartDate] = useState(contract.start_date ?? "");
  const [endDate, setEndDate] = useState(contract.end_date ?? "");
  const [monthlyRent, setMonthlyRent] = useState(String(contract.monthly_rent ?? 0));
  const [paymentDueDay, setPaymentDueDay] = useState(String(contract.payment_due_day ?? ""));
  const [cleaningFeeEnabled, setCleaningFeeEnabled] = useState(Number(contract.cleaning_fee ?? 0) > 0);
  const [cleaningFee, setCleaningFee] = useState(String(Number(contract.cleaning_fee ?? 0) > 0 ? contract.cleaning_fee : 400));
  const [parkingFeeEnabled, setParkingFeeEnabled] = useState(Number(contract.parking_fee ?? 0) > 0);
  const [parkingFee, setParkingFee] = useState(String(contract.parking_fee ?? 0));
  const [rentPaymentCycle, setRentPaymentCycle] = useState<RentPaymentCycle>(contract.rent_payment_cycle ?? "monthly");
  const [rentPaidUntil, setRentPaidUntil] = useState(contract.rent_paid_until ?? "");
  const [deposit, setDeposit] = useState(String(contract.deposit ?? 0));
  const [note, setNote] = useState(contract.note ?? tenant?.note ?? "");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !tenant) return;
    setError("");

    const tenantResult = await supabase
      .from("tenants")
      .update({
        name,
        phone: phone || null,
        id_last4: idLast4 || null,
        note: note || null
      })
      .eq("id", tenant.id);

    if (tenantResult.error) {
      setError(tenantResult.error.message);
      return;
    }

    const contractResult = await supabase
      .from("contracts")
      .update({
        move_in_date: moveInDate || null,
        start_date: startDate || null,
        end_date: endDate || null,
        monthly_rent: Number(monthlyRent) || 0,
        payment_due_day: paymentDueDay ? Number(paymentDueDay) : null,
        cleaning_fee: cleaningFeeEnabled ? Number(cleaningFee) || 400 : 0,
        parking_fee: parkingFeeEnabled ? Number(parkingFee) || 0 : 0,
        rent_payment_cycle: rentPaymentCycle,
        rent_paid_until: rentPaidUntil || null,
        deposit: Number(deposit) || 0,
        note: note || null
      })
      .eq("id", contract.id);

    if (contractResult.error) {
      setError(contractResult.error.message);
      return;
    }

    await onSaved();
  }

  return (
    <Modal title="編輯租客" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <TenantContractForm
            name={name}
            setName={setName}
            phone={phone}
            setPhone={setPhone}
            idLast4={idLast4}
            setIdLast4={setIdLast4}
            moveInDate={moveInDate}
            setMoveInDate={setMoveInDate}
            startDate={startDate}
            setStartDate={setStartDate}
            endDate={endDate}
            setEndDate={setEndDate}
            monthlyRent={monthlyRent}
            setMonthlyRent={setMonthlyRent}
            paymentDueDay={paymentDueDay}
            setPaymentDueDay={setPaymentDueDay}
            cleaningFeeEnabled={cleaningFeeEnabled}
            setCleaningFeeEnabled={setCleaningFeeEnabled}
            cleaningFee={cleaningFee}
            setCleaningFee={setCleaningFee}
            parkingFeeEnabled={parkingFeeEnabled}
            setParkingFeeEnabled={setParkingFeeEnabled}
            parkingFee={parkingFee}
            setParkingFee={setParkingFee}
            rentPaymentCycle={rentPaymentCycle}
            setRentPaymentCycle={setRentPaymentCycle}
            rentPaidUntil={rentPaidUntil}
            setRentPaidUntil={setRentPaidUntil}
            deposit={deposit}
            setDeposit={setDeposit}
            note={note}
            setNote={setNote}
          />
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="button" type="submit">儲存</button>
        </div>
      </form>
    </Modal>
  );
}

function ChangeTenantDialog({
  room,
  activeContract,
  onClose,
  onSaved
}: {
  room: Room;
  activeContract: ContractWithTenant | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [idLast4, setIdLast4] = useState("");
  const [moveInDate, setMoveInDate] = useState(todayString());
  const [startDate, setStartDate] = useState(todayString());
  const [endDate, setEndDate] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("");
  const [paymentDueDay, setPaymentDueDay] = useState("");
  const [cleaningFeeEnabled, setCleaningFeeEnabled] = useState(true);
  const [cleaningFee, setCleaningFee] = useState("400");
  const [parkingFeeEnabled, setParkingFeeEnabled] = useState(false);
  const [parkingFee, setParkingFee] = useState("");
  const [rentPaymentCycle, setRentPaymentCycle] = useState<RentPaymentCycle>("monthly");
  const [rentPaidUntil, setRentPaidUntil] = useState("");
  const [deposit, setDeposit] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setError("");

    try {
      if (activeContract) {
        const endOld = await supabase
          .from("contracts")
          .update({ status: "ended", move_out_date: todayString() })
          .eq("id", activeContract.id);
        if (endOld.error) throw endOld.error;
      }

      const tenantResult = await supabase
        .from("tenants")
        .insert({
          name,
          phone: phone || null,
          id_last4: idLast4 || null,
          note: note || null
        })
        .select("*")
        .single();

      if (tenantResult.error) throw tenantResult.error;

      const contractResult = await supabase.from("contracts").insert({
        room_id: room.id,
        tenant_id: tenantResult.data.id,
        start_date: startDate || null,
        end_date: endDate || null,
        move_in_date: moveInDate || null,
        monthly_rent: Number(monthlyRent) || 0,
        payment_due_day: paymentDueDay ? Number(paymentDueDay) : null,
        cleaning_fee: cleaningFeeEnabled ? Number(cleaningFee) || 400 : 0,
        parking_fee: parkingFeeEnabled ? Number(parkingFee) || 0 : 0,
        rent_payment_cycle: rentPaymentCycle,
        rent_paid_until: rentPaidUntil || null,
        deposit: Number(deposit) || 0,
        status: "active",
        note: note || null
      });

      if (contractResult.error) throw contractResult.error;

      const roomResult = await supabase.from("rooms").update({ status: "occupied" }).eq("id", room.id);
      if (roomResult.error) throw roomResult.error;

      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "更換租客失敗，請稍後再試。");
    }
  }

  return (
    <Modal title="更換租客" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="notice" style={{ marginBottom: 14 }}>
            儲存後會結束目前 active 租約，並建立新的 active 租約，歷史租客與歷史帳單都會保留。
          </div>
          <TenantContractForm
            name={name}
            setName={setName}
            phone={phone}
            setPhone={setPhone}
            idLast4={idLast4}
            setIdLast4={setIdLast4}
            moveInDate={moveInDate}
            setMoveInDate={setMoveInDate}
            startDate={startDate}
            setStartDate={setStartDate}
            endDate={endDate}
            setEndDate={setEndDate}
            monthlyRent={monthlyRent}
            setMonthlyRent={setMonthlyRent}
            paymentDueDay={paymentDueDay}
            setPaymentDueDay={setPaymentDueDay}
            cleaningFeeEnabled={cleaningFeeEnabled}
            setCleaningFeeEnabled={setCleaningFeeEnabled}
            cleaningFee={cleaningFee}
            setCleaningFee={setCleaningFee}
            parkingFeeEnabled={parkingFeeEnabled}
            setParkingFeeEnabled={setParkingFeeEnabled}
            parkingFee={parkingFee}
            setParkingFee={setParkingFee}
            rentPaymentCycle={rentPaymentCycle}
            setRentPaymentCycle={setRentPaymentCycle}
            rentPaidUntil={rentPaidUntil}
            setRentPaidUntil={setRentPaidUntil}
            deposit={deposit}
            setDeposit={setDeposit}
            note={note}
            setNote={setNote}
          />
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="button" type="submit">建立新租約</button>
        </div>
      </form>
    </Modal>
  );
}

function TenantContractForm(props: {
  name: string;
  setName: (value: string) => void;
  phone: string;
  setPhone: (value: string) => void;
  idLast4: string;
  setIdLast4: (value: string) => void;
  moveInDate: string;
  setMoveInDate: (value: string) => void;
  startDate: string;
  setStartDate: (value: string) => void;
  endDate: string;
  setEndDate: (value: string) => void;
  monthlyRent: string;
  setMonthlyRent: (value: string) => void;
  paymentDueDay: string;
  setPaymentDueDay: (value: string) => void;
  cleaningFeeEnabled: boolean;
  setCleaningFeeEnabled: (value: boolean) => void;
  cleaningFee: string;
  setCleaningFee: (value: string) => void;
  parkingFeeEnabled: boolean;
  setParkingFeeEnabled: (value: boolean) => void;
  parkingFee: string;
  setParkingFee: (value: string) => void;
  rentPaymentCycle: RentPaymentCycle;
  setRentPaymentCycle: (value: RentPaymentCycle) => void;
  rentPaidUntil: string;
  setRentPaidUntil: (value: string) => void;
  deposit: string;
  setDeposit: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
}) {
  return (
    <div className="form-grid">
      <div className="form-field">
        <label htmlFor="tenant-name">租客姓名</label>
        <input id="tenant-name" className="input" value={props.name} onChange={(event) => props.setName(event.target.value)} required />
      </div>
      <div className="form-field">
        <label htmlFor="tenant-phone">電話</label>
        <input id="tenant-phone" className="input" value={props.phone} onChange={(event) => props.setPhone(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="tenant-id-last4">身分證後四碼</label>
        <input id="tenant-id-last4" className="input" maxLength={4} value={props.idLast4} onChange={(event) => props.setIdLast4(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="move-in-date">入住日期</label>
        <input id="move-in-date" className="input" type="date" value={props.moveInDate} onChange={(event) => props.setMoveInDate(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="start-date">合約開始日</label>
        <input id="start-date" className="input" type="date" value={props.startDate} onChange={(event) => props.setStartDate(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="end-date">合約到期日</label>
        <input id="end-date" className="input" type="date" value={props.endDate} onChange={(event) => props.setEndDate(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="monthly-rent">房租</label>
        <input id="monthly-rent" className="input" type="number" value={props.monthlyRent} onChange={(event) => props.setMonthlyRent(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="deposit">押金</label>
        <input id="deposit" className="input" type="number" value={props.deposit} onChange={(event) => props.setDeposit(event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="payment-due-day">每月繳款日</label>
        <input
          id="payment-due-day"
          className="input"
          type="number"
          min={1}
          max={31}
          value={props.paymentDueDay}
          onChange={(event) => props.setPaymentDueDay(event.target.value)}
          placeholder="例如 5"
        />
      </div>
      <div className="form-field">
        <label htmlFor="rent-payment-cycle">房租週期</label>
        <select
          id="rent-payment-cycle"
          className="select"
          value={props.rentPaymentCycle}
          onChange={(event) => props.setRentPaymentCycle(event.target.value as RentPaymentCycle)}
        >
          <option value="monthly">月繳</option>
          <option value="semiannual">半年繳</option>
          <option value="annual">年繳</option>
        </select>
      </div>
      <div className="form-field">
        <label htmlFor="cleaning-fee-enabled">清潔費</label>
        <label className="check-row" htmlFor="cleaning-fee-enabled">
          <input
            id="cleaning-fee-enabled"
            type="checkbox"
            checked={props.cleaningFeeEnabled}
            onChange={(event) => props.setCleaningFeeEnabled(event.target.checked)}
          />
          每月收清潔費
        </label>
        <input
          className="input"
          type="number"
          value={props.cleaningFee}
          disabled={!props.cleaningFeeEnabled}
          onChange={(event) => props.setCleaningFee(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor="parking-fee-enabled">車位</label>
        <label className="check-row" htmlFor="parking-fee-enabled">
          <input
            id="parking-fee-enabled"
            type="checkbox"
            checked={props.parkingFeeEnabled}
            onChange={(event) => props.setParkingFeeEnabled(event.target.checked)}
          />
          租車位
        </label>
        <input
          className="input"
          type="number"
          value={props.parkingFee}
          disabled={!props.parkingFeeEnabled}
          onChange={(event) => props.setParkingFee(event.target.value)}
          placeholder="車位費"
        />
      </div>
      <div className="form-field full">
        <label htmlFor="rent-paid-until">預繳房租至</label>
        <input id="rent-paid-until" className="input" type="date" value={props.rentPaidUntil} onChange={(event) => props.setRentPaidUntil(event.target.value)} />
      </div>
      <div className="form-field full">
        <label htmlFor="tenant-note">備註</label>
        <textarea id="tenant-note" className="textarea" value={props.note} onChange={(event) => props.setNote(event.target.value)} />
      </div>
    </div>
  );
}

function MaintenanceDialog({
  room,
  activeContractId,
  onClose,
  onSaved
}: {
  room: Room;
  activeContractId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [repairDate, setRepairDate] = useState(todayString());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<MaintenanceStatus>("pending");
  const [cost, setCost] = useState("");
  const [worker, setWorker] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setError("");

    const { error: insertError } = await supabase.from("maintenance_records").insert({
      room_id: room.id,
      contract_id: activeContractId,
      repair_date: repairDate,
      title,
      description: description || null,
      status,
      cost: Number(cost) || 0,
      worker: worker || null,
      note: note || null
    });

    if (insertError) {
      setError(insertError.message);
      return;
    }

    await onSaved();
  }

  return (
    <Modal title="新增修繕記錄" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field">
              <label>房號</label>
              <input className="input" value={room.room_number} disabled />
            </div>
            <div className="form-field">
              <label htmlFor="repair-date">日期</label>
              <input id="repair-date" className="input" type="date" value={repairDate} onChange={(event) => setRepairDate(event.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="repair-title">修繕項目</label>
              <input id="repair-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="repair-status">狀態</label>
              <select id="repair-status" className="select" value={status} onChange={(event) => setStatus(event.target.value as MaintenanceStatus)}>
                <option value="pending">待處理</option>
                <option value="processing">處理中</option>
                <option value="completed">已完成</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="repair-cost">费用</label>
              <input id="repair-cost" className="input" type="number" value={cost} onChange={(event) => setCost(event.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="repair-worker">負責人員</label>
              <input id="repair-worker" className="input" value={worker} onChange={(event) => setWorker(event.target.value)} />
            </div>
            <div className="form-field full">
              <label htmlFor="repair-description">說明</label>
              <textarea id="repair-description" className="textarea" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div className="form-field full">
              <label htmlFor="repair-note">備註</label>
              <textarea id="repair-note" className="textarea" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          </div>
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="button" type="submit">
            <Wrench size={17} />
            新增
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MoveOutDialog({
  room,
  contract,
  onClose,
  onSaved
}: {
  room: Room;
  contract: ContractWithTenant;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const today = todayString();
  const calculation = useMemo(() => {
    const hasExpired = contract.end_date ? today >= contract.end_date : false;
    const deduction = hasExpired ? 0 : Number(contract.monthly_rent ?? 0);
    const refund = Number(contract.deposit ?? 0) - deduction;
    return {
      hasExpired,
      deduction,
      refund: refund > 0 ? refund : 0
    };
  }, [contract.deposit, contract.end_date, contract.monthly_rent, today]);
  const [error, setError] = useState("");

  async function confirmMoveOut() {
    if (!supabase) return;
    setError("");

    const contractResult = await supabase
      .from("contracts")
      .update({
        status: "ended",
        move_out_date: today
      })
      .eq("id", contract.id);

    if (contractResult.error) {
      setError(contractResult.error.message);
      return;
    }

    const roomResult = await supabase
      .from("rooms")
      .update({
        status: "vacant"
      })
      .eq("id", room.id);

    if (roomResult.error) {
      setError(roomResult.error.message);
      return;
    }

    const currentBillMonth = `${today.slice(0, 7)}-01`;
    const billResult = await supabase.from("monthly_bills").upsert(
      {
        room_id: room.id,
        contract_id: null,
        bill_month: currentBillMonth,
        rent_amount: 0,
        recurring_fee: 0,
        electricity_fee: 0,
        misc_fee: 0,
        total_amount: 0,
        payment_method: "none",
        payment_status: "vacant",
        paid_date: null,
        transfer_last5: null,
        transfer_amount: null,
        note: "退租後空房"
      },
      {
        onConflict: "room_id,bill_month"
      }
    );

    if (billResult.error) {
      setError(billResult.error.message);
      return;
    }

    await onSaved();
  }

  return (
    <Modal title="退租確認" onClose={onClose}>
      <div className="modal-body">
        <div className="notice" style={{ marginBottom: 14 }}>
          系統會結束目前租約並把房間改為空房，不會刪除歷史租客、歷史帳單或修繕記錄。
        </div>
        <dl className="info-list">
          <dt>判断結果</dt>
          <dd>{calculation.hasExpired ? "合約已到期" : "合約尚未到期"}</dd>
          <dt>合約到期日</dt>
          <dd>{formatDate(contract.end_date)}</dd>
          <dt>押金金額</dt>
          <dd>{formatCurrency(contract.deposit)}</dd>
          <dt>房租金額</dt>
          <dd>{formatCurrency(contract.monthly_rent)}</dd>
          <dt>扣款金額</dt>
          <dd>{formatCurrency(calculation.deduction)}</dd>
          <dt>應退押金</dt>
          <dd><strong>{formatCurrency(calculation.refund)}</strong></dd>
        </dl>
        {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
      </div>
      <div className="modal-footer">
        <button className="secondary-button" type="button" onClick={onClose}>取消</button>
        <button className="danger-button" type="button" onClick={confirmMoveOut}>確認退租</button>
      </div>
    </Modal>
  );
}


