import type { PaymentMethod, PaymentStatus, Role } from "@/lib/types";

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "主管理帳號",
  accountant_a: "匯款統計帳號",
  cash_collector_b: "現金收款帳號",
  viewer: "唯讀帳號"
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: "匯款",
  cash: "現金",
  none: "未設定"
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "未收",
  bank_paid: "已匯款",
  cash_paid: "已收現金",
  pending: "待確認",
  abnormal: "異常",
  vacant: "空房",
  rent_prepaid: "房租已繳"
};

export function canManageEverything(role: Role | null) {
  return role === "super_admin";
}

export function canRegisterBankTransfer(role: Role | null) {
  return role === "super_admin" || role === "accountant_a";
}

export function canConfirmCash(role: Role | null) {
  return role === "super_admin" || role === "cash_collector_b";
}

export function canEditMaintenance(role: Role | null) {
  return role === "super_admin";
}

export function canImportExcel(role: Role | null) {
  return role === "super_admin";
}

export function canViewRoute(role: Role | null, allowedRoles?: Role[]) {
  if (!allowedRoles || allowedRoles.length === 0) return role !== null;
  return role !== null && allowedRoles.includes(role);
}

