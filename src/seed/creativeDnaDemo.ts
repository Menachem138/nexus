import type { PoolClient } from "pg";

/** Realistic FRH Creative DNA fields used by Phase 1 acceptance (≥3 assets). */
export type FrhCreativeDna = {
  market: string;
  audience: string;
  awareness: string;
  emotion: string;
  angle: string;
  hook_type: string;
  visual_style: string;
  proof: string;
  offer: string;
  cta: string;
  format: string;
  hypothesis: string;
};

export type FrhDnaDemoCreative = {
  marketCode: string;
  slug: string;
  title: string;
  status: string;
  sterile_flags: unknown;
  ai_qa_status: string | null;
  human_taste: string | null;
  asset_meta: Record<string, unknown>;
  dna: FrhCreativeDna;
};

/** Three distinct FRH DNA demos: GF bill-pain (killed), GP UGC, RE clim editorial. */
export const FRH_DNA_DEMO_CREATIVES: FrhDnaDemoCreative[] = [
  {
    marketCode: "GF",
    slug: "GF-tomber-typo-poster-v1",
    title: "GF Tomber Typo Poster v1",
    status: "killed",
    sterile_flags: ["sterile_black_header", "generic_panel_macro"],
    ai_qa_status: "PASS",
    human_taste: "reject",
    asset_meta: {
      lesson: "AI QA PASS != human taste",
      format: "poster",
      angle: "bill_pain",
    },
    dna: {
      market: "GF",
      audience: "homeowners_bill_pain",
      awareness: "problem_aware",
      emotion: "frustration_relief",
      angle: "bill_pain",
      hook_type: "pain_statement",
      visual_style: "static_poster_typo",
      proof: "none",
      offer: "diagnostic_quote",
      cta: "demander_devis",
      format: "static",
      hypothesis:
        "Sterile black header + generic panel macro fails human taste despite AI QA PASS",
    },
  },
  {
    marketCode: "GP",
    slug: "GP-neighborhood-proof-ugc-v1",
    title: "GP Neighborhood Proof UGC v1",
    status: "approved",
    sterile_flags: [],
    ai_qa_status: "PASS",
    human_taste: "approve",
    asset_meta: {
      format: "ugc_video",
      angle: "neighborhood_proof",
    },
    dna: {
      market: "GP",
      audience: "neighbors_social_proof",
      awareness: "solution_aware",
      emotion: "trust_belonging",
      angle: "neighborhood_proof",
      hook_type: "ugc_testimonial",
      visual_style: "handheld_ugc",
      proof: "neighbor_install_story",
      offer: "free_site_visit",
      cta: "voir_autour_de_moi",
      format: "ugc_video",
      hypothesis:
        "Local neighbor proof outperforms brand-shot product beauty in GP",
    },
  },
  {
    marketCode: "RE",
    slug: "RE-ac-clim-editorial-v1",
    title: "RE AC/Clim Editorial v1",
    status: "draft",
    sterile_flags: [],
    ai_qa_status: "PASS",
    human_taste: null,
    asset_meta: {
      format: "editorial_static",
      angle: "ac_clim_relief",
    },
    dna: {
      market: "RE",
      audience: "hot_climate_households",
      awareness: "product_aware",
      emotion: "comfort_aspiration",
      angle: "ac_clim_relief",
      hook_type: "editorial_lifestyle",
      visual_style: "editorial_clim",
      proof: "energy_label",
      offer: "seasonal_install",
      cta: "reserver_visite",
      format: "editorial_static",
      hypothesis:
        "RE heat-season editorial clim framing lifts CTR vs generic product shots",
    },
  },
];

/**
 * Upsert ≥3 FRH creatives each with a creative_dna row (idempotent).
 * Returns creative ids keyed by slug.
 */
export async function upsertFrhCreativeDnaDemo(
  client: PoolClient,
  workspaceId: string
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};

  for (const demo of FRH_DNA_DEMO_CREATIVES) {
    const market = await client.query<{ id: string }>(
      `SELECT id FROM markets WHERE workspace_id = $1 AND code = $2`,
      [workspaceId, demo.marketCode]
    );
    if (!market.rows[0]) {
      throw new Error(
        `FRH DNA demo requires market ${demo.marketCode} in workspace ${workspaceId}`
      );
    }

    const creative = await client.query<{ id: string }>(
      `INSERT INTO creatives (
         workspace_id, market_id, slug, title, status,
         sterile_flags, ai_qa_status, human_taste, asset_meta
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7, $8, $9::jsonb
       )
       ON CONFLICT (workspace_id, slug) DO UPDATE
         SET status = EXCLUDED.status,
             sterile_flags = EXCLUDED.sterile_flags,
             ai_qa_status = EXCLUDED.ai_qa_status,
             human_taste = EXCLUDED.human_taste,
             asset_meta = EXCLUDED.asset_meta,
             market_id = EXCLUDED.market_id,
             updated_at = now()
       RETURNING id`,
      [
        workspaceId,
        market.rows[0].id,
        demo.slug,
        demo.title,
        demo.status,
        JSON.stringify(demo.sterile_flags),
        demo.ai_qa_status,
        demo.human_taste,
        JSON.stringify(demo.asset_meta),
      ]
    );

    const creativeId = creative.rows[0].id;
    ids[demo.slug] = creativeId;

    // Idempotent DNA: clear prior rows for this creative, then insert one.
    await client.query(`DELETE FROM creative_dna WHERE creative_id = $1`, [
      creativeId,
    ]);
    await client.query(
      `INSERT INTO creative_dna (workspace_id, creative_id, dna)
       VALUES ($1, $2, $3::jsonb)`,
      [workspaceId, creativeId, JSON.stringify(demo.dna)]
    );
  }

  return ids;
}

/** Count distinct live creative_dna rows for a workspace. */
export async function countCreativeDnaAssets(
  client: PoolClient,
  workspaceId: string
): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(DISTINCT creative_id)::text AS n FROM creative_dna
     WHERE workspace_id = $1 AND deleted_at IS NULL`,
    [workspaceId]
  );
  return Number(r.rows[0]?.n ?? 0);
}
