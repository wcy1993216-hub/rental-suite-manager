export function SetupNotice() {
  return (
    <div className="empty-state">
      <h2>尚未連接 Supabase</h2>
      <p>
        請建立 <code>.env.local</code>，填入 <code>NEXT_PUBLIC_SUPABASE_URL</code>{" "}
        與 <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>，並在 Supabase 執行{" "}
        <code>supabase/schema.sql</code>。
      </p>
    </div>
  );
}


