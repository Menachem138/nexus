/** Write insights with epistemic + decay fields from performance + kills. */

import type pg from "pg";
import type { Db } from "../db/client.js";
import { emitEvent, writeAudit } from "../campaign/events.js";

export type LearningInsight = {
  id: string;
  slug: string;
  title: string;
  epistemic_class: string;
  evidence_class: string;
  confidence: number;
  decay_halflife_days: number;
  decay_score: number;
};

export type LearningsResult = {
  workspaceId: string;
  market: string;
  insights: LearningInsight[];
  fromPerformance: number;
  fromKills: number;
};

async function resolveWorkspaceId(db: Db, workspaceSlug: string): Promise<string> {
  const ws = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [workspaceSlug]
  );
  if (ws.rows.length === 0) throw new Error(`workspace not found: ${workspaceSlug}`);
  return ws.rows[0].id;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function upsertInsight(
  db: Db,
  row: {
    workspaceId: string;
    campaignId: string | null;
    creativeId: string | null;
    slug: string;
    title: string;
    body: string;
    epistemicClass: string;
    evidenceClass: string;
    confidence: number;
    decayHalflifeDays: number;
    decayScore: number;
    tags: unknown[];
    metadata: Record<string, unknown>;
  }
): Promise<LearningInsight> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM insights
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [row.workspaceId, row.slug]
  );

  if (existing.rows.length > 0) {
    const updated = await db.query<LearningInsight>(
      `UPDATE insights SET
         title = $1,
         body = $2,
         epistemic_class = $3,
         evidence_class = $4,
         confidence = $5,
         decay_halflife_days = $6,
         decay_score = $7,
         last_reinforced_at = now(),
         tags = $8::jsonb,
         metadata = $9::jsonb,
         campaign_id = COALESCE($10::uuid, campaign_id),
         creative_id = COALESCE($11::uuid, creative_id),
         updated_at = now()
       WHERE id = $12
       RETURNING id, slug, title, epistemic_class, evidence_class,
                 confidence::float8 AS confidence,
                 decay_halflife_days::float8 AS decay_halflife_days,
                 decay_score::float8 AS decay_score`,
      [
        row.title,
        row.body,
        row.epistemicClass,
        row.evidenceClass,
        row.confidence,
        row.decayHalflifeDays,
        row.decayScore,
        JSON.stringify(row.tags),
        JSON.stringify(row.metadata),
        row.campaignId,
        row.creativeId,
        existing.rows[0].id,
      ]
    );
    return { ...updated.rows[0], slug: row.slug };
  }

  const inserted = await db.query<LearningInsight>(
    `INSERT INTO insights (
       workspace_id, campaign_id, creative_id, slug, title, body,
       epistemic_class, evidence_class, confidence,
       decay_halflife_days, decay_score, last_reinforced_at, tags, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11, now(), $12::jsonb, $13::jsonb
     )
     RETURNING id, slug, title, epistemic_class, evidence_class,
               confidence::float8 AS confidence,
               decay_halflife_days::float8 AS decay_halflife_days,
               decay_score::float8 AS decay_score`,
    [
      row.workspaceId,
      row.campaignId,
      row.creativeId,
      row.slug,
      row.title,
      row.body,
      row.epistemicClass,
      row.evidenceClass,
      row.confidence,
      row.decayHalflifeDays,
      row.decayScore,
      JSON.stringify(row.tags),
      JSON.stringify(row.metadata),
    ]
  );
  return inserted.rows[0];
}

/**
 * Derive learnings from performance_daily aggregates + killed creatives
 * for a market. Writes/updates insights with epistemic + decay fields.
 */
