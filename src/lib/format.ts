export function formatCurrency(value: number | string | null | undefined) {
  const numberValue = Number(value ?? 0);
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  }).format(Number.isFinite(numberValue) ? numberValue : 0);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return value.slice(0, 10);
}

export function getCurrentMonthInputValue() {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

export function monthInputToBillMonth(month: string) {
  return `${month}-01`;
}

export function todayString() {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function parseMoney(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const normalized = value.replace(/,/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
