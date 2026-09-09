#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import fs from "node:fs";
import { createPool } from "../db/client.js";
import { explainAgentRoute, invokeAgent } from "../router/invoke.js";
import { validateHandoff, requiredKeysList } from "../router/handoff.js";
import { getModelMode } from "../router/providers.js";
import {
  transitionCampaign,
  getCampaignStatus,
  assignTask,
  listTasks,
  completeTask,
  openCase,
  addPosition,
  decideCase,
  approveCreative,
  killCreative,
} from "../campaign/index.js";

dotenv.config();

const program = new Command();

program
  .name("nexus")
  .description("NEXUS Phase 0+1 CLI - dry-run + model router + campaign loop")
  .version("0.3.0");

const campaign = program.command("campaign").description("Campaign commands");

campaign
  .command("create")
  .description("Create campaign + empty blackboard + audit + event")
  .requiredOption("--workspace <slug>", "Workspace slug (e.g. frh)")
  .requiredOption("--slug <slug>", "Campaign slug")
  .requiredOption("--title <title>", "Campaign title")
  .option("--brief <json>", "Optional brief JSON", "{}")
  .action(async (opts) => {
    if (process.env.NEXUS_ALLOW_SPEND === "true") {
      console.warn("WARNING: NEXUS_ALLOW_SPEND=true - Phase 0 still does not spend");
    } else {
      console.log("dry-run gate: NEXUS_ALLOW_SPEND=false (no spend)");
    }
    let brief = {};
    try {
      brief = JSON.parse(opts.brief);
    } catch {
      console.error("--brief must be valid JSON");
      process.exit(1);
    }

    const pool = createPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ws = await client.query(
        "SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL",
        [opts.workspace]
      );
      if (ws.rows.length === 0) throw new Error("workspace not found: " + opts.workspace);
      const workspaceId = ws.rows[0].id;

      const camp = await client.query(
        `INSERT INTO campaigns (workspace_id, slug, title, status, brief, human_gate)
         VALUES ($1, $2, $3, 'draft', $4::jsonb, 'pending') RETURNING id`,
        [workspaceId, opts.slug, opts.title, JSON.stringify(brief)]
      );
      const campaignId = camp.rows[0].id;

      const bb = await client.query(
        `INSERT INTO blackboards (workspace_id, campaign_id, slug, title, status)
         VALUES ($1, $2, $3, $4, 'empty') RETURNING id`,
        [workspaceId, campaignId, "bb-" + opts.slug, "Blackboard: " + opts.title]
      );
      const blackboardId = bb.rows[0].id;

      await client.query(
        "UPDATE campaigns SET blackboard_id = $1, updated_at = now() WHERE id = $2",
        [blackboardId, campaignId]
      );

      await client.query(
        `INSERT INTO audit_log (workspace_id, actor, action, entity_type, entity_id, details)
         VALUES ($1, 'cli', 'campaign.create', 'campaign', $2, $3::jsonb)`,
        [
          workspaceId,
          campaignId,
          JSON.stringify({
            slug: opts.slug,
            title: opts.title,
            blackboard_id: blackboardId,
            path: "brief->blackboard->human_gate",
            spend: false,
          }),
        ]
      );

      await client.query(
        `INSERT INTO events (workspace_id, campaign_id, event_type, actor, payload)
         VALUES ($1, $2, 'campaign.created', 'cli', $3::jsonb)`,
        [
          workspaceId,
          campaignId,
          JSON.stringify({
            slug: opts.slug,
            human_gate: "pending",
            blackboard_id: blackboardId,
          }),
        ]
      );

      await client.query("COMMIT");
      console.log("campaign created (dry-run path: brief -> blackboard -> human gate)");
      console.log(
        JSON.stringify(
          {
            campaign_id: campaignId,
            slug: opts.slug,
            title: opts.title,
            workspace: opts.workspace,
            blackboard_id: blackboardId,
            human_gate: "pending",
            spend: false,
          },
          null,
          2
        )
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  });

campaign
  .command("list")
  .description("List campaigns in a workspace")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const res = await pool.query(
        `SELECT c.slug, c.title, c.status, c.human_gate, c.created_at
         FROM campaigns c
         JOIN workspaces w ON w.id = c.workspace_id
         WHERE w.slug = $1 AND c.deleted_at IS NULL
         ORDER BY c.created_at DESC`,
        [opts.workspace]
      );
      console.table(res.rows);
    } finally {
      await pool.end();
    }
  });

campaign
  .command("transition")
  .description("Transition campaign status (state machine)")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--slug <slug>", "Campaign slug")
  .requiredOption("--to <status>", "Target status")
  .option("--reason <text>", "Reason for transition")
  .option("--actor <name>", "Actor", "cli")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const result = await transitionCampaign(pool, {
        workspace: opts.workspace,
        slug: opts.slug,
        to: opts.to,
        reason: opts.reason,
        actor: opts.actor,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            campaign_id: result.campaignId,
            slug: result.slug,
            from: result.from,
            to: result.to,
            history_id: result.historyId,
          },
          null,
          2
        )
      );
    } finally {
      await pool.end();
    }
  });

