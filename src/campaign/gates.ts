import type pg from "pg";
import type { Db } from "../db/client.js";
import { emitEvent, writeAudit } from "./events.js";

async function resolveWorkspaceId(db: Db, workspaceSlug: string): Promise<string> {
  const ws = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [workspaceSlug]
  );
  if (ws.rows.length === 0) throw new Error(`workspace not found: ${workspaceSlug}`);
  return ws.rows[0].id;
}

export type GateResult = {
  id: string;
  slug: string;
  status: string;
  human_taste: string | null;
  actionId: string;
};

export async function approveCreative(
  pool: pg.Pool,
  opts: {
    workspace: string;
    slug: string;
    actor?: string;
    reason?: string;
  }
): Promise<GateResult> {
  const actor = opts.actor ?? "cli";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, opts.workspace);
    const creative = await client.query<{
      id: string;
      slug: string;
      status: string;
      campaign_id: string | null;
    }>(
      `SELECT id, slug, status, campaign_id FROM creatives
       WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
      [workspaceId, opts.slug]
    );
    if (creative.rows.length === 0) {
      throw new Error(`creative not found: ${opts.slug}`);
    }
    const row = creative.rows[0];

    const updated = await client.query<{
      id: string;
      slug: string;
      status: string;
      human_taste: string | null;
    }>(
      `UPDATE creatives
       SET status = 'approved', human_taste = 'approve', updated_at = now()
       WHERE id = $1
       RETURNING id, slug, status, human_taste`,
      [row.id]
    );

    const action = await client.query<{ id: string }>(
      `INSERT INTO creative_gate_actions
         (creative_id, workspace_id, action, actor, reason)
       VALUES ($1, $2, 'approve', $3, $4)
       RETURNING id`,
      [row.id, workspaceId, actor, opts.reason ?? null]
    );

    await emitEvent(client, {
      workspaceId,
      campaignId: row.campaign_id,
      eventType: "creative.approved",
      actor,
      payload: {
        creative_id: row.id,
        slug: row.slug,
        from_status: row.status,
        reason: opts.reason ?? null,
      },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "creative.approve",
      entityType: "creative",
      entityId: row.id,
      details: { slug: row.slug, reason: opts.reason ?? null },
    });

    await client.query("COMMIT");
    return { ...updated.rows[0], actionId: action.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function killCreative(
  pool: pg.Pool,
  opts: {
    workspace: string;
    slug: string;
    reason: string;
    actor?: string;
  }
): Promise<GateResult> {
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error("killCreative requires a reason (sterile/taste)");
  }
  const actor = opts.actor ?? "cli";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, opts.workspace);
    const creative = await client.query<{
      id: string;
      slug: string;
      status: string;
      campaign_id: string | null;
      sterile_flags: unknown;
      asset_meta: Record<string, unknown>;
    }>(
      `SELECT id, slug, status, campaign_id, sterile_flags, asset_meta FROM creatives
       WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
      [workspaceId, opts.slug]
    );
    if (creative.rows.length === 0) {
      throw new Error(`creative not found: ${opts.slug}`);
    }
    const row = creative.rows[0];
    const meta = {
      ...(typeof row.asset_meta === "object" && row.asset_meta ? row.asset_meta : {}),
      killed_reason: opts.reason,
    };

    const updated = await client.query<{
      id: string;
      slug: string;
      status: string;
      human_taste: string | null;
    }>(
      `UPDATE creatives
       SET status = 'killed',
           human_taste = 'reject',
           asset_meta = $1::jsonb,
           updated_at = now()
       WHERE id = $2
       RETURNING id, slug, status, human_taste`,
      [JSON.stringify(meta), row.id]
    );

    const action = await client.query<{ id: string }>(
      `INSERT INTO creative_gate_actions
         (creative_id, workspace_id, action, actor, reason)
       VALUES ($1, $2, 'kill', $3, $4)
       RETURNING id`,
      [row.id, workspaceId, actor, opts.reason]
    );

    await emitEvent(client, {
      workspaceId,
      campaignId: row.campaign_id,
      eventType: "creative.rejected",
      actor,
      payload: {
        creative_id: row.id,
        slug: row.slug,
        from_status: row.status,
        reason: opts.reason,
      },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "creative.kill",
      entityType: "creative",
      entityId: row.id,
      details: { slug: row.slug, reason: opts.reason },
    });

    await client.query("COMMIT");
    return { ...updated.rows[0], actionId: action.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
