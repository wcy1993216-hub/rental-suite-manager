"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { SetupNotice } from "@/components/SetupNotice";

export default function LoginPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setLoading(true);
    setError("");

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    router.replace("/dashboard");
  }

  if (!supabase) return <SetupNotice />;

  return (
    <form className="auth-panel" onSubmit={handleSubmit}>
      <h1>套房租金管理系統</h1>
      <p>請使用 Supabase Auth 帳號登入。</p>

      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </div>

      <div className="form-field" style={{ marginTop: 12 }}>
        <label htmlFor="password">密碼</label>
        <input
          id="password"
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      {error ? <div className="error-box" style={{ marginTop: 14 }}>{error}</div> : null}

      <button className="button" type="submit" disabled={loading} style={{ width: "100%", marginTop: 18 }}>
        <LogIn size={18} />
        {loading ? "登入中..." : "登入"}
      </button>
    </form>
  );
}


