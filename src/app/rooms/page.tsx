"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Eye, ListPlus, Pencil, Plus, PowerOff, RotateCcw } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { Modal } from "@/components/Modal";
import { RoomStatusBadge } from "@/components/StatusBadge";
import { logAuditAction } from "@/lib/audit";
import { inferRoomMeta } from "@/lib/rooms";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Room, RoomStatus } from "@/lib/types";

const roomStatusOptions: { value: RoomStatus; label: string }[] = [
  { value: "vacant", label: "空房" },
  { value: "occupied", label: "租賃中" },
  { value: "moving_out", label: "退租中" },
  { value: "disabled", label: "已停用" }
];

export default function RoomsPage() {
  return (
    <AuthGuard allowedRoles={["super_admin"]}>
      {() => <RoomsContent />}
    </AuthGuard>
  );
}

function RoomsContent() {
  const supabase = getSupabaseBrowserClient();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [error, setError] = useState("");

  const loadRooms = useCallback(async () => {
    if (!supabase) return;
    setError("");
    const { data, error: queryError } = await supabase
      .from("rooms")
      .select("*")
      .order("building")
      .order("room_number", { ascending: true });

    if (queryError) {
      setError(queryError.message);
      setRooms([]);
      return;
    }

    setRooms((data ?? []) as Room[]);
  }, [supabase]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const buildingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    rooms.forEach((room) => {
      const name = room.building || "未設定";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    return counts;
  }, [rooms]);

  const buildingOptions = useMemo(() => {
    return Array.from(buildingCounts.entries()).sort(([a], [b]) => a.localeCompare(b, "zh-Hant"));
  }, [buildingCounts]);

  useEffect(() => {
    if (rooms.length > 0 && selectedBuilding !== "all" && !buildingCounts.has(selectedBuilding)) {
      setSelectedBuilding("all");
    }
  }, [buildingCounts, rooms.length, selectedBuilding]);

  const filteredRooms = useMemo(() => {
    if (selectedBuilding === "all") return rooms;
    return rooms.filter((room) => (room.building || "未設定") === selectedBuilding);
  }, [rooms, selectedBuilding]);

  async function toggleRoomDisabled(room: Room) {
    if (!supabase) return;
    const nextStatus: RoomStatus = room.status === "disabled" ? "vacant" : "disabled";
    const actionText = nextStatus === "disabled" ? "停用" : "恢復為空房";
    const confirmed = window.confirm(`確定將房號 ${room.room_number} ${actionText}？歷史租約、帳單與修繕記錄都會保留。`);
    if (!confirmed) return;

    const { error: updateError } = await supabase
      .from("rooms")
      .update({ status: nextStatus })
      .eq("id", room.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    await logAuditAction(supabase, {
      action: nextStatus === "disabled" ? "disable_room" : "enable_room",
      target_table: "rooms",
      target_id: room.id,
      room_id: room.id,
      detail: {
        room_number: room.room_number,
        previous_status: room.status,
        next_status: nextStatus
      }
    });
    await loadRooms();
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h1>房間管理</h1>
          <p>房號是固定資料，租客與租約不會寫死在房間表。</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" type="button" onClick={() => setBulkCreating(true)}>
            <ListPlus size={17} />
            批量新增房間
          </button>
          <button className="button" type="button" onClick={() => setCreating(true)}>
            <Plus size={17} />
            新增房間
          </button>
        </div>
      </div>

      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="rooms-layout">
        <aside className="building-nav" aria-label="棟別篩選">
          <div className="building-nav-title">棟別</div>
          <button
            className={`building-filter-button${selectedBuilding === "all" ? " is-active" : ""}`}
            type="button"
            onClick={() => setSelectedBuilding("all")}
            aria-pressed={selectedBuilding === "all"}
          >
            <span>全部</span>
            <strong>{rooms.length}</strong>
          </button>
          {buildingOptions.map(([name, count]) => (
            <button
              key={name}
              className={`building-filter-button${selectedBuilding === name ? " is-active" : ""}`}
              type="button"
              onClick={() => setSelectedBuilding(name)}
              aria-pressed={selectedBuilding === name}
            >
              <span>{name}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </aside>

        <div className="rooms-table-area table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>棟別</th>
                <th>房號</th>
                <th>狀態</th>
                <th>備註</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rooms.length === 0 ? (
                <tr>
                  <td colSpan={5}>尚無房間資料。</td>
                </tr>
              ) : filteredRooms.length === 0 ? (
                <tr>
                  <td colSpan={5}>這個棟別目前沒有房間。</td>
                </tr>
              ) : (
                filteredRooms.map((room) => (
                  <tr key={room.id}>
                    <td>{room.building || "-"}</td>
                    <td><strong>{room.room_number}</strong></td>
                    <td><RoomStatusBadge status={room.status} /></td>
                    <td>{room.note || "-"}</td>
                    <td>
                      <div className="toolbar">
                        <Link className="icon-button" href={`/rooms/${room.id}`} title="詳情">
                          <Eye size={17} />
                        </Link>
                        <button className="icon-button" type="button" onClick={() => setEditingRoom(room)} title="編輯">
                          <Pencil size={17} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => toggleRoomDisabled(room)}
                          title={room.status === "disabled" ? "恢復空房" : "停用"}
                        >
                          {room.status === "disabled" ? <RotateCcw size={17} /> : <PowerOff size={17} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {creating ? (
        <RoomDialog
          title="新增房間"
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await loadRooms();
          }}
        />
      ) : null}

      {editingRoom ? (
        <RoomDialog
          title="編輯房間"
          room={editingRoom}
          onClose={() => setEditingRoom(null)}
          onSaved={async () => {
            setEditingRoom(null);
            await loadRooms();
          }}
        />
      ) : null}

      {bulkCreating ? (
        <BulkRoomDialog
          onClose={() => setBulkCreating(false)}
          onSaved={async () => {
            setBulkCreating(false);
            await loadRooms();
          }}
        />
      ) : null}
    </>
  );
}

function normalizeBuildingName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("棟") || trimmed.includes("栋") || trimmed.includes("橋") || trimmed.includes("桥")) {
    return trimmed.replace("栋", "棟").replace("桥", "橋");
  }
  return `${trimmed.toUpperCase()}棟`;
}

function RoomDialog({
  title,
  room,
  onClose,
  onSaved
}: {
  title: string;
  room?: Room;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [building, setBuilding] = useState(room?.building ?? "");
  const [roomNumber, setRoomNumber] = useState(room?.room_number ?? "");
  const [status, setStatus] = useState<RoomStatus>(room?.status ?? "vacant");
  const [note, setNote] = useState(room?.note ?? "");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setError("");

    const inferred = inferRoomMeta(roomNumber, building);
    const normalizedBuilding = normalizeBuildingName(building);
    const payload = {
      building: normalizedBuilding || inferred.building || null,
      floor: inferred.floor || null,
      room_number: roomNumber,
      status,
      note: note || null
    };

    const result = room
      ? await supabase.from("rooms").update(payload).eq("id", room.id)
      : await supabase.from("rooms").insert(payload);

    if (result.error) {
      setError(result.error.message);
      return;
    }

    await onSaved();
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="building">棟別</label>
              <input id="building" className="input" value={building} onChange={(event) => setBuilding(event.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="room-number">房號</label>
              <input id="room-number" className="input" value={roomNumber} onChange={(event) => setRoomNumber(event.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="room-status">狀態</label>
              <select id="room-status" className="select" value={status} onChange={(event) => setStatus(event.target.value as RoomStatus)}>
                {roomStatusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field full">
              <label htmlFor="room-note">備註</label>
              <textarea id="room-note" className="textarea" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          </div>
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

function BulkRoomDialog({
  onClose,
  onSaved
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [building, setBuilding] = useState("");
  const [roomNumbers, setRoomNumbers] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setError("");
    setSaving(true);

    const normalizedBuilding = normalizeBuildingName(building);
    const numbers = Array.from(new Set(
      roomNumbers
        .split(/[\n,，、\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    ));

    if (numbers.length === 0) {
      setError("請至少輸入一個房號。");
      setSaving(false);
      return;
    }

    const payload = numbers.map((roomNumber) => {
      const inferred = inferRoomMeta(roomNumber, normalizedBuilding);
      return {
        building: normalizedBuilding || inferred.building || null,
        floor: inferred.floor || null,
        room_number: roomNumber,
        status: "vacant" as RoomStatus,
        note: note || null
      };
    });

    const { error: insertError } = await supabase
      .from("rooms")
      .upsert(payload, { onConflict: "room_number", ignoreDuplicates: true });

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    await onSaved();
  }

  return (
    <Modal title="批量新增房間" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="notice" style={{ marginBottom: 14 }}>
            可一次貼上多個房號，例如 C1-1、C1-2、C2-1。已存在的房號會自動略過。
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="bulk-building">棟別</label>
              <input id="bulk-building" className="input" value={building} onChange={(event) => setBuilding(event.target.value)} placeholder="例如 C 或 C棟、橋下" />
            </div>
            <div className="form-field full">
              <label htmlFor="bulk-room-numbers">房號</label>
              <textarea
                id="bulk-room-numbers"
                className="textarea"
                value={roomNumbers}
                onChange={(event) => setRoomNumbers(event.target.value)}
                placeholder={"C1-1\nC1-2\nC2-1"}
                required
              />
            </div>
            <div className="form-field full">
              <label htmlFor="bulk-note">備註</label>
              <textarea id="bulk-note" className="textarea" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          </div>
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="button" type="submit" disabled={saving}>
            {saving ? "新增中..." : "批量新增"}
          </button>
        </div>
      </form>
    </Modal>
  );
}


