import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectLeak,
  computeAuditStats,
  formatDigestHe,
  formatDigestEn,
  containsHebrew,
  type DigestPayload,
} from "../src/harden/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

describe("Week 4 migration + modules", () => {
  it("has 005_phase1_harden.sql with absorb + digest tables", () => {
    const mig = path.join(root, "migrations", "005_phase1_harden.sql");
    assert.ok(fs.existsSync(mig));
    const sql = fs.readFileSync(mig, "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_absorb_plan/);
    assert.match(sql, /dual_run/);
    assert.match(sql, /retire_scheduled/);
    assert.match(sql, /retired/);
    assert.match(sql, /retire_after/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS digest_runs/);
    assert.match(sql, /body_he/);
    assert.match(sql, /body_en/);
  });

  it("exports harden modules", async () => {
    const mod = await import("../src/harden/index.js");
    assert.equal(typeof mod.assertWorkspaceIsolation, "function");
    assert.equal(typeof mod.runAuditCompleteness, "function");
    assert.equal(typeof mod.buildDailyDigest, "function");
    assert.equal(typeof mod.listDualRunAgents, "function");
    assert.equal(typeof mod.scheduleRetire, "function");
    assert.equal(typeof mod.runPhase1Checklist, "function");
    assert.equal(typeof mod.detectLeak, "function");
    assert.equal(typeof mod.containsHebrew, "function");
  });
});

describe("isolation helpers", () => {
  it("passes when core filter excludes FRH ids", () => {
    const result = detectLeak(
      ["frh-1", "frh-2"],
      ["core-1"] // correctly scoped
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.leakedIds, []);
  });

  it("fails if queried wrong (FRH ids leak into core result)", () => {
    const result = detectLeak(
      ["frh-1", "frh-2"],
      ["core-1", "frh-1"] // BAD: forgot workspace filter
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.leakedIds, ["frh-1"]);
  });
});

describe("audit job structure", () => {
  it("computeAuditStats returns expected shape", () => {
    const s = computeAuditStats(10, 8);
    assert.equal(s.scanned, 10);
    assert.equal(s.matched, 8);
    assert.equal(s.gaps, 2);
    assert.equal(s.pctMatched, 80);
  });

  it("handles zero scanned as 100%", () => {
    const s = computeAuditStats(0, 0);
    assert.equal(s.pctMatched, 100);
    assert.equal(s.gaps, 0);
  });

  it("runAuditCompleteness returns structure (mocked pool)", async () => {
    const { runAuditCompleteness } = await import("../src/harden/auditJob.js");

    async function query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("SELECT id, slug FROM workspaces")) {
        return { rows: [{ id: "ws-frh", slug: "frh" }] };
      }
      if (s.includes("now() -")) {
        return { rows: [{ since: new Date("2026-09-01T00:00:00Z") }] };
      }
      if (s.includes("FROM campaign_status_history")) {
        return {
          rows: [
            {
              id: "h1",
              campaign_id: "c1",
              slug: "demo",
              created_at: new Date("2026-09-10T12:00:00Z"),
            },
          ],
        };
      }
      if (s.includes("FROM creative_gate_actions")) {
        return { rows: [] };
      }
      if (s.includes("FROM council_cases")) {
        return { rows: [] };
      }
      if (s.includes("FROM audit_log") && s.includes("campaign.transition")) {
        // matching audit present
        return { rows: [{ "?column?": 1 }] };
      }
      if (s.includes("FROM audit_log")) {
        return { rows: [] };
      }
      throw new Error("unexpected sql: " + s.slice(0, 120));
    }

    const pool = { query } as unknown as import("pg").Pool;
    const report = await runAuditCompleteness(pool, {
      workspace: "frh",
      days: 7,
    });
    assert.equal(report.workspace, "frh");
    assert.equal(typeof report.overallPctMatched, "number");
    assert.ok(Array.isArray(report.kinds));
    assert.ok(Array.isArray(report.gaps));
    assert.equal(report.kinds.length, 3);
    assert.equal(report.kinds[0].kind, "campaign_transition");
    assert.equal(report.kinds[0].scanned, 1);
    assert.equal(report.kinds[0].matched, 1);
    assert.equal(report.ok, true);
    assert.equal(typeof report.message, "string");
  });
});

describe("Hebrew daily digest", () => {
  const sample: DigestPayload = {
    workspace: "frh",
    digestDate: "2026-09-15",
    campaignsChanged: [{ slug: "e2e-gf-1", from: "draft", to: "research" }],
    councilsDecided: [{ slug: "cpl-1", topic: "CPL spike" }],
    kills: [{ slug: "poster-v1", reason: "sterile" }],
    tasksOpen: 3,
    invocationsCount: 12,
  };

  it("contains Hebrew characters and key sections", () => {
    const he = formatDigestHe(sample);
    assert.ok(containsHebrew(he));
    assert.match(he, /סיכום יומי/);
    assert.match(he, /קמפיינים/);
    assert.match(he, /החלטות מועצה/);
    assert.match(he, /קריאייטיבים/);
    assert.match(he, /משימות פתוחות/);
    assert.match(he, /קריאות מודל/);
    assert.match(he, /e2e-gf-1/);
    assert.match(he, /cpl-1/);
    assert.match(he, /poster-v1/);
  });

  it("EN digest has key sections", () => {
    const en = formatDigestEn(sample);
    assert.match(en, /daily digest/i);
    assert.match(en, /Campaigns changed/);
    assert.match(en, /Councils decided/);
    assert.match(en, /Creative kills/);
    assert.match(en, /Open tasks/);
    assert.match(en, /Model invocations/);
  });
});

describe("absorb schedule (mocked pool)", () => {
  it("scheduleRetire updates row to retire_scheduled", async () => {
    const { scheduleRetire } = await import("../src/harden/absorb.js");

    const state: {
      plan?: {
        id: string;
        status: string;
        retire_after: string | null;
        notes: string | null;
      };
    } = {};

    async function query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("SELECT id FROM workspaces")) {
        return { rows: [{ id: "ws-frh" }] };
      }
      if (s.startsWith("SELECT id, slug, seed_source, dual_run FROM agents")) {
        assert.equal(params[1], "art-director");
        return {
          rows: [
            {
              id: "ag-art",
              slug: "art-director",
              seed_source: "frh-grok:art-director",
              dual_run: true,
            },
          ],
        };
      }
      if (s.startsWith("INSERT INTO agent_absorb_plan")) {
        state.plan = {
          id: "plan-1",
          status: params[3] as string,
          retire_after: params[4] as string,
          notes: params[5] as string,
        };
        return { rows: [{ id: "plan-1" }] };
      }
      if (s.includes("FROM agent_absorb_plan p") && s.includes("WHERE p.id")) {
        return {
          rows: [
            {
              id: "plan-1",
              agent_id: "ag-art",
              agent_slug: "art-director",
              seed_source: "frh-grok:art-director",
              dual_run: true,
              status: state.plan!.status,
              retire_after: state.plan!.retire_after,
              notes: state.plan!.notes,
              updated_at: new Date("2026-09-16T00:00:00Z"),
            },
          ],
        };
      }
      throw new Error("unexpected sql: " + s.slice(0, 140));
    }

    const pool = { query } as unknown as import("pg").Pool;
    const row = await scheduleRetire(pool, {
      workspace: "frh",
      slug: "art-director",
      after: "2026-10-15",
    });
    assert.equal(row.status, "retire_scheduled");
    assert.equal(row.retire_after, "2026-10-15");
    assert.equal(row.agent_slug, "art-director");
    assert.equal(state.plan?.status, "retire_scheduled");
  });
});
