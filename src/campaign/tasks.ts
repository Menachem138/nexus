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

async function resolveCampaign(
  db: Db,
  workspaceId: string,
  campaignSlug: string
): Promise<{ id: string; slug: string }> {
  const res = await db.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM campaigns
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, campaignSlug]
  );
  if (res.rows.length === 0) {
    throw new Error(`campaign not found: ${campaignSlug}`);
  }
  return res.rows[0];
}

async function resolveAgent(
  db: Db,
  workspaceId: string,
  agentSlug: string
): Promise<{ id: string; slug: string }> {
  const res = await db.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM agents
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, agentSlug]
  );
  if (res.rows.length === 0) {
    throw new Error(`agent not found: ${agentSlug}`);
  }
  return res.rows[0];
}

export type AssignTaskInput = {
  workspace: string;
  campaign: string;
  agent: string;
  title: string;
  slug?: string;
  payload?: Record<string, unknown>;
  actor?: string;
};

export async function assignTask(
  pool: pg.Pool,
  input: AssignTaskInput
): Promise<{ id: string; title: string; status: string; agent_slug: string }> {
  const actor = input.actor ?? "cli";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, input.workspace);
    const campaign = await resolveCampaign(client, workspaceId, input.campaign);
    const agent = await resolveAgent(client, workspaceId, input.agent);

    const res = await client.query<{ id: string; title: string; status: string }>(
      `INSERT INTO tasks (workspace_id, campaign_id, agent_id, slug, title, status, payload)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb)
       RETURNING id, title, status`,
      [
        workspaceId,
        campaign.id,
        agent.id,
        input.slug ?? null,
        input.title,
        JSON.stringify(input.payload ?? {}),
      ]
    );
    const task = res.rows[0];

    await emitEvent(client, {
      workspaceId,
      campaignId: campaign.id,
      eventType: "task.assigned",
      actor,
      payload: {
        task_id: task.id,
        title: task.title,
        agent: agent.slug,
        campaign: campaign.slug,
      },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "task.assign",
      entityType: "task",
      entityId: task.id,
      details: { title: task.title, agent: agent.slug, campaign: campaign.slug },
    });

    await client.query("COMMIT");
    return { ...task, agent_slug: agent.slug };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type TaskListRow = {
  id: string;
  slug: string | null;
  title: string;
  status: string;
  agent_slug: string | null;
  created_at: Date;
};

export async function listTasks(
  pool: pg.Pool,
  workspaceSlug: string,
  campaignSlug: string
): Promise<TaskListRow[]> {
  const workspaceId = await resolveWorkspaceId(pool, workspaceSlug);
  const campaign = await resolveCampaign(pool, workspaceId, campaignSlug);
  const res = await pool.query<TaskListRow>(
    `SELECT t.id, t.slug, t.title, t.status, a.slug AS agent_slug, t.created_at
     FROM tasks t
     LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.workspace_id = $1 AND t.campaign_id = $2 AND t.deleted_at IS NULL
     ORDER BY t.created_at DESC`,
    [workspaceId, campaign.id]
  );
  return res.rows;
}

export type CompleteTaskInput = {
  workspace: string;
  taskId: string;
  result?: Record<string, unknown>;
  actor?: string;
};

export async function completeTask(
  pool: pg.Pool,
  input: CompleteTaskInput
): Promise<{ id: string; status: string }> {
  const actor = input.actor ?? "cli";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, input.workspace);
    const task = await client.query<{
      id: string;
      status: string;
      campaign_id: string | null;
      title: string;
    }>(
      `SELECT id, status, campaign_id, title FROM tasks
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [workspaceId, input.taskId]
    );
    if (task.rows.length === 0) throw new Error(`task not found: ${input.taskId}`);
    const row = task.rows[0];
    if (row.status === "done") {
      throw new Error(`task already done: ${input.taskId}`);
    }

    const updated = await client.query<{ id: string; status: string }>(
      `UPDATE tasks
       SET status = 'done', result = $1::jsonb, updated_at = now()
       WHERE id = $2
       RETURNING id, status`,
      [JSON.stringify(input.result ?? {}), row.id]
    );

    await emitEvent(client, {
      workspaceId,
      campaignId: row.campaign_id,
      eventType: "task.completed",
      actor,
      payload: { task_id: row.id, title: row.title },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "task.complete",
      entityType: "task",
      entityId: row.id,
      details: { title: row.title },
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
