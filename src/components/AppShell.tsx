"use client";

import type { ReactNode } from "react";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Building2, FileSpreadsheet, Home, KeyRound, LogOut, Table2, Users } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ROLE_LABELS } from "@/lib/permissions";
import type { Profile, Role } from "@/lib/types";
import { Modal } from "@/components/Modal";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  roles?: Role[];
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "每月收租表", icon: <Table2 size={18} /> },
  { href: "/rooms", label: "房間管理", icon: <Building2 size={18} />, roles: ["super_admin"] },
  { href: "/import", label: "Excel 匯入", icon: <FileSpreadsheet size={18} />, roles: ["super_admin"] },
  { href: "/users", label: "帳號權限", icon: <Users size={18} />, roles: ["super_admin"] }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (!supabase || pathname === "/login") return;
    const client = supabase;

    async function loadProfile() {
      const { data: sessionData } = await client.auth.getSession();
      const user = sessionData.session?.user;
      if (!user) {
        setProfile(null);
        return;
      }
      const { data } = await client
        .from("profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      setProfile((data as Profile | null) ?? null);
    }

    void loadProfile();

    const { data: listener } = client.auth.onAuthStateChange(() => {
      void loadProfile();
    });

    return () => listener.subscription.unsubscribe();
  }, [pathname, supabase]);

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (pathname === "/login") {
    return <main className="auth-page">{children}</main>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/dashboard">
          <Home size={20} />
          <span>套房租金管理系統</span>
        </Link>

        <nav className="nav-list">
          {navItems
            .filter((item) => !item.roles || (profile && item.roles.includes(profile.role)))
            .map((item) => (
              <Link
                key={item.href}
                className={`nav-link ${pathname === item.href ? "active" : ""}`}
                href={item.href}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            ))}
        </nav>

        <div className="sidebar-footer">
          <div className="profile-chip">
            <strong>{profile?.display_name || "尚未載入"}</strong>
            <span>{profile ? ROLE_LABELS[profile.role] : "請先登入"}</span>
          </div>
          <button className="sidebar-action" type="button" onClick={() => setChangingPassword(true)} title="修改密碼">
            <KeyRound size={17} />
            <span>修改密碼</span>
          </button>
          <button className="sidebar-action" type="button" onClick={signOut} title="登出">
            <LogOut size={17} />
            <span>登出</span>
          </button>
        </div>
      </aside>

      <main className="content-area">{children}</main>

      {changingPassword ? <ChangePasswordDialog onClose={() => setChangingPassword(false)} /> : null}
    </div>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const supabase = getSupabaseBrowserClient();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setError("");
    setNotice("");

    if (password.length < 6) {
      setError("密碼至少需要 6 碼。");
      return;
    }

    if (password !== confirmPassword) {
      setError("兩次輸入的密碼不一致。");
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password
    });

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    setPassword("");
    setConfirmPassword("");
    setNotice("密碼已更新，下次登入請使用新密碼。");
    setSaving(false);
  }

  return (
    <Modal title="修改密碼" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field full">
              <label htmlFor="new-password">新密碼</label>
              <input
                id="new-password"
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="form-field full">
              <label htmlFor="confirm-password">再次輸入新密碼</label>
              <input
                id="confirm-password"
                className="input"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
          </div>
          {notice ? <div className="notice" style={{ marginTop: 14 }}>{notice}</div> : null}
          {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            關閉
          </button>
          <button className="button" type="submit" disabled={saving}>
            {saving ? "更新中..." : "更新密碼"}
          </button>
        </div>
      </form>
    </Modal>
  );
}


