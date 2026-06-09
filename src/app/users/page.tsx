"use client";

import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { AuthGuard } from "@/components/AuthGuard";
import { ROLE_LABELS } from "@/lib/permissions";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Profile, Role } from "@/lib/types";

const roleOptions: Role[] = ["super_admin", "accountant_a", "cash_collector_b", "viewer"];

export default function UsersPage() {
  return (
    <AuthGuard allowedRoles={["super_admin"]}>
      {() => <UsersContent />}
    </AuthGuard>
  );
}

function UsersContent() {
  const supabase = getSupabaseBrowserClient();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { display_name: string; role: Role }>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadProfiles = useCallback(async () => {
    if (!supabase) return;
    setError("");
    const { data, error: queryError } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (queryError) {
      setError(queryError.message);
      return;
    }

    const loaded = (data ?? []) as Profile[];
    setProfiles(loaded);
    setDrafts(
      Object.fromEntries(
        loaded.map((profile) => [
          profile.id,
          {
            display_name: profile.display_name ?? "",
            role: profile.role
          }
        ])
      )
    );
  }, [supabase]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  async function saveProfile(profile: Profile) {
    if (!supabase) return;
    setError("");
    setNotice("");
    const draft = drafts[profile.id];
    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        display_name: draft.display_name || null,
        role: draft.role
      })
      .eq("id", profile.id);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setNotice("帳號權限已更新。");
    await loadProfiles();
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h1>帳號權限</h1>
          <p>這裡只管理已存在帳號的顯示名稱與角色。新增 Auth 使用者請先在 Supabase Auth 建立。</p>
        </div>
      </div>

      {notice ? <div className="notice" style={{ marginBottom: 14 }}>{notice}</div> : null}
      {error ? <div className="error-box" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="table-shell">
        <table className="data-table">
          <thead>
            <tr>
              <th>顯示名稱</th>
              <th>User ID</th>
              <th>角色</th>
              <th>建立時間</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 ? (
              <tr>
                <td colSpan={5}>尚無 profile 資料。</td>
              </tr>
            ) : (
              profiles.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <input
                      className="input"
                      value={drafts[profile.id]?.display_name ?? ""}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [profile.id]: {
                            ...current[profile.id],
                            display_name: event.target.value
                          }
                        }))
                      }
                    />
                  </td>
                  <td><code>{profile.user_id}</code></td>
                  <td>
                    <select
                      className="select"
                      value={drafts[profile.id]?.role ?? profile.role}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [profile.id]: {
                            ...current[profile.id],
                            role: event.target.value as Role
                          }
                        }))
                      }
                    >
                      {roleOptions.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{profile.created_at.slice(0, 10)}</td>
                  <td>
                    <button className="icon-button" type="button" onClick={() => saveProfile(profile)} title="儲存">
                      <Save size={17} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}


