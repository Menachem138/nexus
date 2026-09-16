import type pg from "pg";
import type { Db } from "../db/client.js";

export type DigestPayload = {
  workspace: string;
  digestDate: string;
  campaignsChanged: Array<{ slug: string; from: string; to: string }>;
  councilsDecided: Array<{ slug: string; topic: string }>;
  kills: Array<{ slug: string; reason: string | null }>;
  tasksOpen: number;
  invocationsCount: number;
};

export type DigestResult = {
  workspaceId: string;
  digestDate: string;
  bodyHe: string;
  bodyEn: string;
  payload: DigestPayload;
  digestRunId?: string;
};

async function resolveWorkspaceId(db: Db, slug: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );
  if (res.rows.length === 0) throw new Error(`workspace not found: ${slug}`);
  return res.rows[0].id;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDigestDate(dateStr?: string): { dayStart: Date; dayEnd: Date; ymd: string } {
  let base: Date;
  if (dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) throw new Error(`invalid --date (want YYYY-MM-DD): ${dateStr}`);
    base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  } else {
    // default: yesterday (UTC date)
    const now = new Date();
    base = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
    );
  }
  const dayStart = base;
  const dayEnd = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd, ymd: ymd(base) };
}

/**
 * Build Hebrew (+ optional EN) daily digest for a workspace covering the
 * given calendar day (default: yesterday): campaigns changed, councils
 * decided, kills, open tasks, invocation count.
 */
export async function buildDailyDigest(
  pool: pg.Pool,
  opts: {
    workspace: string;
    date?: string;
    persist?: boolean;
    includeEn?: boolean;
  }
): Promise<DigestResult> {
  const workspaceId = await resolveWorkspaceId(pool, opts.workspace);
  const { dayStart, dayEnd, ymd: digestDate } = parseDigestDate(opts.date);

  const campaignsChanged = (
    await pool.query<{ slug: string; from_status: string; to_status: string }>(
      `SELECT c.slug, h.from_status, h.to_status
       FROM campaign_status_history h
       JOIN campaigns c ON c.id = h.campaign_id
       WHERE h.workspace_id = $1
         AND h.created_at >= $2 AND h.created_at < $3
       ORDER BY h.created_at`,
      [workspaceId, dayStart, dayEnd]
    )
  ).rows.map((r) => ({
    slug: r.slug,
    from: r.from_status,
    to: r.to_status,
  }));

  const councilsDecided = (
    await pool.query<{ slug: string; topic: string }>(
      `SELECT slug, topic FROM council_cases
       WHERE workspace_id = $1
         AND status = 'decided'
         AND updated_at >= $2 AND updated_at < $3
         AND deleted_at IS NULL
       ORDER BY updated_at`,
      [workspaceId, dayStart, dayEnd]
    )
  ).rows;

  const kills = (
    await pool.query<{ slug: string; reason: string | null }>(
      `SELECT c.slug, g.reason
       FROM creative_gate_actions g
       JOIN creatives c ON c.id = g.creative_id
       WHERE g.workspace_id = $1
         AND g.action = 'kill'
         AND g.created_at >= $2 AND g.created_at < $3
       ORDER BY g.created_at`,
      [workspaceId, dayStart, dayEnd]
    )
  ).rows;

  const tasksOpenRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tasks
     WHERE workspace_id = $1
       AND status IN ('pending', 'open', 'assigned', 'in_progress')
       AND deleted_at IS NULL`,
    [workspaceId]
  );
  const tasksOpen = Number(tasksOpenRes.rows[0]?.n ?? 0);

  const invRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM model_invocations
     WHERE workspace_id = $1
       AND created_at >= $2 AND created_at < $3`,
    [workspaceId, dayStart, dayEnd]
  );
  const invocationsCount = Number(invRes.rows[0]?.n ?? 0);

  const payload: DigestPayload = {
    workspace: opts.workspace,
    digestDate,
    campaignsChanged,
    councilsDecided,
    kills,
    tasksOpen,
    invocationsCount,
  };

  const bodyHe = formatDigestHe(payload);
  const bodyEn =
    opts.includeEn === false ? "" : formatDigestEn(payload);

  let digestRunId: string | undefined;
  if (opts.persist !== false) {
    const upsert = await pool.query<{ id: string }>(
      `INSERT INTO digest_runs (workspace_id, digest_date, body_he, body_en, payload)
       VALUES ($1, $2::date, $3, $4, $5::jsonb)
       ON CONFLICT (workspace_id, digest_date) DO UPDATE
         SET body_he = EXCLUDED.body_he,
             body_en = EXCLUDED.body_en,
             payload = EXCLUDED.payload
       RETURNING id`,
      [
        workspaceId,
        digestDate,
        bodyHe,
        bodyEn || null,
        JSON.stringify(payload),
      ]
    );
    digestRunId = upsert.rows[0]?.id;
  }

  return {
    workspaceId,
    digestDate,
    bodyHe,
    bodyEn,
    payload,
    digestRunId,
  };
}

export function formatDigestHe(p: DigestPayload): string {
  const lines: string[] = [];
  lines.push(`# סיכום יומי NEXUS — ${p.workspace} — ${p.digestDate}`);
  lines.push("");
  lines.push("## קמפיינים שהשתנו");
  if (p.campaignsChanged.length === 0) {
    lines.push("- אין שינויי סטטוס");
  } else {
    for (const c of p.campaignsChanged) {
      lines.push(`- ${c.slug}: ${c.from} → ${c.to}`);
    }
  }
  lines.push("");
  lines.push("## החלטות מועצה");
  if (p.councilsDecided.length === 0) {
    lines.push("- אין החלטות");
  } else {
    for (const c of p.councilsDecided) {
      lines.push(`- ${c.slug}: ${c.topic}`);
    }
  }
  lines.push("");
  lines.push("## קריאייטיבים שנפסלו (kills)");
  if (p.kills.length === 0) {
    lines.push("- אין פסילות");
  } else {
    for (const k of p.kills) {
      lines.push(`- ${k.slug}${k.reason ? ` — ${k.reason}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## משימות פתוחות");
  lines.push(`- ${p.tasksOpen} משימות פתוחות`);
  lines.push("");
  lines.push("## קריאות מודל");
  lines.push(`- ${p.invocationsCount} invocations`);
  lines.push("");
  return lines.join("\n");
}

export function formatDigestEn(p: DigestPayload): string {
  const lines: string[] = [];
  lines.push(`# NEXUS daily digest — ${p.workspace} — ${p.digestDate}`);
  lines.push("");
  lines.push("## Campaigns changed");
  if (p.campaignsChanged.length === 0) {
    lines.push("- none");
  } else {
    for (const c of p.campaignsChanged) {
      lines.push(`- ${c.slug}: ${c.from} → ${c.to}`);
    }
  }
  lines.push("");
  lines.push("## Councils decided");
  if (p.councilsDecided.length === 0) {
    lines.push("- none");
  } else {
    for (const c of p.councilsDecided) {
      lines.push(`- ${c.slug}: ${c.topic}`);
    }
  }
  lines.push("");
  lines.push("## Creative kills");
  if (p.kills.length === 0) {
    lines.push("- none");
  } else {
    for (const k of p.kills) {
      lines.push(`- ${k.slug}${k.reason ? ` — ${k.reason}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## Open tasks");
  lines.push(`- ${p.tasksOpen} open`);
  lines.push("");
  lines.push("## Model invocations");
  lines.push(`- ${p.invocationsCount} invocations`);
  lines.push("");
  return lines.join("\n");
}

/** Detect Hebrew characters (for tests). */
export function containsHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text);
}
