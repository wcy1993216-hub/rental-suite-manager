"use client";

import type { MaintenanceStatus, PaymentMethod, PaymentStatus, RoomStatus } from "@/lib/types";
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/permissions";

const ROOM_STATUS_LABELS: Record<RoomStatus, string> = {
  vacant: "空房",
  occupied: "租賃中",
  moving_out: "退租中",
  disabled: "已停用"
};

const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  pending: "待處理",
  processing: "處理中",
  completed: "已完成"
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {PAYMENT_STATUS_LABELS[status]}
    </span>
  );
}

export function PaymentMethodBadge({ method }: { method: PaymentMethod }) {
  return <span className={`method-badge method-${method}`}>{PAYMENT_METHOD_LABELS[method]}</span>;
}

export function RoomStatusBadge({ status }: { status: RoomStatus }) {
  return <span className={`status-badge room-${status}`}>{ROOM_STATUS_LABELS[status]}</span>;
}

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  return (
    <span className={`status-badge maintenance-${status}`}>
      {MAINTENANCE_STATUS_LABELS[status]}
    </span>
  );
}

