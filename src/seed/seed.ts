
import { createPool } from "../db/client.js";

async function seed() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ws = await client.query(
      `INSERT INTO workspaces (slug, name, description) VALUES
         ('core', 'NEXUS Core', 'Platform / shared workspace'),
         ('frh',  'FRH',        'FRH brand workspace')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug`
    );
    const wsId = Object.fromEntries(ws.rows.map((r) => [r.slug, r.id]));
    console.log("workspaces:", ws.rows.map((r) => r.slug).join(", "));

    const managersPolicy = {
      tier: "managers",
      prefer: "astra6",
      notes: "director-grade",
      escalation_ladder: ["astra"],
      confidence_threshold: 0.9,
      start_at: "astra",
      skip_cheap: true,
    };
    const cheapPolicy = {
      tier: "economy",
      prefer: "cheap",
      notes: "cost-first routing",
      escalation_ladder: ["qwen-local", "glm", "specialist", "astra"],
      confidence_threshold: 0.9,
      start_at: "qwen-local",
      skip_cheap: false,
    };
    await client.query(
      `INSERT INTO model_policies (workspace_id, slug, name, policy, is_default) VALUES
         ($1, 'managers-astra6', 'Managers Astra6', $3::jsonb, true),
         ($1, 'cheap-first',     'Cheap First',     $4::jsonb, false),
         ($2, 'managers-astra6', 'Managers Astra6', $3::jsonb, true),
         ($2, 'cheap-first',     'Cheap First',     $4::jsonb, false)
       ON CONFLICT (workspace_id, slug) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now()`,
      [wsId.core, wsId.frh, JSON.stringify(managersPolicy), JSON.stringify(cheapPolicy)]
    );
    console.log("policies: managers-astra6, cheap-first");

    const frhMgr = (
      await client.query(
        `SELECT id FROM model_policies WHERE workspace_id = $1 AND slug = 'managers-astra6'`,
        [wsId.frh]
      )
    ).rows[0].id;

    const directors = [
      ["global-cmo", "Global CMO", "cmo", "executive"],
      ["intelligence", "Intelligence Director", "director", "director"],
      ["strategy", "Strategy Director", "director", "director"],
      ["creative", "Creative Director", "director", "director"],
      ["production", "Production Director", "director", "director"],
      ["performance", "Performance Director", "director", "director"],
      ["experimentation", "Experimentation Director", "director", "director"],
      ["knowledge", "Knowledge Director", "director", "director"],
      ["simulation", "Simulation Director", "director", "director"],
    ];

    for (const [slug, name, role, kind] of directors) {
      await client.query(
        `INSERT INTO agents (workspace_id, slug, name, role, kind, policy_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name`,
        [wsId.frh, slug, name, role, kind, frhMgr]
      );
    }

    const dualRun = [
      ["stratege-creative", "FRH Stratège Creative", "frh-grok:stratege-creative", true],
      ["copy-fr", "FRH Copy FR", "frh-grok:copy-fr", true],
      ["art-director", "FRH Art Director", "frh-grok:art-director", true],
      ["image-studio", "FRH Image Studio", "frh-grok:image-studio", true],
      ["video-studio", "FRH Video Studio", "frh-grok:video-studio", true],
      ["creative-qa", "FRH Creative QA", "frh-grok:creative-qa", true],
    ];

    const frhCheap = (
      await client.query(
        `SELECT id FROM model_policies WHERE workspace_id = $1 AND slug = 'cheap-first'`,
        [wsId.frh]
      )
    ).rows[0].id;

    for (const [slug, name, seedSource, dual] of dualRun) {
      await client.query(
        `INSERT INTO agents (workspace_id, slug, name, role, kind, seed_source, dual_run, policy_id)
         VALUES ($1, $2, $3, 'specialist', 'specialist', $4, $5, $6)
         ON CONFLICT (workspace_id, slug) DO UPDATE
           SET seed_source = EXCLUDED.seed_source, dual_run = EXCLUDED.dual_run,
               policy_id = EXCLUDED.policy_id`,
        [wsId.frh, slug, name, seedSource, dual, frhCheap]
      );
    }
    console.log("agents: directors + dual_run specialists");

    const markets = [
      ["GP", "Guadeloupe", "fr-GP"],
      ["MQ", "Martinique", "fr-MQ"],
      ["GF", "Guyane Francaise", "fr-GF"],
      ["RE", "La Reunion", "fr-RE"],
      ["CORSE", "Corse", "fr-CORSE"],
    ];

    for (const [code, name, locale] of markets) {
      const m = await client.query(
        `INSERT INTO markets (workspace_id, code, name, locale)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [wsId.frh, code, name, locale]
      );
      await client.query(
        `INSERT INTO market_twins (workspace_id, market_id, slug, status, twin_data)
         VALUES ($1, $2, $3, 'stub', '{"phase":0,"notes":"twin stub"}'::jsonb)
         ON CONFLICT (workspace_id, slug) DO NOTHING`,
        [wsId.frh, m.rows[0].id, "twin-" + code.toLowerCase()]
      );
    }
    console.log("markets: GP MQ GF RE CORSE + twin stubs");

    await client.query(
      `INSERT INTO frh_profiles (workspace_id, slug, display_name, profile)
       VALUES ($1, 'default', 'FRH Default Profile', '{"phase":0,"stub":true}'::jsonb)
       ON CONFLICT (workspace_id, slug) DO NOTHING`,
      [wsId.frh]
    );

    const gf = (
      await client.query(
        `SELECT id FROM markets WHERE workspace_id = $1 AND code = 'GF'`,
        [wsId.frh]
      )
    ).rows[0].id;

    const creative = await client.query(
      `INSERT INTO creatives (
         workspace_id, market_id, slug, title, status,
         sterile_flags, ai_qa_status, human_taste, asset_meta
       ) VALUES (
         $1, $2, 'GF-tomber-typo-poster-v1', 'GF Tomber Typo Poster v1', 'killed',
         '["sterile_black_header","generic_panel_macro"]'::jsonb,
         'PASS',
         'reject',
         '{"lesson":"AI QA PASS != human taste","format":"poster"}'::jsonb
       )
       ON CONFLICT (workspace_id, slug) DO UPDATE
         SET status = 'killed',
             sterile_flags = EXCLUDED.sterile_flags,
             ai_qa_status = EXCLUDED.ai_qa_status,
             human_taste = EXCLUDED.human_taste
       RETURNING id`,
      [wsId.frh, gf]
    );

    await client.query(`DELETE FROM creative_dna WHERE creative_id = $1`, [creative.rows[0].id]);
    await client.query(
      `INSERT INTO creative_dna (workspace_id, creative_id, dna)
       VALUES ($1, $2, $3::jsonb)`,
      [
        wsId.frh,
        creative.rows[0].id,
        JSON.stringify({
          layout: "poster",
          header: "sterile_black",
          panel: "generic_macro",
          typography: "tomber",
        }),
      ]
    );

    await client.query(
      `DELETE FROM insights WHERE workspace_id = $1 AND slug = 'gf-sterile-header-lesson'`,
      [wsId.frh]
    );
    await client.query(
      `INSERT INTO insights (
         workspace_id, creative_id, slug, title, body,
         epistemic_class, evidence_class, confidence,
         decay_halflife_days, decay_score, tags, metadata
       ) VALUES (
         $1, $2, 'gf-sterile-header-lesson',
         'Sterile black header + generic panel macro fails human taste',
         'Creative GF-tomber-typo-poster-v1 was killed despite AI QA PASS. Sterile black header and generic panel macro read as cold/templated; AI QA PASS does not equal human taste.',
         'lesson', 'case_study', 0.820,
         45, 1.0000,
         '["sterile_flags","human_taste","gf","poster"]'::jsonb,
         '{"ai_qa":"PASS","human":"reject","sterile_flags":["sterile_black_header","generic_panel_macro"]}'::jsonb
       )`,
      [wsId.frh, creative.rows[0].id]
    );
    console.log("learning fixture: GF-tomber-typo-poster-v1 killed + insight");

    await client.query("COMMIT");
    console.log("seed: complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
