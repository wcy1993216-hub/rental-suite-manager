"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { canViewRoute } from "@/lib/permissions";
import type { Profile, Role } from "@/lib/types";
import { SetupNotice } from "@/components/SetupNotice";

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
  const supabase = getSupabaseBrowserClient();

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    async function loadSession() {
      setLoading(true);
      const { data: sessionData } = await client.auth.getSession();
      const sessionUser = sessionData.session?.user ?? null;

      if (!sessionUser) {
        router.replace("/login");
        return;
      }

      setUser(sessionUser);

      const { data: existingProfile, error: profileError } = await client
        .from("profiles")
        .select("*")
        .eq("user_id", sessionUser.id)
        .maybeSingle();

      if (profileError) {
        setError(profileError.message);
        setLoading(false);
        return;
      }

      if (existingProfile) {
        setProfile(existingProfile as Profile);
        setLoading(false);
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
        setProfile(insertedProfile as Profile);
      }
      setLoading(false);
    }

    void loadSession();
  }, [router, supabase]);

  if (!supabase) return <SetupNotice />;
  if (loading) return <div className="loading">載入中...</div>;
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


