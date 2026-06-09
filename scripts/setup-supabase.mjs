import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

const root = process.cwd();
const schemaPath = path.join(root, "supabase", "schema.sql");
const envPath = path.join(root, ".env.local");

function clean(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function getProjectRef(projectUrl) {
  const hostname = new URL(projectUrl).hostname;
  return hostname.split(".")[0];
}

function normalizeProjectUrl(projectUrl) {
  const url = new URL(projectUrl);
  return `${url.protocol}//${url.hostname}`;
}

function getConnectionString(projectUrl, dbPasswordOrUri) {
  if (dbPasswordOrUri.startsWith("postgres://") || dbPasswordOrUri.startsWith("postgresql://")) {
    return dbPasswordOrUri;
  }

  const projectRef = getProjectRef(projectUrl);
  return `postgresql://postgres:${encodeURIComponent(dbPasswordOrUri)}@db.${projectRef}.supabase.co:5432/postgres`;
}

async function promptForSetup() {
  if (process.env.SUPABASE_SETUP_JSON) {
    return JSON.parse(process.env.SUPABASE_SETUP_JSON);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const projectUrl = normalizeProjectUrl(clean(await rl.question("Supabase Project URL: ")));
    const publishableKey = clean(await rl.question("Supabase publishable key: "));
    const dbPasswordOrUri = clean(
      await rl.question("Database password / Postgres connection string / SKIP: ")
    );
    const serviceRoleKey = clean(
      await rl.question("Service role key（可留空；留空就不會自動建立登入帳號）: ")
    );

    let adminEmail = "";
    let adminPassword = "";
    if (serviceRoleKey) {
      adminEmail = clean(await rl.question("第一個管理員 Email: "));
      adminPassword = clean(await rl.question("第一個管理員密碼: "));
    }

    return {
      projectUrl,
      publishableKey,
      dbPasswordOrUri,
      serviceRoleKey,
      adminEmail,
      adminPassword
    };
  } finally {
    rl.close();
  }
}

async function writeEnv(projectUrl, publishableKey) {
  const envBody = [
    `NEXT_PUBLIC_SUPABASE_URL=${projectUrl}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${publishableKey}`,
    ""
  ].join("\n");
  await fs.writeFile(envPath, envBody, "utf8");
}

async function runSchema(connectionString) {
  const schema = await fs.readFile(schemaPath, "utf8");
  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  try {
    await client.query(schema);
  } finally {
    await client.end();
  }
}

async function getAuthUserIdByEmail(connectionString, email) {
  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  try {
    const result = await client.query("select id from auth.users where email = $1 limit 1", [email]);
    return result.rows[0]?.id ?? null;
  } finally {
    await client.end();
  }
}

async function upsertSuperAdmin(connectionString, userId, email) {
  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  try {
    await client.query(
      `
      insert into public.profiles (user_id, display_name, role)
      values ($1, $2, 'super_admin'::public.app_role)
      on conflict (user_id)
      do update set
        display_name = excluded.display_name,
        role = 'super_admin'
      `,
      [userId, email]
    );
  } finally {
    await client.end();
  }
}

async function createOrFindAdminUser(projectUrl, serviceRoleKey, email, password, connectionString) {
  const supabase = createClient(projectUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (created.error && !created.error.message.toLowerCase().includes("already")) {
    throw created.error;
  }

  if (created.data.user?.id) {
    return created.data.user.id;
  }

  const existingUserId = await getAuthUserIdByEmail(connectionString, email);
  if (!existingUserId) {
    throw new Error("管理員帳號已存在但無法从 auth.users 找到對應 user id。");
  }

  return existingUserId;
}

async function main() {
  const setup = await promptForSetup();

  if (!setup.projectUrl || !setup.publishableKey) {
    throw new Error("Project URL 和 publishable key 都是必填。");
  }

  setup.projectUrl = normalizeProjectUrl(setup.projectUrl);
  const shouldSkipDatabase = !setup.dbPasswordOrUri || setup.dbPasswordOrUri.toLowerCase() === "skip";
  const connectionString = shouldSkipDatabase
    ? ""
    : getConnectionString(setup.projectUrl, setup.dbPasswordOrUri);

  console.log("\n1/4 寫入 .env.local...");
  await writeEnv(setup.projectUrl, setup.publishableKey);

  if (shouldSkipDatabase) {
    console.log("2/4 略過資料庫 schema。請到 Supabase SQL Editor 手動執行 supabase/schema.sql。");
    console.log("3/4 略過 Auth 使用者建立。");
    console.log("4/4 略過 super_admin profile。");
    console.log("\n.env.local 已完成。");
    return;
  }

  console.log("2/4 執行 supabase/schema.sql...");
  await runSchema(connectionString);

  if (setup.serviceRoleKey && setup.adminEmail && setup.adminPassword) {
    console.log("3/4 建立或查找第一個管理員 Auth 使用者...");
    const userId = await createOrFindAdminUser(
      setup.projectUrl,
      setup.serviceRoleKey,
      setup.adminEmail,
      setup.adminPassword,
      connectionString
    );

    console.log("4/4 設定 super_admin profile...");
    await upsertSuperAdmin(connectionString, userId, setup.adminEmail);
  } else {
    console.log("3/4 略過 Auth 使用者建立。");
    console.log("4/4 略過 super_admin profile。");
  }

  console.log("\n完成。請重新啟動 Next.js dev server 後登入系統。");
}

main().catch((error) => {
  console.error("\nSetup 失敗：");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});


