export type Role = "super_admin" | "accountant_a" | "cash_collector_b" | "viewer";

export type RoomStatus = "vacant" | "occupied" | "moving_out" | "disabled";
export type ContractStatus = "active" | "ended";
export type RentPaymentCycle = "monthly" | "semiannual" | "annual";
export type PaymentMethod = "bank_transfer" | "cash" | "none";
export type PaymentStatus = "unpaid" | "bank_paid" | "cash_paid" | "pending" | "abnormal" | "vacant" | "rent_prepaid";
export type MaintenanceStatus = "pending" | "processing" | "completed";

export interface Profile {
  id: string;
  user_id: string;
  display_name: string | null;
  role: Role;
  created_at: string;
}

export interface Room {
  id: string;
  building: string | null;
  floor: string | null;
  room_number: string;
  status: RoomStatus;
  note: string | null;
  created_at: string;
}

export interface Tenant {
  id: string;
  name: string;
  phone: string | null;
  id_last4: string | null;
  note: string | null;
  created_at: string;
}

export interface Contract {
  id: string;
  room_id: string;
  tenant_id: string;
  start_date: string | null;
  end_date: string | null;
  monthly_rent: number;
  rent_payment_cycle: RentPaymentCycle;
  rent_paid_until: string | null;
  cleaning_fee: number;
  parking_fee: number;
  deposit: number;
  status: ContractStatus;
  move_in_date: string | null;
  move_out_date: string | null;
  note: string | null;
  created_at: string;
}

export interface ContractWithTenant extends Contract {
  tenants: Tenant | null;
}

export interface MonthlyBill {
  id: string;
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
  transfer_last5: string | null;
  transfer_amount: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardBill extends MonthlyBill {
  rooms: Room | null;
  contracts: ContractWithTenant | null;
}

export interface MaintenanceRecord {
  id: string;
  room_id: string;
  contract_id: string | null;
  repair_date: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  cost: number;
  worker: string | null;
  note: string | null;
  created_at: string;
}