export async function learningsFromPerformance(
  pool: pg.Pool,
  opts: {
    workspace: string;
    market: string;
    actor?: string;
  }
): Promise<LearningsResult> {
  const actor = opts.actor ?? "cli";
  const market = opts.market.toUpperCase();
  const client = await pool.connect();
  const insights: LearningInsight[] = [];
  let fromPerformance = 0;
  let fromKills = 0;

  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, opts.workspace);

    const perf = await client.query<{
      campaign_id: string | null;
      total_spend: string;
      total_leads: string;
      total_ql: string;
      avg_cpl: string | null;
      avg_ql_cpl: string | null;
      days: string;
    }>(
      `SELECT
         campaign_id,
         COALESCE(SUM(spend), 0)::text AS total_spend,
         COALESCE(SUM(leads), 0)::text AS total_leads,
         COALESCE(SUM(qualified_leads), 0)::text AS total_ql,
         AVG(cpl)::text AS avg_cpl,
         AVG(ql_cpl)::text AS avg_ql_cpl,
         COUNT(*)::text AS days
       FROM performance_daily
       WHERE workspace_id = $1 AND market_code = $2
       GROUP BY campaign_id`,
      [workspaceId, market]
    );

    for (const row of perf.rows) {
      const spend = Number(row.total_spend);
      const leads = Number(row.total_leads);
      const ql = Number(row.total_ql);
      const avgCpl = row.avg_cpl !== null ? Number(row.avg_cpl) : null;
      const days = Number(row.days);

      let title: string;
      let body: string;
      let epistemic = "hypothesis";
      let evidence = "observational";
      let confidence = 0.55;
      let decayHalflife = 21;

      if (leads === 0 && spend > 0) {
        title = `${market}: spend without leads (stub)`;
        body = `Over ${days} day(s) market ${market} spent ${spend.toFixed(2)} with 0 leads (csv_stub). Investigate creative/offer fit before live spend.`;
        epistemic = "warning";
        evidence = "stub_performance";
        confidence = 0.7;
        decayHalflife = 14;
      } else if (avgCpl !== null && avgCpl > 20) {
        title = `${market}: elevated CPL on stub data`;
        body = `Avg CPL ${avgCpl.toFixed(2)} across ${days} day(s) (spend=${spend.toFixed(2)}, leads=${leads}, QL=${ql}). Prefer stronger hooks; reinforce kill-library lessons before scaling.`;
        epistemic = "hypothesis";
        evidence = "stub_performance";
        confidence = 0.62;
        decayHalflife = 21;
      } else {
        title = `${market}: stub performance baseline`;
        body = `Stub ingest: ${days} day(s), spend=${spend.toFixed(2)}, leads=${leads}, QL=${ql}, avg_cpl=${avgCpl?.toFixed(2) ?? "n/a"}. Treat as provisional until Meta ingest.`;
        epistemic = "observation";
        evidence = "stub_performance";
        confidence = 0.5;
        decayHalflife = 30;
      }

      const slug = slugify(
        `perf-${market}-${row.campaign_id ?? "market"}-${title}`.slice(0, 60)
      );

      const insight = await upsertInsight(client, {
        workspaceId,
        campaignId: row.campaign_id,
        creativeId: null,
        slug,
        title,
        body,
        epistemicClass: epistemic,
        evidenceClass: evidence,
        confidence,
        decayHalflifeDays: decayHalflife,
        decayScore: 1.0,
        tags: ["performance", "csv_stub", market.toLowerCase()],
        metadata: {
          source: "learnings.from-performance",
          market,
          spend,
          leads,
          qualified_leads: ql,
          avg_cpl: avgCpl,
          days,
        },
      });
      insights.push(insight);
      fromPerformance += 1;
    }

    const kills = await client.query<{
      id: string;
      slug: string;
      title: string | null;
      sterile_flags: unknown;
      campaign_id: string | null;
    }>(
      `SELECT c.id, c.slug, c.title, c.sterile_flags, c.campaign_id
       FROM creatives c
       JOIN markets m ON m.id = c.market_id
       WHERE c.workspace_id = $1
         AND m.code = $2
         AND c.status = 'killed'
         AND c.deleted_at IS NULL`,
      [workspaceId, market]
    );

    for (const k of kills.rows) {
      const slug = slugify(`kill-lesson-${k.slug}`);
      const flags = Array.isArray(k.sterile_flags)
        ? (k.sterile_flags as string[])
        : [];
      const title = `${market} kill lesson: ${k.slug}`;
      const body = [
        `Creative ${k.slug} is killed.`,
        flags.length ? `Sterile flags: ${flags.join(", ")}.` : "No sterile flags recorded.",
        "Do not repeat this pattern; reinforce via decay-aware insight until half-life expires.",
      ].join(" ");

      const insight = await upsertInsight(client, {
        workspaceId,
        campaignId: k.campaign_id,
        creativeId: k.id,
        slug,
        title,
        body,
        epistemicClass: "lesson",
        evidenceClass: "case_study",
        confidence: 0.8,
        decayHalflifeDays: 45,
        decayScore: 1.0,
        tags: ["kill", "sterile", market.toLowerCase(), ...flags],
        metadata: {
          source: "learnings.from-performance",
          creative_slug: k.slug,
          sterile_flags: flags,
          market,
        },
      });
      insights.push(insight);
      fromKills += 1;
    }

    await emitEvent(client, {
      workspaceId,
      eventType: "learnings.written",
      actor,
      payload: {
        market,
        from_performance: fromPerformance,
        from_kills: fromKills,
        insight_ids: insights.map((i) => i.id),
      },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "learnings.from_performance",
      entityType: "insight",
      details: {
        market,
        from_performance: fromPerformance,
        from_kills: fromKills,
        count: insights.length,
      },
    });

    await client.query("COMMIT");
    return {
      workspaceId,
      market,
      insights,
      fromPerformance,
      fromKills,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
