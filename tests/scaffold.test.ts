import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

describe("nexus phase0 scaffold", () => {
  it("has migration SQL", () => {
    const mig = path.join(root, "migrations", "001_phase0_schema.sql");
    assert.ok(fs.existsSync(mig));
    assert.ok(fs.existsSync(path.join(root, "migrations", "002_phase1_router.sql")));
    assert.ok(fs.existsSync(path.join(root, "migrations", "003_phase1_campaign_loop.sql")));
    const sql = fs.readFileSync(mig, "utf8");
    for (const table of [
      "workspaces", "model_policies", "agents", "markets", "market_twins",
      "blackboards", "blackboard_entries", "campaigns", "tasks", "events",
      "audit_log", "creatives", "creative_dna", "experiments",
      "council_cases", "insights", "frh_profiles",
    ]) {
      assert.match(sql, new RegExp("CREATE TABLE " + table));
    }
    assert.match(sql, /epistemic_class/);
    assert.match(sql, /evidence_class/);
    assert.match(sql, /decay_halflife_days/);
    const mig2 = fs.readFileSync(path.join(root, "migrations", "002_phase1_router.sql"), "utf8");
    assert.match(mig2, /CREATE TABLE model_invocations/);
    assert.match(mig2, /CREATE TABLE agent_handoffs/);
    const mig3 = fs.readFileSync(path.join(root, "migrations", "003_phase1_campaign_loop.sql"), "utf8");
    assert.match(mig3, /CREATE TABLE IF NOT EXISTS campaign_status_history/);
    assert.match(mig3, /CREATE TABLE IF NOT EXISTS council_positions/);
    assert.match(mig3, /CREATE TABLE IF NOT EXISTS creative_gate_actions/);
  });

  it("has package scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const s of ["migrate", "seed", "cli", "test"]) {
      assert.ok(pkg.scripts[s], "missing " + s);
    }
  });

  it("has CLI and seed", () => {
    assert.ok(fs.existsSync(path.join(root, "src", "cli", "index.ts")));
    assert.ok(fs.existsSync(path.join(root, "src", "seed", "seed.ts")));
  });

  it("has docker-compose postgres 16", () => {
    const yml = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    assert.match(yml, /postgres:16/);
    assert.match(yml, /healthcheck/);
  });
});
