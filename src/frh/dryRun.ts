/** FRH E2E dry-run on GF — no paid spend. Dual-run specialists vs directors. */

import type pg from "pg";
import type { Db } from "../db/client.js";
import { transitionCampaign, canTransition } from "../campaign/states.js";
import { openCase } from "../campaign/council.js";
import { emitEvent, writeAudit } from "../campaign/events.js";
import { invokeAgent } from "../router/invoke.js";
import { validateHandoff } from "../router/handoff.js";
import type { InvokeResult } from "../router/types.js";

const CONFIDENCE_COUNCIL_THRESHOLD = 0.75;

/** Happy path enforced for Week 3 dry-run */
const TRANSITION_PATH = ["research", "strategy", "creative"] as const;

/** Dual-run pairs: seed specialist (dual_run) vs NEXUS director */
const DUAL_RUN_PAIRS: Array<{
  stage: "strategy" | "creative";
  specialist: string;
  director: string;
  prompt: string;
}> = [
  {
    stage: "strategy",
    specialist: "stratege-creative",
    director: "strategy",
    prompt:
      "GF dry-run: diagnose offer/angle for Guyane. Prefer structured handoff. No spend.",
  },
  {
    stage: "creative",
    specialist: "art-director",
    director: "creative",
    prompt:
      "GF dry-run: propose creative direction avoiding sterile black header / generic panel macro. No spend.",
  },
];

export type DualRunInvocation = {
  stage: string;
  role: "specialist" | "director";
  agent: string;
  dual_run: boolean;
  ok: boolean;
  confidence: number;
  council_recommended: boolean;
  resolved_model: string;
  handoff_id: string | null;
  handoff_valid: boolean;
};

export type DryRunResult = {
  workspace: string;
  market: string;
  campaign: {
    id: string;
    slug: string;
    status: string;
    created: boolean;
    blackboard_id: string;
  };
  transitions: Array<{ from: string; to: string }>;
  blackboard_entries: number;
  dual_run: DualRunInvocation[];
  council: { opened: boolean; slug?: string; id?: string; reason?: string };
  spend: false;
  allow_spend: boolean;
};

async function resolveWorkspaceId(db: Db, workspaceSlug: string): Promise<string> {
  const ws = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [workspaceSlug]
  );
  if (ws.rows.length === 0) throw new Error(`workspace not found: ${workspaceSlug}`);
  return ws.rows[0].id;
}

async function resolveMarketId(
  db: Db,
  workspaceId: string,
  marketCode: string
): Promise<string> {
  const m = await db.query<{ id: string }>(
    `SELECT id FROM markets
     WHERE workspace_id = $1 AND code = $2 AND deleted_at IS NULL`,
    [workspaceId, marketCode]
  );
  if (m.rows.length === 0) {
    throw new Error(`market not found: ${marketCode} in workspace`);
  }
  return m.rows[0].id;
}