campaign
  .command("status")
  .description("Show campaign status + recent history")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--slug <slug>", "Campaign slug")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const s = await getCampaignStatus(pool, opts.workspace, opts.slug);
      console.log(
        JSON.stringify(
          {
            id: s.id,
            slug: s.slug,
            title: s.title,
            status: s.status,
            human_gate: s.human_gate,
            history: s.history,
          },
          null,
          2
        )
      );
    } finally {
      await pool.end();
    }
  });

const taskCmd = program.command("task").description("Task assignment");

taskCmd
  .command("assign")
  .description("Assign a task to an agent on a campaign")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--campaign <slug>", "Campaign slug")
  .requiredOption("--agent <slug>", "Agent slug")
  .requiredOption("--title <title>", "Task title")
  .option("--slug <slug>", "Optional task slug")
  .option("--payload <json>", "Optional payload JSON", "{}")
  .action(async (opts) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(opts.payload);
    } catch {
      console.error("--payload must be valid JSON");
      process.exit(1);
    }
    const pool = createPool();
    try {
      const result = await assignTask(pool, {
        workspace: opts.workspace,
        campaign: opts.campaign,
        agent: opts.agent,
        title: opts.title,
        slug: opts.slug,
        payload,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } finally {
      await pool.end();
    }
  });

taskCmd
  .command("list")
  .description("List tasks for a campaign")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--campaign <slug>", "Campaign slug")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const rows = await listTasks(pool, opts.workspace, opts.campaign);
      console.table(
        rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          status: r.status,
          agent: r.agent_slug,
          created_at: r.created_at,
        }))
      );
    } finally {
      await pool.end();
    }
  });

taskCmd
  .command("complete")
  .description("Mark a task done")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--id <uuid>", "Task id")
  .option("--result <json>", "Optional result JSON", "{}")
  .action(async (opts) => {
    let result: Record<string, unknown> = {};
    try {
      result = JSON.parse(opts.result);
    } catch {
      console.error("--result must be valid JSON");
      process.exit(1);
    }
    const pool = createPool();
    try {
      const row = await completeTask(pool, {
        workspace: opts.workspace,
        taskId: opts.id,
        result,
      });
      console.log(JSON.stringify({ ok: true, ...row }, null, 2));
    } finally {
      await pool.end();
    }
  });

const councilCmd = program.command("council").description("Council case v1");

councilCmd
  .command("open")
  .description("Open a council case")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--campaign <slug>", "Campaign slug")
  .requiredOption("--topic <text>", "Case topic")
  .requiredOption("--slug <slug>", "Case slug")
  .option("--body <json>", "Optional case body JSON", "{}")
  .action(async (opts) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(opts.body);
    } catch {
      console.error("--body must be valid JSON");
      process.exit(1);
    }
    const pool = createPool();
    try {
      const row = await openCase(pool, {
        workspace: opts.workspace,
        campaign: opts.campaign,
        topic: opts.topic,
        slug: opts.slug,
        body,
      });
      console.log(JSON.stringify({ ok: true, ...row }, null, 2));
    } finally {
      await pool.end();
    }
  });

councilCmd
  .command("position")
  .description("Add a position to an open council case")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--case <slug>", "Case slug")
  .requiredOption("--agent <slug>", "Agent slug")
  .requiredOption("--stance <text>", "Stance label")
  .option("--body <json>", "Position body JSON", "{}")
  .action(async (opts) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(opts.body);
    } catch {
      console.error("--body must be valid JSON");
      process.exit(1);
    }
    const pool = createPool();
    try {
      const row = await addPosition(pool, {
        workspace: opts.workspace,
        caseSlug: opts.case,
        agent: opts.agent,
        stance: opts.stance,
        body,
      });
      console.log(JSON.stringify({ ok: true, ...row }, null, 2));
    } finally {
      await pool.end();
    }
  });

councilCmd
  .command("decide")
  .description("Decide a council case (set verdict, status decided)")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--case <slug>", "Case slug")
  .requiredOption("--verdict <json>", "Verdict JSON")
  .action(async (opts) => {
    let verdict: Record<string, unknown>;
    try {
      verdict = JSON.parse(opts.verdict);
    } catch {
      console.error("--verdict must be valid JSON");
      process.exit(1);
      return;
    }
    const pool = createPool();
    try {
      const row = await decideCase(pool, {
        workspace: opts.workspace,
        caseSlug: opts.case,
        verdict,
      });
      console.log(JSON.stringify({ ok: true, ...row }, null, 2));
    } finally {
      await pool.end();
    }
  });

const creativeCmd = program.command("creative").description("Creative human gate");

