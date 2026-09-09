import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePolicy,
  defaultLadderForPolicySlug,
  isManagerKind,
  CHEAP_FIRST_LADDER,
  MANAGERS_ASTRA6_LADDER,
} from "../src/router/policies.js";
import { route, nextEscalation } from "../src/router/router.js";
import { validateHandoff } from "../src/router/handoff.js";
import { StubProvider } from "../src/router/providers.js";
import type { ParsedPolicy, PolicyRow } from "../src/router/types.js";

describe("ladder selection: manager vs cheap", () => {
  it("cheap-first defaults to full ladder starting at qwen-local", () => {
    const d = defaultLadderForPolicySlug("cheap-first");
    assert.deepEqual(d.ladder, CHEAP_FIRST_LADDER);
    assert.equal(d.startAt, "qwen-local");
    assert.equal(d.skipCheap, false);
  });

  it("managers-astra6 defaults to astra-only", () => {
    const d = defaultLadderForPolicySlug("managers-astra6");
    assert.deepEqual(d.ladder, MANAGERS_ASTRA6_LADDER);
    assert.equal(d.startAt, "astra");
    assert.equal(d.skipCheap, true);
  });

  it("isManagerKind recognizes cmo/director", () => {
    assert.equal(isManagerKind("cmo"), true);
    assert.equal(isManagerKind("director"), true);
    assert.equal(isManagerKind("specialist"), false);
  });

  it("parsePolicy fills thin JSON for cheap-first", () => {
    const row: PolicyRow = {
      id: "x",
      workspace_id: "w",
      slug: "cheap-first",
      name: "Cheap",
      policy: { tier: "economy" },
      is_default: false,
    };
    const p = parsePolicy(row);
    assert.equal(p.startAt, "qwen-local");
    assert.deepEqual(p.ladder[0], "qwen-local");
    assert.ok(p.ladder.includes("astra"));
  });

  it("parsePolicy fills thin JSON for managers-astra6", () => {
    const row: PolicyRow = {
      id: "x",
      workspace_id: "w",
      slug: "managers-astra6",
      name: "Mgr",
      policy: {},
      is_default: true,
    };
    const p = parsePolicy(row);
    assert.equal(p.startAt, "astra");
    assert.equal(p.skipCheap, true);
    assert.deepEqual(p.ladder, ["astra"]);
  });

  it("route starts managers at astra", () => {
    const policy: ParsedPolicy = {
      slug: "managers-astra6",
      ladder: ["astra"],
      startAt: "astra",
      threshold: 0.9,
      skipCheap: true,
      raw: {},
    };
    const d = route(policy, undefined, null);
    assert.equal(d.model, "astra");
    assert.equal(d.ladderStep, 0);
  });

  it("route starts cheap-first at qwen-local", () => {
    const policy: ParsedPolicy = {
      slug: "cheap-first",
      ladder: [...CHEAP_FIRST_LADDER],
      startAt: "qwen-local",
      threshold: 0.9,
      skipCheap: false,
      raw: {},
    };
    const d = route(policy, undefined, null);
    assert.equal(d.model, "qwen-local");
  });
});

describe("handoff validator", () => {
  const good = {
    finding: "CPL rose after creative fatigue",
    evidence: "CPL +40% WoW on GF",
    source: "meta-ads-export",
    confidence: 0.82,
    recommendation: "Rotate creatives",
    risks: "Spend spike if bid too aggressive",
    unknowns: "Audience overlap with MQ",
    question_for_next_agent: "Which creative variants to kill?",
  };

  it("accepts complete handoff", () => {
    const v = validateHandoff(good);
    assert.equal(v.valid, true);
    assert.equal(v.missing.length, 0);
    assert.ok(v.normalized);
    assert.equal(v.normalized!.confidence, 0.82);
  });

  it("rejects missing keys", () => {
    const { question_for_next_agent, ...bad } = good;
    void question_for_next_agent;
    const v = validateHandoff(bad);
    assert.equal(v.valid, false);
    assert.ok(v.missing.includes("question_for_next_agent"));
  });

  it("rejects bad confidence", () => {
    const v = validateHandoff({ ...good, confidence: 1.5 });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes("confidence")));
  });

  it("rejects non-object", () => {
    const v = validateHandoff("nope");
    assert.equal(v.valid, false);
  });
});

describe("router escalation with stub low confidence", () => {
  it("stub qwen-local confidence is below 0.9", async () => {
    const p = new StubProvider("qwen-local");
    const c = await p.complete("hello");
    assert.ok(c.confidence < 0.9);
  });

  it("stub astra confidence meets 0.9", async () => {
    const p = new StubProvider("astra");
    const c = await p.complete("hello");
    assert.ok(c.confidence >= 0.9);
  });

  it("force-escalate prompt keeps confidence low", async () => {
    const p = new StubProvider("astra");
    const c = await p.complete("force-escalate please");
    assert.ok(c.confidence <= 0.4);
  });

  it("nextEscalation walks cheap ladder then council", () => {
    const policy: ParsedPolicy = {
      slug: "cheap-first",
      ladder: [...CHEAP_FIRST_LADDER],
      startAt: "qwen-local",
      threshold: 0.9,
      skipCheap: false,
      raw: {},
    };
    const n0 = nextEscalation(policy, 0);
    assert.equal(n0.model, "glm");
    assert.equal(n0.council, false);
    const n3 = nextEscalation(policy, 3);
    assert.equal(n3.council, true);
    assert.equal(n3.model, "council");
  });

  it("escalation path: low confidence escalates step by step", async () => {
    const policy: ParsedPolicy = {
      slug: "cheap-first",
      ladder: [...CHEAP_FIRST_LADDER],
      startAt: "qwen-local",
      threshold: 0.9,
      skipCheap: false,
      raw: {},
    };
    const path: string[] = [];
    let step = 0;
    let conf = 0;
    for (let i = 0; i < 5; i++) {
      const model = policy.ladder[Math.min(step, policy.ladder.length - 1)];
      path.push(model);
      const completion = await new StubProvider(model).complete("why cpl");
      conf = completion.confidence;
      if (conf >= policy.threshold) break;
      const nxt = nextEscalation(policy, step);
      if (nxt.council) {
        path.push("council");
        break;
      }
      step = nxt.ladderStep;
    }
    assert.deepEqual(path, ["qwen-local", "glm", "specialist", "astra"]);
    assert.ok(conf >= 0.9);
  });
});
