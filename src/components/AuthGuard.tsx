"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { canViewRoute } from "@/lib/permissions";
import type { Profile, Role } from "@/lib/types";
import { SetupNotice } from "@/components/SetupNotice";
import { readCachedProfile, writeCachedProfile } from "@/lib/profileCache";

interface AuthGuardProps {
  allowedRoles?: Role[];
  children: (context: { user: User; profile: Profile; role: Role }) => ReactNode;
}

export function AuthGuard({ allowedRoles, children }: AuthGuardProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [slowLoading, setSlowLoading] = useState(false);
  const supabase = getSupabaseBrowserClient();

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    const slowTimer = window.setTimeout(() => setSlowLoading(true), 2500);

    async function loadSession() {
      setLoading(true);
      setSlowLoading(false);
      const { data: sessionData } = await client.auth.getSession();
      const sessionUser = sessionData.session?.user ?? null;

      if (!sessionUser) {
        window.clearTimeout(slowTimer);
        router.replace("/login");
        return;
      }

      setUser(sessionUser);
      const cachedProfile = readCachedProfile(sessionUser.id);
      if (cachedProfile) {
        setProfile(cachedProfile);
        setLoading(false);
        window.clearTimeout(slowTimer);
      }

      const { data: existingProfile, error: profileError } = await client
        .from("profiles")
        .select("*")
        .eq("user_id", sessionUser.id)
        .maybeSingle();

      if (profileError) {
        if (cachedProfile) return;
        setError(profileError.message);
        setLoading(false);
        window.clearTimeout(slowTimer);
        return;
      }

      if (existingProfile) {
        const loadedProfile = existingProfile as Profile;
        writeCachedProfile(loadedProfile);
        setProfile(loadedProfile);
        setLoading(false);
        window.clearTimeout(slowTimer);
        return;
      }

      const { data: insertedProfile, error: insertError } = await client
        .from("profiles")
        .insert({
          user_id: sessionUser.id,
          display_name: sessionUser.email,
          role: "viewer"
        })
        .select("*")
        .single();

      if (insertError) {
        setError(insertError.message);
      } else {
        const loadedProfile = insertedProfile as Profile;
        writeCachedProfile(loadedProfile);
        setProfile(loadedProfile);
      }
      setLoading(false);
      window.clearTimeout(slowTimer);
    }

    void loadSession();

    return () => window.clearTimeout(slowTimer);
  }, [router, supabase]);

  if (!supabase) return <SetupNotice />;
  if (loading) {
    return (
      <div className="loading">
        <strong>載入中...</strong>
        {slowLoading ? <span>Supabase 連線較慢，正在重新確認登入狀態。</span> : null}
      </div>
    );
  }
  if (error) return <div className="error-box">{error}</div>;
  if (!user || !profile) return null;

  if (!canViewRoute(profile.role, allowedRoles)) {
    return (
      <div className="empty-state">
        <h2>權限不足</h2>
        <p>你的帳號角色無法查看這個頁面。</p>
      </div>
    );
  }

  return <>{children({ user, profile, role: profile.role })}</>;
}