creativeCmd
  .command("approve")
  .description("Approve a creative (human taste gate)")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--slug <slug>", "Creative slug")
  .option("--reason <text>", "Optional reason")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const row = await approveCreative(pool, {
        workspace: opts.workspace,
        slug: opts.slug,
        reason: opts.reason,
      });
      console.log(JSON.stringify({ ok: true, ...row }, null, 2));
    } finally {
      await pool.end();
    }
  });

creativeCmd
  .command("kill")
  .description("Kill a creative (sterile/taste reason required)")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--slug <slug>", "Creative slug")
  .requiredOption("--reason <text>", "Kill reason (sterile/taste)")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const row = await killCreative(pool, {
        workspace: opts.workspace,
        slug: opts.slug,
        reason: opts.reason,
      });
      console.log(JSON.stringify({ ok: true, ...row }, null, 2));
    } finally {
      await pool.end();
    }
  });

program
  .command("dry-run")
  .description("Print the Phase 0 dry-run path")
  .action(() => {
    console.log("NEXUS Phase 0 dry-run path (no spend)");
    console.log("");
    console.log("  1. brief      - campaign.brief JSON");
    console.log("  2. blackboard - empty blackboard attached to campaign");
    console.log("  3. human gate - campaigns.human_gate = pending");
    console.log("");
    console.log("  NEXUS_ALLOW_SPEND=" + (process.env.NEXUS_ALLOW_SPEND ?? "false"));
    console.log("");
    console.log("  Example:");
    console.log(
      '    pnpm nexus campaign create --workspace frh --slug demo-gf --title "Demo GF"'
    );
  });

const routerCmd = program.command("router").description("Model router commands");

routerCmd
  .command("explain")
  .description("Print ladder decision for an agent (no invoke)")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--agent <slug>", "Agent slug")
  .action(async (opts) => {
    const pool = createPool();
    try {
      const result = await explainAgentRoute(pool, opts.workspace, opts.agent);
      console.log(result.explanation);
      console.log("");
      console.log(
        JSON.stringify(
          {
            policy: result.policySlug,
            startAt: result.startAt,
            skipCheap: result.skipCheap,
            ladder: result.ladder,
            mode: getModelMode(),
          },
          null,
          2
        )
      );
    } finally {
      await pool.end();
    }
  });

const agentCmd = program.command("agent").description("Agent invoke commands");

agentCmd
  .command("invoke")
  .description("Invoke agent via model router (stub by default)")
  .requiredOption("--workspace <slug>", "Workspace slug")
  .requiredOption("--slug <slug>", "Agent slug")
  .requiredOption("--prompt <text>", "Prompt text")
  .option("--campaign <slug>", "Optional campaign slug for context")
  .option("--max-escalations <n>", "Max ladder steps", (v) => parseInt(v, 10))
  .action(async (opts) => {
    console.log(`NEXUS_MODEL_MODE=${getModelMode()} (stub never calls external APIs)`);
    const pool = createPool();
    try {
      const result = await invokeAgent(pool, {
        workspaceSlug: opts.workspace,
        agentSlug: opts.slug,
        prompt: opts.prompt,
        campaignSlug: opts.campaign,
        maxEscalations: opts.maxEscalations,
      });
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            resolved_model: result.resolvedModel,
            requested_model: result.requestedModel,
            provider: result.provider,
            ladder_step: result.ladderStep,
            confidence: result.confidence,
            council_recommended: result.councilRecommended,
            escalation_path: result.escalationPath,
            invocation_ids: result.invocationIds,
            latency_ms: result.latencyMs,
            cost_usd: result.costUsd,
            context: result.contextSummary,
            error: result.error ?? null,
            text: result.text,
          },
          null,
          2
        )
      );
      if (!result.ok) process.exitCode = 1;
    } finally {
      await pool.end();
    }
  });

const handoffCmd = program.command("handoff").description("Handoff validation");

handoffCmd
  .command("validate")
  .description("Validate structured handoff JSON")
  .option("--file <path>", "Read JSON from file (- for stdin)")
  .option("--json <json>", "Inline JSON string")
  .action(async (opts) => {
    let raw: string;
    if (opts.json) {
      raw = opts.json;
    } else if (opts.file) {
      if (opts.file === "-") {
        raw = fs.readFileSync(0, "utf8");
      } else {
        raw = fs.readFileSync(opts.file, "utf8");
      }
    } else {
      console.error("Provide --json or --file (- for stdin)");
      console.error("Required keys: " + requiredKeysList().join(", "));
      process.exit(1);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("invalid JSON");
      process.exit(1);
      return;
    }
    const result = validateHandoff(parsed);
    console.log(
      JSON.stringify(
        {
          valid: result.valid,
          missing: result.missing,
          errors: result.errors,
          required: requiredKeysList(),
          normalized: result.normalized ?? null,
        },
        null,
        2
      )
    );
    if (!result.valid) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
