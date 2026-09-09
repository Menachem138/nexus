/** Model router — Cheap First escalation ladder */

import type { ModelId, ParsedPolicy, RouteDecision } from "./types.js";
import { DEFAULT_THRESHOLD } from "./policies.js";

const PROVIDER_FOR: Record<ModelId, string> = {
  "qwen-local": "qwen-local",
  glm: "glm",
  specialist: "specialist",
  astra: "astra",
  council: "council",
};

/**
 * Decide which model to use given agent policy + confidence so far.
 * Escalate when confidenceSoFar < threshold.
 * When ladder is exhausted, recommend council flag.
 */
export function route(
  policy: ParsedPolicy,
  taskClass: string | undefined,
  confidenceSoFar: number | null,
  opts?: { forceModel?: ModelId; stepOffset?: number }
): RouteDecision {
  const threshold = policy.threshold ?? DEFAULT_THRESHOLD;
  const ladder = [...policy.ladder];
  const startAt = opts?.forceModel ?? policy.startAt;

  let startIdx = ladder.indexOf(startAt);
  if (startIdx < 0) startIdx = 0;

  // Apply step offset for escalations already performed
  const offset = opts?.stepOffset ?? 0;
  let idx = Math.min(startIdx + offset, ladder.length - 1);

  // If we have a prior confidence and it's below threshold, escalate one more
  // (caller typically increments stepOffset; this handles first escalate)
  if (
    confidenceSoFar !== null &&
    confidenceSoFar < threshold &&
    offset === 0 &&
    idx < ladder.length - 1
  ) {
    // stay at current for first call; escalate is driven by invoke loop
  }

  const model = ladder[idx] ?? "astra";
  const atEnd = idx >= ladder.length - 1;
  const needCouncil =
    confidenceSoFar !== null && confidenceSoFar < threshold && atEnd;

  const reasonParts = [
    `policy=${policy.slug}`,
    `start=${startAt}`,
    `step=${idx}`,
    `model=${model}`,
    taskClass ? `taskClass=${taskClass}` : null,
    confidenceSoFar !== null
      ? `confidence=${confidenceSoFar.toFixed(3)}/${threshold}`
      : `threshold=${threshold}`,
    policy.skipCheap ? "skip_cheap" : "cheap_first",
  ].filter(Boolean);

  return {
    model,
    ladderStep: idx,
    provider: PROVIDER_FOR[model],
    reason: reasonParts.join("; "),
    councilRecommended: needCouncil,
    ladder,
    startAt,
    threshold,
  };
}

/** Next model on the ladder after current step, or council if exhausted */
export function nextEscalation(
  policy: ParsedPolicy,
  currentStep: number
): { model: ModelId; ladderStep: number; council: boolean } {
  const next = currentStep + 1;
  if (next >= policy.ladder.length) {
    return { model: "council", ladderStep: currentStep, council: true };
  }
  return { model: policy.ladder[next], ladderStep: next, council: false };
}

/** Explain ladder without invoking */
export function explainRoute(policy: ParsedPolicy, agentKind: string): string {
  const lines = [
    `Policy: ${policy.slug}`,
    `Agent kind hint: ${agentKind}`,
    `Skip cheap: ${policy.skipCheap}`,
    `Start at: ${policy.startAt}`,
    `Threshold: ${policy.threshold}`,
    `Ladder: ${policy.ladder.join(" → ")} → [council flag]`,
  ];
  const decision = route(policy, undefined, null);
  lines.push(`Initial decision: ${decision.model} (step ${decision.ladderStep})`);
  lines.push(`Reason: ${decision.reason}`);
  return lines.join("\n");
}
