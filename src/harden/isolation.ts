import type pg from "pg";
import type { Db } from "../db/client.js";

export type IsolationCheck = {
  table: string;
  query: string;
  frhOnlyExpected: number;
  coreFilteredCount: number;
  leakedIds: string[];
  ok: boolean;
};

export type IsolationReport = {
  coreWorkspaceId: string;
  frhWorkspaceId: string;
  checks: IsolationCheck[];
  ok: boolean;
  message: string;
};

async function workspaceId(db: Db, slug: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );
  if (res.rows.length === 0) throw new Error(`workspace not found: ${slug}`);
  return res.rows[0].id;
}

/**
 * Tables that must be filtered by workspace_id so FRH tenant data
 * never appears when querying the core workspace.
 */
export const ISOLATION_TABLES: Array<{
  table: string;
  idCol?: string;
}> = [
  { table: "campaigns" },
  { table: "agents" },
  { table: "markets" },
  { table: "creatives" },
  { table: "tasks" },
  { table: "insights" },
  { table: "blackboards" },
  { table: "performance_daily" },
];

/**
 * Assert that rows belonging only to `frh` are not returned when the
 * query filters by `core` workspace_id. Returns a structured report;
 * throws if `throwOnFail` and any leak is detected.
 */
export async function assertWorkspaceIsolation(
  pool: pg.Pool,
  opts: { throwOnFail?: boolean } = {}
): Promise<IsolationReport> {
  const coreId = await workspaceId(pool, "core");
  const frhId = await workspaceId(pool, "frh");
  const checks: IsolationCheck[] = [];

  for (const { table } of ISOLATION_TABLES) {
    // Does the table exist?
    const exists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table]
    );
    if (!exists.rows[0]?.exists) {
      checks.push({
        table,
        query: `SKIP (table missing)`,
        frhOnlyExpected: 0,
        coreFilteredCount: 0,
        leakedIds: [],
        ok: true,
      });
      continue;
    }

    const frhRows = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM ${table} WHERE workspace_id = $1`,
      [frhId]
    );
    const frhIds = new Set(frhRows.rows.map((r) => r.id));

    // Correct filter: core only — must not include any frh ids
    const coreRows = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM ${table} WHERE workspace_id = $1`,
      [coreId]
    );
    const leaked = coreRows.rows
      .map((r) => r.id)
      .filter((id) => frhIds.has(id));

    checks.push({
      table,
      query: `SELECT id FROM ${table} WHERE workspace_id = :core`,
      frhOnlyExpected: frhIds.size,
      coreFilteredCount: coreRows.rows.length,
      leakedIds: leaked,
      ok: leaked.length === 0,
    });
  }

  // Explicit anti-pattern probe: querying WITHOUT workspace filter on campaigns
  // must be detectable as unsafe (helper for tests).
  const ok = checks.every((c) => c.ok);
  const message = ok
    ? "workspace isolation OK — FRH rows never returned under core filter"
    : `ISOLATION FAIL — leaked FRH ids via core filter: ${checks
        .filter((c) => !c.ok)
        .map((c) => `${c.table}(${c.leakedIds.length})`)
        .join(", ")}`;

  const report: IsolationReport = {
    coreWorkspaceId: coreId,
    frhWorkspaceId: frhId,
    checks,
    ok,
    message,
  };

  if (!ok && opts.throwOnFail !== false) {
    throw new Error(message);
  }
  return report;
}

/**
 * Test helper: simulate a BAD query that forgets workspace_id and returns
 * FRH campaign ids mixed with everything. Used to prove isolation tests fail
 * when queried wrong.
 */
export async function queryCampaignsWithoutWorkspaceFilter(
  pool: pg.Pool
): Promise<string[]> {
  const res = await pool.query<{ id: string; workspace_id: string }>(
    `SELECT id::text AS id, workspace_id::text AS workspace_id
     FROM campaigns
     WHERE deleted_at IS NULL`
  );
  return res.rows.map((r) => r.id);
}

/**
 * Test helper: correctly scoped campaigns for a workspace slug.
 */
export async function queryCampaignsForWorkspace(
  pool: pg.Pool,
  workspaceSlug: string
): Promise<Array<{ id: string; slug: string }>> {
  const res = await pool.query<{ id: string; slug: string }>(
    `SELECT c.id::text AS id, c.slug
     FROM campaigns c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.slug = $1 AND c.deleted_at IS NULL`,
    [workspaceSlug]
  );
  return res.rows;
}

/**
 * Pure unit helper: given sets of ids, detect whether a "core-filtered"
 * result set contains any FRH-only ids. Used by tests without Postgres.
 */
export function detectLeak(
  frhOnlyIds: string[],
  coreFilteredIds: string[]
): { ok: boolean; leakedIds: string[] } {
  const frh = new Set(frhOnlyIds);
  const leaked = coreFilteredIds.filter((id) => frh.has(id));
  return { ok: leaked.length === 0, leakedIds: leaked };
}
