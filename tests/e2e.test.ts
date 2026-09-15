import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePerformanceCsv,
  parsePerformanceCsvFile,
} from "../src/frh/performanceIngest.js";
import { canTransition } from "../src/campaign/states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

describe("Week 3 migration + fixtures", () => {
  it("has 004_phase1_e2e.sql with performance_daily columns", () => {
    const mig = path.join(root, "migrations", "004_phase1_e2e.sql");
    assert.ok(fs.existsSync(mig));
    const sql = fs.readFileSync(mig, "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS performance_daily/);
    for (const col of [
      "workspace_id",
      "market_code",
      "campaign_id",
      "creative_id",
      "date",
      "spend",
      "impressions",
      "clicks",
      "leads",
      "qualified_leads",
      "cpl",
      "ql_cpl",
      "source",
      "created_at",
    ]) {
      assert.match(sql, new RegExp(col));
    }
    assert.match(sql, /csv_stub/);
  });

  it("has performance stub CSV for GF", () => {
    const csv = path.join(root, "fixtures", "performance_stub_gf.csv");
    assert.ok(fs.existsSync(csv));
    const text = fs.readFileSync(csv, "utf8");
    assert.match(text, /market_code/);
    assert.match(text, /GF/);
  });

  it("exports frh modules", async () => {
    const mod = await import("../src/frh/index.js");
    assert.equal(typeof mod.parsePerformanceCsv, "function");
    assert.equal(typeof mod.ingestPerformanceCsv, "function");
    assert.equal(typeof mod.learningsFromPerformance, "function");
    assert.equal(typeof mod.runFrhDryRun, "function");
  });
});

describe("performance CSV ingest (unit)", () => {
  it("parses fixture rows", () => {
    const rows = parsePerformanceCsvFile(
      path.join(root, "fixtures", "performance_stub_gf.csv")
    );
    assert.ok(rows.length >= 4);
    assert.equal(rows[0].market_code, "GF");
    assert.equal(rows[0].campaign_slug, "e2e-gf-1");
    assert.ok(rows[0].spend > 0);
    assert.ok(rows[0].impressions > 0);
  });

  it("rejects missing required columns", () => {
    assert.throws(
      () => parsePerformanceCsv("spend,impressions\n1,2\n"),
      /missing required column/
    );
  });

  it("computes empty optional fields as null/zero", () => {
    const rows = parsePerformanceCsv(
      "date,market_code,spend\n2026-09-01,GF,10\n"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].spend, 10);
    assert.equal(rows[0].leads, 0);
    assert.equal(rows[0].cpl, null);
    assert.equal(rows[0].campaign_slug, null);
  });
});

