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

export type OpenCaseInput = {
  workspace: string;
  campaign: string;
  topic: string;
  slug: string;
  body?: Record<string, unknown>;
  actor?: string;
};

export async function openCase(
  pool: pg.Pool,
  input: OpenCaseInput
): Promise<{ id: string; slug: string; status: string; topic: string }> {
  const actor = input.actor ?? "cli";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, input.workspace);
    const camp = await client.query<{ id: string }>(
      `SELECT id FROM campaigns
       WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [workspaceId, input.campaign]
    );
    if (camp.rows.length === 0) {
      throw new Error(`campaign not found: ${input.campaign}`);
    }

    const res = await client.query<{
      id: string;
      slug: string;
      status: string;
      topic: string;
    }>(
      `INSERT INTO council_cases
         (workspace_id, campaign_id, slug, topic, status, case_body)
       VALUES ($1, $2, $3, $4, 'open', $5::jsonb)
       RETURNING id, slug, status, topic`,
      [
        workspaceId,
        camp.rows[0].id,
        input.slug,
        input.topic,
        JSON.stringify(input.body ?? {}),
      ]
    );
    const row = res.rows[0];

    await emitEvent(client, {
      workspaceId,
      campaignId: camp.rows[0].id,
      eventType: "council.case.opened",
      actor,
      payload: { case_id: row.id, slug: row.slug, topic: row.topic },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "council.open",
      entityType: "council_case",
      entityId: row.id,
      details: { slug: row.slug, topic: row.topic, campaign: input.campaign },
    });

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type AddPositionInput = {
  workspace: string;
  caseSlug: string;
  agent: string;
  stance: string;
  body?: Record<string, unknown>;
  actor?: string;
};

export async function addPosition(
  pool: pg.Pool,
  input: AddPositionInput
): Promise<{ id: string; agent_slug: string; stance: string }> {
  const actor = input.actor ?? "cli";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, input.workspace);
    const caze = await client.query<{
      id: string;
      status: string;
      campaign_id: string | null;
    }>(
      `SELECT id, status, campaign_id FROM council_cases
       WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
      [workspaceId, input.caseSlug]
    );
    if (caze.rows.length === 0) {
      throw new Error(`council case not found: ${input.caseSlug}`);
    }
    if (caze.rows[0].status !== "open") {
      throw new Error(
        `cannot add position: case status is ${caze.rows[0].status} (need open)`
      );
    }

    const agent = await client.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM agents
       WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [workspaceId, input.agent]
    );
    const agentId = agent.rows[0]?.id ?? null;
    const agentSlug = agent.rows[0]?.slug ?? input.agent;

    const pos = await client.query<{ id: string; agent_slug: string; stance: string }>(
      `INSERT INTO council_positions (case_id, agent_id, agent_slug, stance, body)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, agent_slug, stance`,
      [
        caze.rows[0].id,
        agentId,
        agentSlug,
        input.stance,
        JSON.stringify(input.body ?? {}),
      ]
    );

    await emitEvent(client, {
      workspaceId,
      campaignId: caze.rows[0].campaign_id,
      eventType: "council.position.added",
      actor,
      payload: {
        case_id: caze.rows[0].id,
        case_slug: input.caseSlug,
        position_id: pos.rows[0].id,
        agent: agentSlug,
        stance: input.stance,
      },
    });

    await client.query("COMMIT");
    return pos.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type DecideCaseInput = {
  workspace: string;
  caseSlug: string;
  verdict: Record<string, unknown>;
  actor?: string;
  close?: boolean;
};

export async function decideCase(
  pool: pg.Pool,
  input: DecideCaseInput
): Promise<{ id: string; slug: string; status: string; verdict: unknown }> {
  const actor = input.actor ?? "cli";
  const status = input.close === false ? "decided" : "decided";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, input.workspace);
    const caze = await client.query<{
      id: string;
      slug: string;
      status: string;
      campaign_id: string | null;
    }>(
      `SELECT id, slug, status, campaign_id FROM council_cases
       WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
      [workspaceId, input.caseSlug]
    );
    if (caze.rows.length === 0) {
      throw new Error(`council case not found: ${input.caseSlug}`);
    }
    if (caze.rows[0].status !== "open") {
      throw new Error(
        `cannot decide: case status is ${caze.rows[0].status} (need open)`
      );
    }

    const finalStatus = status; // decided; callers may later close
    const updated = await client.query<{
      id: string;
      slug: string;
      status: string;
      verdict: unknown;
    }>(
      `UPDATE council_cases
       SET status = $1, verdict = $2::jsonb, updated_at = now()
       WHERE id = $3
       RETURNING id, slug, status, verdict`,
      [finalStatus, JSON.stringify(input.verdict), caze.rows[0].id]
    );

    await emitEvent(client, {
      workspaceId,
      campaignId: caze.rows[0].campaign_id,
      eventType: "council.case.decided",
      actor,
      payload: {
        case_id: updated.rows[0].id,
        slug: updated.rows[0].slug,
        verdict: input.verdict,
        status: finalStatus,
      },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "council.decide",
      entityType: "council_case",
      entityId: updated.rows[0].id,
      details: { slug: updated.rows[0].slug, verdict: input.verdict },
    });

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