async function ensureCampaign(
  pool: pg.Pool,
  opts: {
    workspaceId: string;
    workspace: string;
    slug: string;
    marketId: string;
    market: string;
  }
): Promise<{
  id: string;
  slug: string;
  status: string;
  blackboardId: string;
  created: boolean;
}> {
  const existing = await pool.query<{
    id: string;
    slug: string;
    status: string;
    blackboard_id: string | null;
  }>(
    `SELECT id, slug, status, blackboard_id FROM campaigns
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [opts.workspaceId, opts.slug]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    let blackboardId = row.blackboard_id;
    if (!blackboardId) {
      const bb = await pool.query<{ id: string }>(
        `INSERT INTO blackboards (workspace_id, campaign_id, slug, title, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id`,
        [
          opts.workspaceId,
          row.id,
          `bb-${opts.slug}`,
          `Blackboard: ${opts.slug}`,
        ]
      );
      blackboardId = bb.rows[0].id;
      await pool.query(
        `UPDATE campaigns SET blackboard_id = $1, market_id = COALESCE(market_id, $2), updated_at = now()
         WHERE id = $3`,
        [blackboardId, opts.marketId, row.id]
      );
    } else {
      await pool.query(
        `UPDATE campaigns SET market_id = COALESCE(market_id, $1), updated_at = now() WHERE id = $2`,
        [opts.marketId, row.id]
      );
    }
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      blackboardId: blackboardId!,
      created: false,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const brief = {
      market: opts.market,
      objective: "FRH E2E dry-run (no spend)",
      notes: "Week 3 dual-run specialists vs directors",
      allow_spend: false,
    };
    const camp = await client.query<{ id: string }>(
      `INSERT INTO campaigns (workspace_id, slug, title, status, market_id, brief, human_gate)
       VALUES ($1, $2, $3, 'draft', $4, $5::jsonb, 'pending')
       RETURNING id`,
      [
        opts.workspaceId,
        opts.slug,
        `E2E ${opts.market} ${opts.slug}`,
        opts.marketId,
        JSON.stringify(brief),
      ]
    );
    const campaignId = camp.rows[0].id;
    const bb = await client.query<{ id: string }>(
      `INSERT INTO blackboards (workspace_id, campaign_id, slug, title, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [
        opts.workspaceId,
        campaignId,
        `bb-${opts.slug}`,
        `Blackboard: E2E ${opts.market}`,
      ]
    );
    const blackboardId = bb.rows[0].id;
    await client.query(
      `UPDATE campaigns SET blackboard_id = $1, updated_at = now() WHERE id = $2`,
      [blackboardId, campaignId]
    );
    await emitEvent(client, {
      workspaceId: opts.workspaceId,
      campaignId,
      eventType: "campaign.created",
      actor: "frh.dry-run",
      payload: { slug: opts.slug, market: opts.market, spend: false },
    });
    await writeAudit(client, {
      workspaceId: opts.workspaceId,
      actor: "frh.dry-run",
      action: "campaign.create",
      entityType: "campaign",
      entityId: campaignId,
      details: { slug: opts.slug, market: opts.market, path: "e2e-dry-run" },
    });
    await client.query("COMMIT");
    return {
      id: campaignId,
      slug: opts.slug,
      status: "draft",
      blackboardId,
      created: true,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function openBlackboardEntries(
  db: Db,
  opts: {
    workspaceId: string;
    blackboardId: string;
    campaignSlug: string;
    market: string;
  }
): Promise<number> {
  const entries: Array<{ type: string; author: string; content: Record<string, unknown> }> = [
    {
      type: "brief",
      author: "global-cmo",
      content: {
        market: opts.market,
        campaign: opts.campaignSlug,
        objective: "E2E dry-run without paid spend",
      },
    },
    {
      type: "research_note",
      author: "intelligence",
      content: {
        market: opts.market,
        twin: "stub",
        note: "Treat market twin as hypothesis, not fact",
      },
    },
    {
      type: "kill_library",
      author: "knowledge",
      content: {
        ref: "GF-tomber-typo-poster-v1",
        lesson: "AI QA PASS != human taste; avoid sterile header",
      },
    },
    {
      type: "dual_run_plan",
      author: "frh.dry-run",
      content: {
        pairs: DUAL_RUN_PAIRS.map((p) => ({
          stage: p.stage,
          specialist: p.specialist,
          director: p.director,
        })),
      },
    },
  ];

  let sort = 0;
  for (const e of entries) {
    await db.query(
      `INSERT INTO blackboard_entries
         (workspace_id, blackboard_id, entry_type, author_agent, content, sort_order)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        opts.workspaceId,
        opts.blackboardId,
        e.type,
        e.author,
        JSON.stringify(e.content),
        sort++,
      ]
    );
  }
  await db.query(
    `UPDATE blackboards SET status = 'active', updated_at = now() WHERE id = $1`,
    [opts.blackboardId]
  );
  return entries.length;
}

function stubHandoffFromInvoke(
  agent: string,
  stage: string,
  result: InvokeResult
): Record<string, unknown> {
  return {
    finding: result.text.slice(0, 400) || `${agent} stub finding for ${stage}`,
    evidence: `stub invoke model=${result.resolvedModel} path=${result.escalationPath.join(">")}`,
    source: `agent:${agent}`,
    confidence: result.confidence,
    recommendation:
      stage === "strategy"
        ? "Proceed to creative with structured angles; no spend"
        : "Avoid sterile stock patterns; open human taste gate later",
    risks: "Stub confidence may not reflect live market",
    unknowns: "No Meta/CRM live data in Phase 1 Week 3",
    question_for_next_agent:
      stage === "strategy"
        ? "Which creative angles best fit GF without repeating kill-library mistakes?"
        : "Ready for review gate or need council on sterile risk?",
    dual_run_stage: stage,
  };
}

async function writeHandoff(
  db: Db,
  opts: {
    workspaceId: string;
    campaignId: string;
    fromAgentSlug: string;
    toAgentSlug: string;
    payload: Record<string, unknown>;
  }
): Promise<{ id: string; valid: boolean }> {
  const from = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [opts.workspaceId, opts.fromAgentSlug]
  );
  const to = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [opts.workspaceId, opts.toAgentSlug]
  );
  const validation = validateHandoff(opts.payload);
  const payload = validation.normalized ?? opts.payload;
  const res = await db.query<{ id: string }>(
    `INSERT INTO agent_handoffs
       (workspace_id, from_agent_id, to_agent_id, campaign_id, payload, valid)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      opts.workspaceId,
      from.rows[0]?.id ?? null,
      to.rows[0]?.id ?? null,
      opts.campaignId,
      JSON.stringify(payload),
      validation.valid,
    ]
  );
  return { id: res.rows[0].id, valid: validation.valid };
}

async function agentIsDualRun(
  db: Db,
  workspaceId: string,
  slug: string
): Promise<boolean> {
  const res = await db.query<{ dual_run: boolean }>(
    `SELECT dual_run FROM agents
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, slug]
  );
  return res.rows[0]?.dual_run === true;
}

/**
 * Orchestrate FRH Week 3 E2E dry-run:
 * ensure campaign → draft→research→strategy→creative → blackboard →
 * dual-run stub invokes → handoffs → optional council.
 */
export async function runFrhDryRun(
  pool: pg.Pool,
  opts: {
    workspace: string;
    market: string;
    slug: string;
    actor?: string;
  }
): Promise<DryRunResult> {
  if (process.env.NEXUS_ALLOW_SPEND === "true") {
    console.warn(
      "WARNING: NEXUS_ALLOW_SPEND=true — FRH dry-run still does not spend"
    );
  }

  const actor = opts.actor ?? "frh.dry-run";
  const market = opts.market.toUpperCase();
  const workspaceId = await resolveWorkspaceId(pool, opts.workspace);
  const marketId = await resolveMarketId(pool, workspaceId, market);

  const campaign = await ensureCampaign(pool, {
    workspaceId,
    workspace: opts.workspace,
    slug: opts.slug,
    marketId,
    market,
  });

  const transitions: Array<{ from: string; to: string }> = [];
  let status = campaign.status;

  for (const to of TRANSITION_PATH) {
    if (status === to) continue;
    if (!canTransition(status, to)) {
      // If already past this stage (e.g. review+), skip forward quietly
      if (
        ["review", "approved", "live", "paused", "learned", "killed"].includes(
          status
        )
      ) {
        break;
      }
      // try stepping one-by-one from current if stuck mid-path
      throw new Error(
        `cannot transition campaign ${opts.slug}: ${status} → ${to}`
      );
    }
    const t = await transitionCampaign(pool, {
      workspace: opts.workspace,
      slug: opts.slug,
      to,
      actor,
      reason: `frh e2e dry-run → ${to}`,
    });
    transitions.push({ from: t.from, to: t.to });
    status = t.to;
  }

  const blackboard_entries = await openBlackboardEntries(pool, {
    workspaceId,
    blackboardId: campaign.blackboardId,
    campaignSlug: opts.slug,
    market,
  });

  const dual_run: DualRunInvocation[] = [];
  let minConfidence = 1;
  let anyCouncilRec = false;

  for (const pair of DUAL_RUN_PAIRS) {
    for (const role of ["specialist", "director"] as const) {
      const agent = role === "specialist" ? pair.specialist : pair.director;
      const result = await invokeAgent(pool, {
        workspaceSlug: opts.workspace,
        agentSlug: agent,
        prompt: pair.prompt,
        campaignSlug: opts.slug,
      });

      const payload = stubHandoffFromInvoke(agent, pair.stage, result);
      const nextAgent =
        role === "specialist"
          ? pair.director
          : pair.stage === "strategy"
            ? "creative"
            : "performance";
      const handoff = await writeHandoff(pool, {
        workspaceId,
        campaignId: campaign.id,
        fromAgentSlug: agent,
        toAgentSlug: nextAgent,
        payload,
      });

      const dual = await agentIsDualRun(pool, workspaceId, agent);
      dual_run.push({
        stage: pair.stage,
        role,
        agent,
        dual_run: dual,
        ok: result.ok,
        confidence: result.confidence,
        council_recommended: result.councilRecommended,
        resolved_model: result.resolvedModel,
        handoff_id: handoff.id,
        handoff_valid: handoff.valid,
      });

      minConfidence = Math.min(minConfidence, result.confidence);
      if (result.councilRecommended) anyCouncilRec = true;
    }
  }

  const council: DryRunResult["council"] = { opened: false };
  if (anyCouncilRec || minConfidence < CONFIDENCE_COUNCIL_THRESHOLD) {
    const caseSlug = `e2e-${opts.slug}-council`;
    try {
      const opened = await openCase(pool, {
        workspace: opts.workspace,
        campaign: opts.slug,
        topic: `Low confidence / dual-run review for ${market} ${opts.slug}`,
        slug: caseSlug,
        body: {
          min_confidence: minConfidence,
          threshold: CONFIDENCE_COUNCIL_THRESHOLD,
          dual_run_agents: dual_run.map((d) => d.agent),
          spend: false,
        },
        actor,
      });
      council.opened = true;
      council.slug = opened.slug;
      council.id = opened.id;
      council.reason =
        minConfidence < CONFIDENCE_COUNCIL_THRESHOLD
          ? `min confidence ${minConfidence} < ${CONFIDENCE_COUNCIL_THRESHOLD}`
          : "invoke recommended council";
    } catch (e) {
      // Idempotent re-runs may hit unique slug — treat as already open
      const msg = e instanceof Error ? e.message : String(e);
      if (/unique|duplicate/i.test(msg)) {
        council.opened = false;
        council.slug = caseSlug;
        council.reason = "council case already exists";
      } else {
        throw e;
      }
    }
  }

  await emitEvent(pool, {
    workspaceId,
    campaignId: campaign.id,
    eventType: "frh.dry_run.completed",
    actor,
    payload: {
      market,
      slug: opts.slug,
      transitions,
      dual_run_count: dual_run.length,
      council_opened: council.opened,
      spend: false,
    },
  });

  return {
    workspace: opts.workspace,
    market,
    campaign: {
      id: campaign.id,
      slug: campaign.slug,
      status,
      created: campaign.created,
      blackboard_id: campaign.blackboardId,
    },
    transitions,
    blackboard_entries,
    dual_run,
    council,
    spend: false,
    allow_spend: process.env.NEXUS_ALLOW_SPEND === "true",
  };
}
