import type pg from "pg";
import type { Db } from "../db/client.js";

export type AuditGap = {
  kind: "campaign_transition" | "creative_gate" | "council_decide";
  entityId: string;
  entityLabel: string;
  at: string;
  expectedAction: string;
};

export type AuditKindStats = {
  kind: string;
  scanned: number;
  matched: number;
  gaps: number;
  pctMatched: number;
};

export type AuditReport = {
  workspace: string;
  workspaceId: string;
  days: number;
  since: string;
  kinds: AuditKindStats[];
  gaps: AuditGap[];
  overallPctMatched: number;
  ok: boolean;
  message: string;
};

async function resolveWorkspace(
  db: Db,
  slug: string
): Promise<{ id: string; slug: string }> {
  const res = await db.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );
  if (res.rows.length === 0) throw new Error(`workspace not found: ${slug}`);
  return res.rows[0];
}

function pct(matched: number, scanned: number): number {
  if (scanned === 0) return 100;
  return Math.round((matched / scanned) * 1000) / 10;
}

/**
 * Scan recent campaign transitions, creative gate actions, and council
 * decisions; report what percentage have matching audit_log rows; flag gaps.
 */
export async function runAuditCompleteness(
  pool: pg.Pool,
  opts: { workspace: string; days?: number }
): Promise<AuditReport> {
  const days = opts.days ?? 7;
  const ws = await resolveWorkspace(pool, opts.workspace);
  const sinceRes = await pool.query<{ since: Date }>(
    `SELECT (now() - ($1::text || ' days')::interval) AS since`,
    [String(days)]
  );
  const since = sinceRes.rows[0].since;

  const gaps: AuditGap[] = [];
  const kinds: AuditKindStats[] = [];

  // ── campaign transitions ────────────────────────────────────────────────
  const transitions = await pool.query<{
    id: string;
    campaign_id: string;
    slug: string;
    created_at: Date;
  }>(
    `SELECT h.id::text AS id, h.campaign_id::text AS campaign_id,
            c.slug, h.created_at
     FROM campaign_status_history h
     JOIN campaigns c ON c.id = h.campaign_id
     WHERE h.workspace_id = $1 AND h.created_at >= $2
     ORDER BY h.created_at DESC`,
    [ws.id, since]
  );

  let transitionMatched = 0;
  for (const row of transitions.rows) {
    const audit = await pool.query(
      `SELECT 1 FROM audit_log
       WHERE workspace_id = $1
         AND action = 'campaign.transition'
         AND entity_id = $2::uuid
         AND created_at BETWEEN $3::timestamptz - interval '5 seconds'
                            AND $3::timestamptz + interval '5 seconds'
       LIMIT 1`,
      [ws.id, row.campaign_id, row.created_at]
    );
    if (audit.rows.length > 0) {
      transitionMatched += 1;
    } else {
      gaps.push({
        kind: "campaign_transition",
        entityId: row.campaign_id,
        entityLabel: row.slug,
        at: row.created_at.toISOString(),
        expectedAction: "campaign.transition",
      });
    }
  }
  kinds.push({
    kind: "campaign_transition",
    scanned: transitions.rows.length,
    matched: transitionMatched,
    gaps: transitions.rows.length - transitionMatched,
    pctMatched: pct(transitionMatched, transitions.rows.length),
  });

  // ── creative gates ──────────────────────────────────────────────────────
  const gates = await pool.query<{
    id: string;
    creative_id: string;
    slug: string;
    action: string;
    created_at: Date;
  }>(
    `SELECT g.id::text AS id, g.creative_id::text AS creative_id,
            c.slug, g.action, g.created_at
     FROM creative_gate_actions g
     JOIN creatives c ON c.id = g.creative_id
     WHERE g.workspace_id = $1 AND g.created_at >= $2
     ORDER BY g.created_at DESC`,
    [ws.id, since]
  );

  let gateMatched = 0;
  for (const row of gates.rows) {
    const expected =
      row.action === "kill" ? "creative.kill" : "creative.approve";
    const audit = await pool.query(
      `SELECT 1 FROM audit_log
       WHERE workspace_id = $1
         AND action = $2
         AND entity_id = $3::uuid
         AND created_at BETWEEN $4::timestamptz - interval '5 seconds'
                            AND $4::timestamptz + interval '5 seconds'
       LIMIT 1`,
      [ws.id, expected, row.creative_id, row.created_at]
    );
    if (audit.rows.length > 0) {
      gateMatched += 1;
    } else {
      gaps.push({
        kind: "creative_gate",
        entityId: row.creative_id,
        entityLabel: `${row.slug}:${row.action}`,
        at: row.created_at.toISOString(),
        expectedAction: expected,
      });
    }
  }
  kinds.push({
    kind: "creative_gate",
    scanned: gates.rows.length,
    matched: gateMatched,
    gaps: gates.rows.length - gateMatched,
    pctMatched: pct(gateMatched, gates.rows.length),
  });

  // ── council decides ─────────────────────────────────────────────────────
  const decides = await pool.query<{
    id: string;
    slug: string;
    updated_at: Date;
  }>(
    `SELECT id::text AS id, slug, updated_at
     FROM council_cases
     WHERE workspace_id = $1
       AND status = 'decided'
       AND updated_at >= $2
       AND deleted_at IS NULL
     ORDER BY updated_at DESC`,
    [ws.id, since]
  );

  let decideMatched = 0;
  for (const row of decides.rows) {
    const audit = await pool.query(
      `SELECT 1 FROM audit_log
       WHERE workspace_id = $1
         AND action = 'council.decide'
         AND entity_id = $2::uuid
       LIMIT 1`,
      [ws.id, row.id]
    );
    if (audit.rows.length > 0) {
      decideMatched += 1;
    } else {
      gaps.push({
        kind: "council_decide",
        entityId: row.id,
        entityLabel: row.slug,
        at: row.updated_at.toISOString(),
        expectedAction: "council.decide",
      });
    }
  }
  kinds.push({
    kind: "council_decide",
    scanned: decides.rows.length,
    matched: decideMatched,
    gaps: decides.rows.length - decideMatched,
    pctMatched: pct(decideMatched, decides.rows.length),
  });

  const scannedTotal = kinds.reduce((s, k) => s + k.scanned, 0);
  const matchedTotal = kinds.reduce((s, k) => s + k.matched, 0);
  const overallPctMatched = pct(matchedTotal, scannedTotal);
  const ok = gaps.length === 0;
  const message = ok
    ? `audit completeness OK — ${matchedTotal}/${scannedTotal} (${overallPctMatched}%) matched`
    : `audit gaps: ${gaps.length} missing audit_log rows (${overallPctMatched}% matched)`;

  return {
    workspace: ws.slug,
    workspaceId: ws.id,
    days,
    since: since.toISOString(),
    kinds,
    gaps,
    overallPctMatched,
    ok,
    message,
  };
}

/** Pure helper for unit tests — compute match % from counts. */
export function computeAuditStats(
  scanned: number,
  matched: number
): { scanned: number; matched: number; gaps: number; pctMatched: number } {
  return {
    scanned,
    matched,
    gaps: Math.max(0, scanned - matched),
    pctMatched: pct(matched, scanned),
  };
}
