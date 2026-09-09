import type { Db } from "../db/client.js";

export type EmitEventInput = {
  workspaceId: string;
  campaignId?: string | null;
  eventType: string;
  actor?: string | null;
  payload?: Record<string, unknown>;
};

/** Insert a row into events. Accepts Pool or PoolClient. */
export async function emitEvent(db: Db, input: EmitEventInput): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO events (workspace_id, campaign_id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      input.workspaceId,
      input.campaignId ?? null,
      input.eventType,
      input.actor ?? null,
      JSON.stringify(input.payload ?? {}),
    ]
  );
  return res.rows[0].id;
}

export async function writeAudit(
  db: Db,
  opts: {
    workspaceId: string;
    actor: string;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    details?: Record<string, unknown>;
  }
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO audit_log (workspace_id, actor, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      opts.workspaceId,
      opts.actor,
      opts.action,
      opts.entityType ?? null,
      opts.entityId ?? null,
      JSON.stringify(opts.details ?? {}),
    ]
  );
  return res.rows[0].id;
}
