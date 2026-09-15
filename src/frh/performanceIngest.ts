/** Parse CSV stub → performance_daily (no paid Meta spend). */

import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import type { Db } from "../db/client.js";
import { emitEvent, writeAudit } from "../campaign/events.js";

export type PerformanceRow = {
  date: string;
  market_code: string;
  campaign_slug?: string | null;
  creative_slug?: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  qualified_leads: number;
  cpl: number | null;
  ql_cpl: number | null;
};

export type IngestResult = {
  workspaceId: string;
  file: string;
  inserted: number;
  updated: number;
  skipped: number;
  rows: PerformanceRow[];
};

async function resolveWorkspaceId(db: Db, workspaceSlug: string): Promise<string> {
  const ws = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [workspaceSlug]
  );
  if (ws.rows.length === 0) throw new Error(`workspace not found: ${workspaceSlug}`);
  return ws.rows[0].id;
}

function parseNum(v: string | undefined, fallback = 0): number {
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseNullableNum(v: string | undefined): number | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Minimal CSV parser (no quoted commas in stub fixtures). */
export function parsePerformanceCsv(text: string): PerformanceRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);

  for (const r of ["date", "market_code"]) {
    if (idx(r) < 0) throw new Error(`CSV missing required column: ${r}`);
  }

  const rows: PerformanceRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const get = (name: string) => {
      const j = idx(name);
      return j >= 0 ? cols[j] ?? "" : "";
    };
    const date = get("date");
    const market = get("market_code");
    if (!date || !market) {
      throw new Error(`CSV row ${i + 1}: date and market_code are required`);
    }
    rows.push({
      date,
      market_code: market,
      campaign_slug: get("campaign_slug") || null,
      creative_slug: get("creative_slug") || null,
      spend: parseNum(get("spend")),
      impressions: Math.round(parseNum(get("impressions"))),
      clicks: Math.round(parseNum(get("clicks"))),
      leads: Math.round(parseNum(get("leads"))),
      qualified_leads: Math.round(parseNum(get("qualified_leads"))),
      cpl: parseNullableNum(get("cpl")),
      ql_cpl: parseNullableNum(get("ql_cpl")),
    });
  }
  return rows;
}

export function parsePerformanceCsvFile(filePath: string): PerformanceRow[] {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`CSV file not found: ${abs}`);
  return parsePerformanceCsv(fs.readFileSync(abs, "utf8"));
}

async function resolveCampaignId(
  db: Db,
  workspaceId: string,
  slug: string | null | undefined
): Promise<string | null> {
  if (!slug) return null;
  const res = await db.query<{ id: string }>(
    `SELECT id FROM campaigns
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, slug]
  );
  return res.rows[0]?.id ?? null;
}

async function resolveCreativeId(
  db: Db,
  workspaceId: string,
  slug: string | null | undefined
): Promise<string | null> {
  if (!slug) return null;
  const res = await db.query<{ id: string }>(
    `SELECT id FROM creatives
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, slug]
  );
  return res.rows[0]?.id ?? null;
}

function deriveMetrics(row: PerformanceRow): {
  cpl: number | null;
  ql_cpl: number | null;
} {
  let cpl = row.cpl;
  let ql_cpl = row.ql_cpl;
  if (cpl === null && row.leads > 0) cpl = row.spend / row.leads;
  if (ql_cpl === null && row.qualified_leads > 0) {
    ql_cpl = row.spend / row.qualified_leads;
  }
  return { cpl, ql_cpl };
}

export async function ingestPerformanceCsv(
  pool: pg.Pool,
  opts: {
    workspace: string;
    file: string;
    source?: string;
    actor?: string;
  }
): Promise<IngestResult> {
  const actor = opts.actor ?? "cli";
  const source = opts.source ?? "csv_stub";
  const rows = parsePerformanceCsvFile(opts.file);
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  const skipped = 0;

  try {
    await client.query("BEGIN");
    const workspaceId = await resolveWorkspaceId(client, opts.workspace);

    for (const row of rows) {
      const campaignId = await resolveCampaignId(
        client,
        workspaceId,
        row.campaign_slug
      );
      const creativeId = await resolveCreativeId(
        client,
        workspaceId,
        row.creative_slug
      );
      const { cpl, ql_cpl } = deriveMetrics(row);

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM performance_daily
         WHERE workspace_id = $1
           AND date = $2::date
           AND market_code = $3
           AND COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)
               = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           AND COALESCE(creative_id, '00000000-0000-0000-0000-000000000000'::uuid)
               = COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           AND source = $6`,
        [workspaceId, row.date, row.market_code, campaignId, creativeId, source]
      );

      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE performance_daily SET
             spend = $1, impressions = $2, clicks = $3,
             leads = $4, qualified_leads = $5, cpl = $6, ql_cpl = $7
           WHERE id = $8`,
          [
            row.spend,
            row.impressions,
            row.clicks,
            row.leads,
            row.qualified_leads,
            cpl,
            ql_cpl,
            existing.rows[0].id,
          ]
        );
        updated += 1;
      } else {
        await client.query(
          `INSERT INTO performance_daily (
             workspace_id, market_code, campaign_id, creative_id, date,
             spend, impressions, clicks, leads, qualified_leads, cpl, ql_cpl, source
           ) VALUES (
             $1, $2, $3, $4, $5::date,
             $6, $7, $8, $9, $10, $11, $12, $13
           )`,
          [
            workspaceId,
            row.market_code,
            campaignId,
            creativeId,
            row.date,
            row.spend,
            row.impressions,
            row.clicks,
            row.leads,
            row.qualified_leads,
            cpl,
            ql_cpl,
            source,
          ]
        );
        inserted += 1;
      }
    }

    await emitEvent(client, {
      workspaceId,
      eventType: "performance.ingested",
      actor,
      payload: {
        file: opts.file,
        source,
        inserted,
        updated,
        row_count: rows.length,
      },
    });

    await writeAudit(client, {
      workspaceId,
      actor,
      action: "performance.ingest",
      entityType: "performance_daily",
      details: {
        file: opts.file,
        source,
        inserted,
        updated,
        skipped,
        row_count: rows.length,
      },
    });

    await client.query("COMMIT");
    return {
      workspaceId,
      file: opts.file,
      inserted,
      updated,
      skipped,
      rows,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
