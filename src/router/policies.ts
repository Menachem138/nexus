/** Load and parse model_policies — cheap-first vs managers-astra6 */

import type { Db } from "../db/client.js";
import type { AgentRow, ModelId, ParsedPolicy, PolicyRow } from "./types.js";

/** Default Cheap First escalation ladder */
export const CHEAP_FIRST_LADDER: ModelId[] = [
  "qwen-local",
  "glm",
  "specialist",
  "astra",
];

/** Managers / directors start at astra (skip cheap ladder) */
export const MANAGERS_ASTRA6_LADDER: ModelId[] = ["astra"];

export const DEFAULT_THRESHOLD = 0.9;

const MANAGER_KINDS = new Set(["cmo", "director", "executive"]);

export function isManagerKind(kind: string, role?: string): boolean {
  const k = (kind || "").toLowerCase();
  const r = (role || "").toLowerCase();
  return MANAGER_KINDS.has(k) || MANAGER_KINDS.has(r) || k === "manager";
}

export function defaultLadderForPolicySlug(slug: string): {
  ladder: ModelId[];
  startAt: ModelId;
  skipCheap: boolean;
} {
  const s = slug.toLowerCase();
  if (s === "managers-astra6" || s.includes("managers") || s.includes("astra6")) {
    return { ladder: [...MANAGERS_ASTRA6_LADDER], startAt: "astra", skipCheap: true };
  }
  return { ladder: [...CHEAP_FIRST_LADDER], startAt: "qwen-local", skipCheap: false };
}

function asModelId(v: unknown, fallback: ModelId): ModelId {
  const allowed: ModelId[] = ["qwen-local", "glm", "specialist", "astra", "council"];
  if (typeof v === "string" && (allowed as string[]).includes(v)) return v as ModelId;
  return fallback;
}

function asLadder(v: unknown, fallback: ModelId[]): ModelId[] {
  if (!Array.isArray(v) || v.length === 0) return [...fallback];
  const out: ModelId[] = [];
  for (const item of v) {
    const m = asModelId(item, "qwen-local");
    if (m !== "council") out.push(m);
  }
  return out.length > 0 ? out : [...fallback];
}

/** Parse policy JSON; fill defaults when JSON is thin */
export function parsePolicy(row: PolicyRow): ParsedPolicy {
  const raw = (row.policy ?? {}) as Record<string, unknown>;
  const defaults = defaultLadderForPolicySlug(row.slug);
  const ladder = asLadder(raw.escalation_ladder, defaults.ladder);
  const startAt = asModelId(raw.start_at, defaults.startAt);
  const threshold =
    typeof raw.confidence_threshold === "number"
      ? raw.confidence_threshold
      : DEFAULT_THRESHOLD;
  const skipCheap =
    typeof raw.skip_cheap === "boolean" ? raw.skip_cheap : defaults.skipCheap;

  let finalLadder = [...ladder];
  if (!finalLadder.includes(startAt)) {
    finalLadder = [startAt, ...finalLadder.filter((m) => m !== startAt)];
  }

  return {
    slug: row.slug,
    ladder: finalLadder,
    startAt,
    threshold,
    skipCheap,
    raw,
  };
}

/** Resolve policy for an agent: explicit policy_id → kind-based default → cheap-first */
export async function loadPolicyForAgent(
  db: Db,
  agent: AgentRow
): Promise<ParsedPolicy> {
  if (agent.policy_id) {
    const res = await db.query<PolicyRow>(
      `SELECT id, workspace_id, slug, name, policy, is_default
       FROM model_policies WHERE id = $1 AND deleted_at IS NULL`,
      [agent.policy_id]
    );
    if (res.rows.length > 0) return parsePolicy(res.rows[0]);
  }

  const def = await db.query<PolicyRow>(
    `SELECT id, workspace_id, slug, name, policy, is_default
     FROM model_policies
     WHERE workspace_id = $1 AND is_default = true AND deleted_at IS NULL
     LIMIT 1`,
    [agent.workspace_id]
  );
  if (def.rows.length > 0) {
    const parsed = parsePolicy(def.rows[0]);
    if (isManagerKind(agent.kind, agent.role) && !parsed.skipCheap) {
      return {
        slug: "managers-astra6(inferred)",
        ladder: [...MANAGERS_ASTRA6_LADDER],
        startAt: "astra",
        threshold: parsed.threshold,
        skipCheap: true,
        raw: { inferred: true, from: def.rows[0].slug },
      };
    }
    return parsed;
  }

  if (isManagerKind(agent.kind, agent.role)) {
    return {
      slug: "managers-astra6(default)",
      ladder: [...MANAGERS_ASTRA6_LADDER],
      startAt: "astra",
      threshold: DEFAULT_THRESHOLD,
      skipCheap: true,
      raw: {},
    };
  }
  return {
    slug: "cheap-first(default)",
    ladder: [...CHEAP_FIRST_LADDER],
    startAt: "qwen-local",
    threshold: DEFAULT_THRESHOLD,
    skipCheap: false,
    raw: {},
  };
}

export async function loadPolicyBySlug(
  db: Db,
  workspaceId: string,
  slug: string
): Promise<ParsedPolicy | null> {
  const res = await db.query<PolicyRow>(
    `SELECT id, workspace_id, slug, name, policy, is_default
     FROM model_policies
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, slug]
  );
  if (res.rows.length === 0) return null;
  return parsePolicy(res.rows[0]);
}
