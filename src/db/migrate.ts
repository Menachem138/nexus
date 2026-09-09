import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(pool: ReturnType<typeof createPool>) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files;
}

async function migrateUp() {
  const pool = createPool();
  try {
    await ensureMigrationsTable(pool);
    const applied = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id"
    );
    const done = new Set(applied.rows.map((r) => r.id));
    const files = await listMigrationFiles();

    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip  ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.log(`apply ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    console.log("migrate: up complete");
  } finally {
    await pool.end();
  }
}

async function migrateDown() {
  const pool = createPool();
  try {
    await ensureMigrationsTable(pool);
    const applied = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1"
    );
    if (applied.rows.length === 0) {
      console.log("migrate: nothing to roll back");
      return;
    }
    const id = applied.rows[0].id;
    // Down drops all app tables including Phase 1 (re-run migrate for clean slate)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        DROP TABLE IF EXISTS
          agent_handoffs,
          model_invocations,
          insights,
          frh_profiles,
          council_cases,
          experiments,
          creative_dna,
          creatives,
          audit_log,
          events,
          tasks,
          campaigns,
          blackboard_entries,
          blackboards,
          market_twins,
          markets,
          agents,
          model_policies,
          workspaces
        CASCADE;
      `);
      await client.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
      await client.query("COMMIT");
      console.log(`down  ${id}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    console.log("migrate: down complete");
  } finally {
    await pool.end();
  }
}

const cmd = process.argv[2] ?? "up";
if (cmd === "down") {
  migrateDown().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  migrateUp().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
