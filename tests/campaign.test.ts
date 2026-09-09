import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_TRANSITIONS,
  CAMPAIGN_STATUSES,
  canTransition,
  isCampaignStatus,
} from "../src/campaign/states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

describe("campaign status state machine", () => {
  it("lists all PRD statuses", () => {
    assert.deepEqual(
      [...CAMPAIGN_STATUSES],
      [
        "draft",
        "research",
        "strategy",
        "creative",
        "review",
        "approved",
        "live",
        "paused",
        "learned",
        "killed",
      ]
    );
  });

  it("allows legal draft → research", () => {
    assert.equal(canTransition("draft", "research"), true);
  });

  it("rejects illegal draft → live", () => {
    assert.equal(canTransition("draft", "live"), false);
  });

  it("rejects illegal killed → live", () => {
    assert.equal(canTransition("killed", "live"), false);
    assert.deepEqual(ALLOWED_TRANSITIONS.killed, []);
  });

  it("allows kill from mid-loop statuses", () => {
    for (const from of ["draft", "research", "strategy", "creative", "review", "approved", "live", "paused"]) {
      assert.equal(canTransition(from, "killed"), true, `${from}→killed`);
    }
  });

  it("allows pause/unpause on live", () => {
    assert.equal(canTransition("live", "paused"), true);
    assert.equal(canTransition("paused", "live"), true);
    assert.equal(canTransition("live", "learned"), true);
  });

  it("allows review → approved and review → creative", () => {
    assert.equal(canTransition("review", "approved"), true);
    assert.equal(canTransition("review", "creative"), true);
  });

  it("rejects unknown statuses", () => {
    assert.equal(isCampaignStatus("bogus"), false);
    assert.equal(canTransition("draft", "bogus"), false);
    assert.equal(canTransition("bogus", "research"), false);
  });

  it("happy path chain draft→…→learned is fully legal", () => {
    const chain: Array<[string, string]> = [
      ["draft", "research"],
      ["research", "strategy"],
      ["strategy", "creative"],
      ["creative", "review"],
      ["review", "approved"],
      ["approved", "live"],
      ["live", "learned"],
    ];
    for (const [from, to] of chain) {
      assert.equal(canTransition(from, to), true, `${from}→${to}`);
    }
  });
});

