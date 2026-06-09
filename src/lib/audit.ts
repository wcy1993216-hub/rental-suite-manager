import type { SupabaseClient } from "@supabase/supabase-js";

export async function logAuditAction(
  supabase: SupabaseClient,
  payload: {
    action: string;
    target_table?: string;
    target_id?: string | null;
    bill_month?: string | null;
    room_id?: string | null;
    detail?: Record<string, unknown>;
  }
) {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return;

  await supabase.from("audit_logs").insert({
    actor_user_id: user.id,
    actor_email: user.email ?? null,
    action: payload.action,
    target_table: payload.target_table ?? null,
    target_id: payload.target_id ?? null,
    bill_month: payload.bill_month ?? null,
    room_id: payload.room_id ?? null,
    detail: payload.detail ?? {}
  });
}
