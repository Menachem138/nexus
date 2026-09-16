import type pg from "pg";
import type { Db } from "../db/client.js";

export type AbsorbStatus = "dual_run" | "retire_scheduled" | "retired";

export type AbsorbPlanRow = {
  id: string;
  agent_id: string;
  agent_slug: string;
  seed_source: string | null;
  dual_run: boolean;
  status: AbsorbStatus;
  retire_after: string | null;
  notes: string | null;
  updated_at: Date;
};

async function resolveWorkspaceId(db: Db, slug: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );
  if (res.rows.length === 0) throw new Error(`workspace not found: ${slug}`);
  return res.rows[0].id;
}

/**
 * List dual_run seed agents and ensure each has an absorb_plan row
 * (status dual_run by default). Returns current plan rows.
 */
export async function listDualRunAgents(
  pool: pg.Pool,
  workspace: string
): Promise<AbsorbPlanRow[]> {
  const workspaceId = await resolveWorkspaceId(pool, workspace);

  // Upsert absorb plans for every dual_run agent that lacks one
  await pool.query(
    `INSERT INTO agent_absorb_plan (workspace_id, agent_id, seed_source, status, notes)
     SELECT a.workspace_id, a.id, a.seed_source, 'dual_run',
            'seed dual_run — Phase 1 absorb'
     FROM agents a
     WHERE a.workspace_id = $1
       AND a.dual_run = true
       AND a.deleted_at IS NULL
     ON CONFLICT (workspace_id, agent_id) DO UPDATE
       SET seed_source = EXCLUDED.seed_source,
           updated_at = now()`,
    [workspaceId]
  );

  const res = await pool.query<{
    id: string;
    agent_id: string;
    agent_slug: string;
    seed_source: string | null;
    dual_run: boolean;
    status: AbsorbStatus;
    retire_after: string | null;
    notes: string | null;
    updated_at: Date;
  }>(
    `SELECT p.id::text AS id,
            p.agent_id::text AS agent_id,
            a.slug AS agent_slug,
            p.seed_source,
            a.dual_run,
            p.status,
            p.retire_after::text AS retire_after,
            p.notes,
            p.updated_at
     FROM agent_absorb_plan p
     JOIN agents a ON a.id = p.agent_id
     WHERE p.workspace_id = $1
     ORDER BY a.slug`,
    [workspaceId]
  );
  return res.rows;
}

export type UpsertAbsorbInput = {
  workspace: string;
  agentSlug: string;
  status?: AbsorbStatus;
  retireAfter?: string | null;
  notes?: string | null;
};

/**
 * Upsert absorb plan for a specific agent slug.
 */
export async function upsertAbsorbPlan(
  pool: pg.Pool,
  input: UpsertAbsorbInput
): Promise<AbsorbPlanRow> {
  const workspaceId = await resolveWorkspaceId(pool, input.workspace);
  const agent = await pool.query<{
    id: string;
    slug: string;
    seed_source: string | null;
    dual_run: boolean;
  }>(
    `SELECT id, slug, seed_source, dual_run FROM agents
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, input.agentSlug]
  );
  if (agent.rows.length === 0) {
    throw new Error(`agent not found: ${input.agentSlug} in ${input.workspace}`);
  }
  const a = agent.rows[0];
  const status = input.status ?? "dual_run";

  const upsert = await pool.query<{ id: string }>(
    `INSERT INTO agent_absorb_plan
       (workspace_id, agent_id, seed_source, status, retire_after, notes)
     VALUES ($1, $2, $3, $4, $5::date, $6)
     ON CONFLICT (workspace_id, agent_id) DO UPDATE
       SET status = EXCLUDED.status,
           retire_after = EXCLUDED.retire_after,
           notes = COALESCE(EXCLUDED.notes, agent_absorb_plan.notes),
           seed_source = EXCLUDED.seed_source,
           updated_at = now()
     RETURNING id`,
    [
      workspaceId,
      a.id,
      a.seed_source,
      status,
      input.retireAfter ?? null,
      input.notes ?? null,
    ]
  );

  const row = await pool.query<AbsorbPlanRow>(
    `SELECT p.id::text AS id,
            p.agent_id::text AS agent_id,
            a.slug AS agent_slug,
            p.seed_source,
            a.dual_run,
            p.status,
            p.retire_after::text AS retire_after,
            p.notes,
            p.updated_at
     FROM agent_absorb_plan p
     JOIN agents a ON a.id = p.agent_id
     WHERE p.id = $1`,
    [upsert.rows[0].id]
  );
  return row.rows[0];
}

/**
 * Schedule retire for a dual_run seed agent after a given date (YYYY-MM-DD).
 */
export async function scheduleRetire(
  pool: pg.Pool,
  opts: { workspace: string; slug: string; after: string; notes?: string }
): Promise<AbsorbPlanRow> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opts.after);
  if (!m) throw new Error(`invalid --after date (want YYYY-MM-DD): ${opts.after}`);

  return upsertAbsorbPlan(pool, {
    workspace: opts.workspace,
    agentSlug: opts.slug,
    status: "retire_scheduled",
    retireAfter: opts.after,
    notes: opts.notes ?? `retire scheduled after ${opts.after}`,
  });
}