describe("campaign loop migration + modules", () => {
  it("has 003 migration with history, positions, gates", () => {
    const mig = path.join(root, "migrations", "003_phase1_campaign_loop.sql");
    assert.ok(fs.existsSync(mig));
    const sql = fs.readFileSync(mig, "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS campaign_status_history/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS council_positions/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS creative_gate_actions/);
    assert.match(sql, /campaigns_status_check/);
    assert.match(sql, /'draft'/);
    assert.match(sql, /'killed'/);
  });

  it("exports campaign modules", async () => {
    const mod = await import("../src/campaign/index.js");
    assert.equal(typeof mod.transitionCampaign, "function");
    assert.equal(typeof mod.assignTask, "function");
    assert.equal(typeof mod.listTasks, "function");
    assert.equal(typeof mod.completeTask, "function");
    assert.equal(typeof mod.openCase, "function");
    assert.equal(typeof mod.addPosition, "function");
    assert.equal(typeof mod.decideCase, "function");
    assert.equal(typeof mod.approveCreative, "function");
    assert.equal(typeof mod.killCreative, "function");
    assert.equal(typeof mod.emitEvent, "function");
    assert.equal(typeof mod.canTransition, "function");
  });
});

/** Lightweight fake pool for DB-backed campaign APIs (no live Postgres required). */
function makeFakePool(seed: {
  workspaceId: string;
  campaignId: string;
  agentId: string;
  creativeId: string;
  campaignSlug?: string;
  creativeSlug?: string;
  creativeStatus?: string;
}) {
  const state = {
    campaignStatus: "draft",
    caseStatus: "none" as string,
    caseId: "",
    caseSlug: "",
    positions: [] as unknown[],
    creativeStatus: seed.creativeStatus ?? "draft",
    creativeTaste: null as string | null,
    creativeMeta: {} as Record<string, unknown>,
    gateActions: [] as unknown[],
    events: [] as unknown[],
    audits: [] as unknown[],
    history: [] as unknown[],
    tasks: [] as Array<Record<string, unknown>>,
    decidedVerdict: null as unknown,
  };

  type QResult = { rows: Array<Record<string, unknown>> };

  async function query(sql: string, params: unknown[] = []): Promise<QResult> {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.includes("FROM workspaces") && s.includes("slug")) {
      if (params[0] === "frh") return { rows: [{ id: seed.workspaceId }] };
      return { rows: [] };
    }
    if (s.includes("FROM campaigns") && s.includes("FOR UPDATE")) {
      return {
        rows: [
          {
            id: seed.campaignId,
            slug: seed.campaignSlug ?? "demo-gf",
            status: state.campaignStatus,
            title: "Demo",
            human_gate: "pending",
          },
        ],
      };
    }
    if (s.includes("FROM campaigns") && s.includes("slug")) {
      return {
        rows: [
          {
            id: seed.campaignId,
            slug: seed.campaignSlug ?? "demo-gf",
            status: state.campaignStatus,
            title: "Demo",
            human_gate: "pending",
          },
        ],
      };
    }
    if (s.startsWith("UPDATE campaigns SET status")) {
      state.campaignStatus = params[0] as string;
      return { rows: [] };
    }
    if (s.includes("INSERT INTO campaign_status_history")) {
      const id = "hist-1";
      state.history.push({
        id,
        from: params[2],
        to: params[3],
        actor: params[4],
        reason: params[5],
      });
      return { rows: [{ id }] };
    }
    if (s.includes("INSERT INTO events")) {
      const id = `evt-${state.events.length + 1}`;
      state.events.push({ id, type: params[2], payload: params[4] });
      return { rows: [{ id }] };
    }
    if (s.includes("INSERT INTO audit_log")) {
      const id = `aud-${state.audits.length + 1}`;
      state.audits.push({ id, action: params[2] });
      return { rows: [{ id }] };
    }
    if (s.includes("FROM agents")) {
      if (params[1] === "strategy" || params[1] === "performance") {
        return { rows: [{ id: seed.agentId, slug: params[1] }] };
      }
      // allow unknown agent slug fallback for positions
      return { rows: [] };
    }
    if (s.includes("INSERT INTO tasks")) {
      const id = `task-${state.tasks.length + 1}`;
      const row = {
        id,
        title: params[4],
        status: "pending",
        agent_id: params[2],
        campaign_id: seed.campaignId,
      };
      state.tasks.push(row);
      return { rows: [{ id, title: row.title, status: row.status }] };
    }
    if (s.includes("FROM tasks t") || (s.includes("FROM tasks") && s.includes("agent_slug"))) {
      return {
        rows: state.tasks.map((t) => ({
          id: t.id,
          slug: null,
          title: t.title,
          status: t.status,
          agent_slug: "strategy",
          created_at: new Date(),
        })),
      };
    }
    if (s.includes("FROM tasks") && s.includes("FOR UPDATE")) {
      const t = state.tasks.find((x) => x.id === params[1]);
      if (!t) return { rows: [] };
      return {
        rows: [
          {
            id: t.id,
            status: t.status,
            campaign_id: seed.campaignId,
            title: t.title,
          },
        ],
      };
    }
    if (s.startsWith("UPDATE tasks")) {
      const t = state.tasks.find((x) => x.id === params[1]);
      if (t) t.status = "done";
      return { rows: [{ id: params[1], status: "done" }] };
    }
    if (s.includes("INSERT INTO council_cases")) {
      state.caseId = "case-1";
      state.caseSlug = params[2] as string;
      state.caseStatus = "open";
      return {
        rows: [
          {
            id: state.caseId,
            slug: state.caseSlug,
            status: "open",
            topic: params[3],
          },
        ],
      };
    }
    if (s.includes("FROM council_cases") && s.includes("FOR UPDATE")) {
      if (!state.caseId || params[1] !== state.caseSlug) return { rows: [] };
      return {
        rows: [
          {
            id: state.caseId,
            slug: state.caseSlug,
            status: state.caseStatus,
            campaign_id: seed.campaignId,
          },
        ],
      };
    }
    if (s.includes("INSERT INTO council_positions")) {
      const id = `pos-${state.positions.length + 1}`;
      const row = {
        id,
        agent_slug: params[2],
        stance: params[3],
      };
      state.positions.push(row);
      return { rows: [row] };
    }
    if (s.startsWith("UPDATE council_cases")) {
      state.caseStatus = params[0] as string;
      state.decidedVerdict = JSON.parse(params[1] as string);
      return {
        rows: [
          {
            id: state.caseId,
            slug: state.caseSlug,
            status: state.caseStatus,
            verdict: state.decidedVerdict,
          },
        ],
      };
    }
    if (s.includes("FROM creatives") && s.includes("FOR UPDATE")) {
      if (params[1] !== (seed.creativeSlug ?? "GF-tomber-typo-poster-v1") &&
          params[1] !== "new-poster-v1") {
        // allow both seeded killed and a fresh draft creative in tests
      }
      if (
        params[1] === (seed.creativeSlug ?? "GF-tomber-typo-poster-v1") ||
        params[1] === "new-poster-v1"
      ) {
        return {
          rows: [
            {
              id: seed.creativeId,
              slug: params[1],
              status: state.creativeStatus,
              campaign_id: seed.campaignId,
              sterile_flags: [],
              asset_meta: state.creativeMeta,
            },
          ],
        };
      }
      return { rows: [] };
    }
    if (s.startsWith("UPDATE creatives")) {
      if (s.includes("approved")) {
        state.creativeStatus = "approved";
        state.creativeTaste = "approve";
      } else if (s.includes("killed")) {
        state.creativeStatus = "killed";
        state.creativeTaste = "reject";
        state.creativeMeta = JSON.parse(params[0] as string);
      }
      return {
        rows: [
          {
            id: seed.creativeId,
            slug: seed.creativeSlug ?? "new-poster-v1",
            status: state.creativeStatus,
            human_taste: state.creativeTaste,
          },
        ],
      };
    }
    if (s.includes("INSERT INTO creative_gate_actions")) {
      const id = `gate-${state.gateActions.length + 1}`;
      state.gateActions.push({
        id,
        action: params[2],
        reason: params[3],
      });
      return { rows: [{ id }] };
    }
    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") {
      return { rows: [] };
    }
    throw new Error("unhandled SQL in fake pool: " + s.slice(0, 120));
  }

  const client = {
    query,
    release() {},
  };

  return {
    state,
    pool: {
      query,
      connect: async () => client,
      end: async () => {},
    } as unknown as import("pg").Pool,
  };
}