describe("performance ingest (mocked pool)", () => {
  it("inserts parsed rows into performance_daily", async () => {
    const { ingestPerformanceCsv } = await import(
      "../src/frh/performanceIngest.js"
    );

    const inserts: unknown[] = [];
    const updates: unknown[] = [];

    async function query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] };
      if (s.includes("FROM workspaces")) return { rows: [{ id: "ws-1" }] };
      if (s.includes("FROM campaigns")) {
        if (params[1] === "e2e-gf-1") return { rows: [{ id: "camp-1" }] };
        return { rows: [] };
      }
      if (s.includes("FROM creatives")) {
        if (params[1] === "GF-tomber-typo-poster-v1") {
          return { rows: [{ id: "cre-1" }] };
        }
        return { rows: [] };
      }
      if (s.includes("FROM performance_daily")) return { rows: [] };
      if (s.includes("INSERT INTO performance_daily")) {
        inserts.push(params);
        return { rows: [{ id: `pd-${inserts.length}` }] };
      }
      if (s.includes("UPDATE performance_daily")) {
        updates.push(params);
        return { rows: [] };
      }
      if (s.includes("INSERT INTO events") || s.includes("INSERT INTO audit_log")) {
        return { rows: [{ id: "x" }] };
      }
      return { rows: [] };
    }

    const client = { query, release() {} };
    const pool = {
      query,
      connect: async () => client,
      end: async () => {},
    } as unknown as import("pg").Pool;

    // Write a tiny temp csv next to fixture path semantics via absolute content file
    const tmp = path.join(root, "fixtures", "_tmp_ingest_test.csv");
    fs.writeFileSync(
      tmp,
      "date,market_code,campaign_slug,creative_slug,spend,impressions,clicks,leads,qualified_leads,cpl,ql_cpl\n" +
        "2026-09-01,GF,e2e-gf-1,,10,100,5,1,0,10,\n" +
        "2026-09-02,GF,e2e-gf-1,GF-tomber-typo-poster-v1,20,200,8,0,0,,\n"
    );
    try {
      const result = await ingestPerformanceCsv(pool, {
        workspace: "frh",
        file: tmp,
      });
      assert.equal(result.inserted, 2);
      assert.equal(result.updated, 0);
      assert.equal(result.rows.length, 2);
      assert.equal(inserts.length, 2);
      const row0 = inserts[0] as unknown[];
      const row1 = inserts[1] as unknown[];
      // campaign resolved
      assert.equal(row0[2], "camp-1");
      // creative resolved on second row
      assert.equal(row1[3], "cre-1");
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe("FRH dry-run happy path (mocked pool)", () => {
  it("allows draft→research→strategy→creative chain", () => {
    assert.equal(canTransition("draft", "research"), true);
    assert.equal(canTransition("research", "strategy"), true);
    assert.equal(canTransition("strategy", "creative"), true);
  });

  it("runFrhDryRun orchestrates create + transitions + dual_run + handoffs", async () => {
    const { runFrhDryRun } = await import("../src/frh/dryRun.js");

    const state = {
      campaignExists: false,
      campaignStatus: "draft",
      campaignId: "camp-1",
      blackboardId: "bb-1",
      entries: 0,
      handoffs: 0,
      invocations: 0,
      events: [] as string[],
    };

    const agents: Record<
      string,
      { id: string; dual_run: boolean; kind: string; policy: string }
    > = {
      "stratege-creative": {
        id: "a1",
        dual_run: true,
        kind: "specialist",
        policy: "cheap",
      },
      strategy: {
        id: "a2",
        dual_run: false,
        kind: "director",
        policy: "mgr",
      },
      "art-director": {
        id: "a3",
        dual_run: true,
        kind: "specialist",
        policy: "cheap",
      },
      creative: {
        id: "a4",
        dual_run: false,
        kind: "director",
        policy: "mgr",
      },
      performance: {
        id: "a5",
        dual_run: false,
        kind: "director",
        policy: "mgr",
      },
    };

    async function query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] };

      if (s.includes("FROM workspaces")) return { rows: [{ id: "ws-1" }] };
      if (s.includes("FROM markets")) return { rows: [{ id: "mkt-gf" }] };

      if (s.includes("INSERT INTO campaigns")) {
        state.campaignExists = true;
        state.campaignStatus = "draft";
        return { rows: [{ id: state.campaignId }] };
      }
      if (s.includes("INSERT INTO blackboards")) {
        return { rows: [{ id: state.blackboardId }] };
      }
      if (s.includes("UPDATE campaigns SET blackboard_id")) return { rows: [] };
      if (s.includes("UPDATE campaigns SET market_id")) return { rows: [] };
      if (s.includes("UPDATE campaigns SET status")) {
        state.campaignStatus = String(params[0]);
        return { rows: [] };
      }
      if (s.includes("INSERT INTO campaign_status_history")) {
        return { rows: [{ id: "hist-1" }] };
      }
      if (s.includes("INSERT INTO blackboard_entries")) {
        state.entries += 1;
        return { rows: [{ id: `be-${state.entries}` }] };
      }
      if (s.includes("UPDATE blackboards")) return { rows: [] };

      if (s.includes("FROM campaigns")) {
        if (!state.campaignExists) return { rows: [] };
        return {
          rows: [
            {
              id: state.campaignId,
              slug: params[1] ?? "e2e-gf-1",
              status: state.campaignStatus,
              blackboard_id: state.blackboardId,
              title: "E2E",
              human_gate: "pending",
              brief: { market: "GF" },
            },
          ],
        };
      }

      if (s.includes("FROM agents") && s.includes("dual_run")) {
        const a = agents[String(params[1])];
        return a ? { rows: [{ dual_run: a.dual_run }] } : { rows: [] };
      }
      if (s.includes("FROM agents")) {
        const slug = String(params[1] ?? "");
        const a = agents[slug];
        if (!a) return { rows: [] };
        return {
          rows: [
            {
              id: a.id,
              workspace_id: "ws-1",
              slug,
              name: slug,
              role: a.kind,
              kind: a.kind,
              policy_id: a.policy === "mgr" ? "pol-mgr" : "pol-cheap",
              config: {},
            },
          ],
        };
      }

      if (s.includes("FROM model_policies")) {
        const id = String(params[0] ?? "");
        if (id === "pol-mgr") {
          return {
            rows: [
              {
                id: "pol-mgr",
                slug: "managers-astra6",
                policy: {
                  escalation_ladder: ["astra"],
                  confidence_threshold: 0.5,
                  start_at: "astra",
                  skip_cheap: true,
                },
                is_default: true,
              },
            ],
          };
        }
        return {
          rows: [
            {
              id: "pol-cheap",
              slug: "cheap-first",
              policy: {
                escalation_ladder: ["qwen-local", "glm", "specialist", "astra"],
                confidence_threshold: 0.5,
                start_at: "qwen-local",
                skip_cheap: false,
              },
              is_default: false,
            },
          ],
        };
      }

      if (s.includes("FROM blackboard_entries")) return { rows: [] };

      if (s.includes("INSERT INTO model_invocations")) {
        state.invocations += 1;
        return { rows: [{ id: `inv-${state.invocations}` }] };
      }
      if (s.includes("INSERT INTO agent_handoffs")) {
        state.handoffs += 1;
        return { rows: [{ id: `ho-${state.handoffs}` }] };
      }
      if (s.includes("INSERT INTO council_cases")) {
        return {
          rows: [
            {
              id: "case-1",
              slug: params[2],
              status: "open",
              topic: params[3],
            },
          ],
        };
      }
      if (s.includes("INSERT INTO events")) {
        state.events.push(String(params[2]));
        return { rows: [{ id: `e-${state.events.length}` }] };
      }
      if (s.includes("INSERT INTO audit_log")) {
        return { rows: [{ id: "aud" }] };
      }
      return { rows: [] };
    }

    const client = { query, release() {} };
    const pool = {
      query,
      connect: async () => client,
      end: async () => {},
    } as unknown as import("pg").Pool;

    process.env.NEXUS_MODEL_MODE = "stub";
    process.env.NEXUS_ALLOW_SPEND = "false";

    const result = await runFrhDryRun(pool, {
      workspace: "frh",
      market: "GF",
      slug: "e2e-gf-1",
    });

    assert.equal(result.spend, false);
    assert.equal(result.market, "GF");
    assert.equal(result.campaign.slug, "e2e-gf-1");
    assert.equal(result.campaign.created, true);
    assert.equal(result.campaign.status, "creative");
    assert.deepEqual(
      result.transitions.map((t) => `${t.from}->${t.to}`),
      ["draft->research", "research->strategy", "strategy->creative"]
    );
    assert.equal(result.blackboard_entries, 4);
    assert.equal(result.dual_run.length, 4);
    assert.equal(result.dual_run.filter((d) => d.role === "specialist").length, 2);
    assert.equal(result.dual_run.filter((d) => d.role === "director").length, 2);
    assert.ok(
      result.dual_run
        .filter((d) => d.role === "specialist")
        .every((d) => d.dual_run === true)
    );
    assert.ok(result.dual_run.every((d) => d.ok && d.handoff_valid && d.handoff_id));
    assert.ok(state.invocations >= 4);
    assert.ok(state.handoffs >= 4);
  });
});
