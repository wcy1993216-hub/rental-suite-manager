"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Building2, FileSpreadsheet, Home, LogOut, Table2, Users } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ROLE_LABELS } from "@/lib/permissions";
import type { Profile, Role } from "@/lib/types";

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
          <button className="sidebar-action" type="button" onClick={signOut} title="登出">
            <LogOut size={17} />
            <span>登出</span>
          </button>
        </div>
      </aside>

      <main className="content-area">{children}</main>
    </div>
  );
}