describe("transitionCampaign (fake db)", () => {
  it("legal draft→research writes history + events", async () => {
    const { transitionCampaign } = await import("../src/campaign/states.js");
    const { pool, state } = makeFakePool({
      workspaceId: "ws-1",
      campaignId: "camp-1",
      agentId: "ag-1",
      creativeId: "cr-1",
    });
    const result = await transitionCampaign(pool, {
      workspace: "frh",
      slug: "demo-gf",
      to: "research",
      reason: "start loop",
      actor: "test",
    });
    assert.equal(result.from, "draft");
    assert.equal(result.to, "research");
    assert.equal(state.campaignStatus, "research");
    assert.equal(state.history.length, 1);
    assert.ok(state.events.some((e) => (e as { type: string }).type === "campaign.status_changed"));
  });

  it("illegal draft→live is rejected", async () => {
    const { transitionCampaign } = await import("../src/campaign/states.js");
    const { pool } = makeFakePool({
      workspaceId: "ws-1",
      campaignId: "camp-1",
      agentId: "ag-1",
      creativeId: "cr-1",
    });
    await assert.rejects(
      () =>
        transitionCampaign(pool, {
          workspace: "frh",
          slug: "demo-gf",
          to: "live",
          reason: "nope",
        }),
      /illegal transition/
    );
  });
});

describe("council open/position/decide (fake db)", () => {
  it("opens, adds position, decides", async () => {
    const { openCase, addPosition, decideCase } = await import("../src/campaign/council.js");
    const { pool, state } = makeFakePool({
      workspaceId: "ws-1",
      campaignId: "camp-1",
      agentId: "ag-1",
      creativeId: "cr-1",
    });

    const opened = await openCase(pool, {
      workspace: "frh",
      campaign: "demo-gf",
      topic: "CPL spike",
      slug: "cpl-spike-1",
    });
    assert.equal(opened.status, "open");
    assert.equal(opened.slug, "cpl-spike-1");
    assert.ok(state.events.some((e) => (e as { type: string }).type === "council.case.opened"));

    const pos = await addPosition(pool, {
      workspace: "frh",
      caseSlug: "cpl-spike-1",
      agent: "performance",
      stance: "fatigue",
      body: { note: "creative fatigue" },
    });
    assert.equal(pos.stance, "fatigue");
    assert.equal(pos.agent_slug, "performance");

    const decided = await decideCase(pool, {
      workspace: "frh",
      caseSlug: "cpl-spike-1",
      verdict: { cause: "fatigue", confidence: 0.78 },
    });
    assert.equal(decided.status, "decided");
    assert.deepEqual(decided.verdict, { cause: "fatigue", confidence: 0.78 });
    assert.ok(state.events.some((e) => (e as { type: string }).type === "council.case.decided"));
  });
});

describe("kill creative (fake db)", () => {
  it("updates status to killed and records gate action", async () => {
    const { killCreative } = await import("../src/campaign/gates.js");
    const { pool, state } = makeFakePool({
      workspaceId: "ws-1",
      campaignId: "camp-1",
      agentId: "ag-1",
      creativeId: "cr-1",
      creativeSlug: "GF-tomber-typo-poster-v1",
      creativeStatus: "draft",
    });
    const result = await killCreative(pool, {
      workspace: "frh",
      slug: "GF-tomber-typo-poster-v1",
      reason: "sterile stock",
    });
    assert.equal(result.status, "killed");
    assert.equal(result.human_taste, "reject");
    assert.equal(state.creativeStatus, "killed");
    assert.equal((state.creativeMeta as { killed_reason?: string }).killed_reason, "sterile stock");
    assert.equal(state.gateActions.length, 1);
    assert.ok(state.events.some((e) => (e as { type: string }).type === "creative.rejected"));
  });

  it("requires a reason", async () => {
    const { killCreative } = await import("../src/campaign/gates.js");
    const { pool } = makeFakePool({
      workspaceId: "ws-1",
      campaignId: "camp-1",
      agentId: "ag-1",
      creativeId: "cr-1",
    });
    await assert.rejects(
      () =>
        killCreative(pool, {
          workspace: "frh",
          slug: "GF-tomber-typo-poster-v1",
          reason: "  ",
        }),
      /reason/
    );
  });
});
