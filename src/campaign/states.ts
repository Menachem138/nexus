import type pg from "pg";
import type { Db } from "../db/client.js";
import { emitEvent, writeAudit } from "./events.js";

export const CAMPAIGN_STATUSES = [
  "draft",
  "research",
  "strategy",
  "creative",
  "review",
  "approved",
  "live",
  "paused",
  "learned",
  "killed",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Happy-path + kill/pause edges. Enforced in code (history table records every change). */
export const ALLOWED_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["research", "killed"],
  research: ["strategy", "killed"],
  strategy: ["creative", "killed"],
  creative: ["review", "killed"],
  review: ["approved", "creative", "killed"],
  approved: ["live", "killed"],
  live: ["paused", "learned", "killed"],
  paused: ["live", "learned", "killed"],
  learned: ["draft", "research"],
  killed: [],
};

export function canTransition(from: string, to: string): boolean {
  if (!isCampaignStatus(from) || !isCampaignStatus(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isCampaignStatus(s: string): s is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(s);
}

export type TransitionInput = {
  workspace: string;
  slug?: string;
  id?: string;
  to: string;
  actor?: string;
  reason?: string;
};

export type TransitionResult = {
  campaignId: string;
  slug: string;
  from: CampaignStatus;
  to: CampaignStatus;
  historyId: string;
};

async function resolveWorkspaceId(db: Db, workspaceSlug: string): Promise<string> {
  const ws = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [workspaceSlug]
  );
  if (ws.rows.length === 0) throw new Error(`workspace not found: ${workspaceSlug}`);
  return ws.rows[0].id;
}

export async function getCampaignStatus(
  pool: pg.Pool,
  workspaceSlug: string,
  campaignSlug: string
): Promise<{
  id: string;
  slug: string;
  title: string;
  status: string;
  human_gate: string;
  history: Array<{ from_status: string; to_status: string; actor: string | null; reason: string | null; created_at: Date }>;
}> {
  const workspaceId = await resolveWorkspaceId(pool, workspaceSlug);
  const camp = await pool.query<{
    id: string;
    slug: string;
    title: string;
    status: string;
    human_gate: string;
  }>(
    `SELECT id, slug, title, status, human_gate FROM campaigns
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, campaignSlug]
  );
  if (camp.rows.length === 0) {
    throw new Error(`campaign not found: ${campaignSlug} in ${workspaceSlug}`);
  }
  const c = camp.rows[0];
  const hist = await pool.query<{
    from_status: string;
    to_status: string;
    actor: string | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT from_status, to_status, actor, reason, created_at
     FROM campaign_status_history
     WHERE campaign_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [c.id]
  );
  return { ...c, history: hist.rows };
}

export async function transitionCampaign(
  pool: pg.Pool,
  input: TransitionInput
): Promise<TransitionResult> {
  if (!input.slug && !input.id) {
    throw new Error("transitionCampaign requires slug or id");
  }
  if (!isCampaignStatus(input.to)) {
    throw new Error(
      `invalid target status: ${input.to}; allowed: ${CAMPAIGN_STATUSES.join(", ")}`
    );
  }
  const to = input.to as CampaignStatus;
  const actor = input.actor ?? "cli";
  const reason = input.reason ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, input.workspace);

    let campQuery: string;
    let campParams: unknown[];
    if (input.id) {
      campQuery = `SELECT id, slug, status FROM campaigns
                   WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`;
      campParams = [workspaceId, input.id];
    } else {
      campQuery = `SELECT id, slug, status FROM campaigns
                   WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`;
      campParams = [workspaceId, input.slug];
    }
    const camp = await client.query<{ id: string; slug: string; status: string }>(
      campQuery,
      campParams
    );
    if (camp.rows.length === 0) {
      throw new Error(
        `campaign not found: ${input.slug ?? input.id} in ${input.workspace}`
      );
    }
    const row = camp.rows[0];
    const from = row.status;
    if (!isCampaignStatus(from)) {
      throw new Error(`campaign has unknown status: ${from}`);
    }
    if (!canTransition(from, to)) {
      throw new Error(
        `illegal transition: ${from} → ${to} (allowed: ${ALLOWED_TRANSITIONS[from].join(", ") || "none"})`
      );
    }

    await client.query(
      `UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2`,
      [to, row.id]
    );

    const hist = await client.query<{ id: string }>(
      `INSERT INTO campaign_status_history
         (campaign_id, workspace_id, from_status, to_status, actor, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [row.id, workspaceId, from, to, actor, reason]
    );

    await emitEvent(client, {
      workspaceId,
      campaignId: row.id,
      eventType: "campaign.status_changed",
      actor,
      payload: { from, to, reason, slug: row.slug },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "campaign.transition",
      entityType: "campaign",
      entityId: row.id,
      details: { from, to, reason, slug: row.slug },
    });

    await client.query("COMMIT");
    return {
      campaignId: row.id,
      slug: row.slug,
      from,
      to,
      historyId: hist.rows[0].id,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
