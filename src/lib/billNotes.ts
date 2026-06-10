import type { PaymentStatus } from "@/lib/types";

const VACANT_SYSTEM_NOTES = new Set(["空房", "退租後空房", "未出租"]);

export function getActiveContractBillNote(note: string | null | undefined, paymentStatus: PaymentStatus) {
  const trimmedNote = note?.trim();
  if (!trimmedNote) return null;
  if (VACANT_SYSTEM_NOTES.has(trimmedNote)) return null;
  if (paymentStatus !== "rent_prepaid" && trimmedNote.startsWith("房租已")) return null;
  return note ?? null;
}
