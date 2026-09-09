/** Invoke agent by workspace+slug — policy resolution + ladder + telemetry */

import type { Db } from "../db/client.js";
import { loadPolicyForAgent } from "./policies.js";
import { route, nextEscalation } from "./router.js";
import { getProvider, getModelMode } from "./providers.js";
import { buildContext } from "./context.js";
import type {
  AgentRow,
  InvokeRequest,
  InvokeResult,
  ModelId,
} from "./types.js";

async function loadAgent(
  db: Db,
  workspaceSlug: string,
  agentSlug: string
): Promise<{ agent: AgentRow; workspaceId: string }> {
  const ws = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL`,
    [workspaceSlug]
  );
  if (ws.rows.length === 0) {
    throw new Error(`workspace not found: ${workspaceSlug}`);
  }
  const workspaceId = ws.rows[0].id;
  const ag = await db.query<AgentRow>(
    `SELECT id, workspace_id, slug, name, role, kind, policy_id, config
     FROM agents
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, agentSlug]
  );
  if (ag.rows.length === 0) {
    throw new Error(`agent not found: ${workspaceSlug}/${agentSlug}`);
  }
  return { agent: ag.rows[0], workspaceId };
}

async function writeInvocation(
  db: Db,
  row: {
    workspaceId: string;
    agentId: string;
    campaignId: string | null;
    taskId: string | null;
    requestedModel: string;
    resolvedModel: string;
    provider: string;
    ladderStep: number;
    status: string;
    confidence: number | null;
    costUsd: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    error: string | null;
  }
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO model_invocations (
       workspace_id, agent_id, campaign_id, task_id,
       requested_model, resolved_model, provider, ladder_step,
       status, confidence, cost_usd, latency_ms, input_tokens, output_tokens,
       request, response, error
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17
     ) RETURNING id`,
    [
      row.workspaceId,
      row.agentId,
      row.campaignId,
      row.taskId,
      row.requestedModel,
      row.resolvedModel,
      row.provider,
      row.ladderStep,
      row.status,
      row.confidence,
      row.costUsd,
      row.latencyMs,
      row.inputTokens,
      row.outputTokens,
      JSON.stringify(row.request),
      JSON.stringify(row.response),
      row.error,
    ]
  );
  return res.rows[0].id;
}

/**
 * Load agent+policy, build context, call provider through ladder until
 * confidence ok or council recommended. Writes model_invocations rows.
 */
export async function invokeAgent(
  db: Db,
  req: InvokeRequest
): Promise<InvokeResult> {
  const t0 = Date.now();
  const { agent, workspaceId } = await loadAgent(
    db,
    req.workspaceSlug,
    req.agentSlug
  );
  const policy = await loadPolicyForAgent(db, agent);
  const threshold = req.confidenceThreshold ?? policy.threshold;
  const maxEsc = req.maxEscalations ?? Math.max(policy.ladder.length, 1);

  const ctx = await buildContext(db, workspaceId, req.campaignSlug);
  const escalationPath: ModelId[] = [];
  const invocationIds: string[] = [];
  let totalCost = 0;
  let lastText = "";
  let lastConfidence = 0;
  let councilRecommended = false;
  let resolvedModel: ModelId = policy.startAt;
  let resolvedProvider = "stub";
  let lastStep = 0;
  let error: string | undefined;

  const effectivePolicy = {
    ...policy,
    threshold,
    startAt: req.forceModel ?? policy.startAt,
    ladder: [...policy.ladder],
  };

  if (req.forceModel && !effectivePolicy.ladder.includes(req.forceModel)) {
    effectivePolicy.ladder = [req.forceModel, ...effectivePolicy.ladder];
  }

  const startIdx = Math.max(
    0,
    effectivePolicy.ladder.indexOf(effectivePolicy.startAt)
  );
  const startDecision = route(effectivePolicy, undefined, null, {
    forceModel: req.forceModel,
    stepOffset: 0,
  });
  const requestedModel = startDecision.model;

  let absoluteStep = startIdx;

  for (let attempt = 0; attempt < maxEsc; attempt++) {
    const relativeOffset = absoluteStep - startIdx;
    const decision = route(effectivePolicy, undefined, null, {
      forceModel: req.forceModel,
      stepOffset: Math.max(0, relativeOffset),
    });
    // Prefer absolute index for clarity
    const model =
      effectivePolicy.ladder[
        Math.min(absoluteStep, effectivePolicy.ladder.length - 1)
      ] ?? decision.model;
    lastStep = Math.min(absoluteStep, effectivePolicy.ladder.length - 1);
    resolvedModel = model;
    resolvedProvider = getModelMode() === "stub" ? "stub" : decision.provider;
    escalationPath.push(model);

    const provider = getProvider(model);
    try {
      const completion = await provider.complete(req.prompt, ctx.promptContext);
      lastText = completion.text;
      lastConfidence = completion.confidence;
      totalCost += completion.costUsd;

      const invId = await writeInvocation(db, {
        workspaceId,
        agentId: agent.id,
        campaignId: ctx.campaignId,
        taskId: req.taskId ?? null,
        requestedModel,
        resolvedModel: model,
        provider: provider.id,
        ladderStep: lastStep,
        status: "ok",
        confidence: completion.confidence,
        costUsd: completion.costUsd,
        latencyMs: completion.latencyMs,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        request: {
          prompt: req.prompt,
          context_summary: ctx.summary,
          mode: getModelMode(),
          attempt,
        },
        response: completion.raw,
        error: null,
      });
      invocationIds.push(invId);

      if (completion.confidence >= threshold) {
        return {
          ok: true,
          text: lastText,
          confidence: lastConfidence,
          requestedModel,
          resolvedModel,
          provider: provider.id,
          ladderStep: lastStep,
          councilRecommended: false,
          escalationPath,
          invocationIds,
          latencyMs: Date.now() - t0,
          costUsd: totalCost,
          contextSummary: ctx.summary,
        };
      }

      const nxt = nextEscalation(effectivePolicy, lastStep);
      if (nxt.council) {
        councilRecommended = true;
        break;
      }
      absoluteStep = nxt.ladderStep;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      const invId = await writeInvocation(db, {
        workspaceId,
        agentId: agent.id,
        campaignId: ctx.campaignId,
        taskId: req.taskId ?? null,
        requestedModel,
        resolvedModel: model,
        provider: provider.id,
        ladderStep: lastStep,
        status: "error",
        confidence: null,
        costUsd: 0,
        latencyMs: Date.now() - t0,
        inputTokens: 0,
        outputTokens: 0,
        request: { prompt: req.prompt, mode: getModelMode(), attempt },
        response: {},
        error,
      });
      invocationIds.push(invId);

      const nxt = nextEscalation(effectivePolicy, lastStep);
      if (nxt.council) {
        councilRecommended = true;
        break;
      }
      absoluteStep = nxt.ladderStep;
    }
  }

  if (!councilRecommended && lastConfidence < threshold) {
    councilRecommended = true;
  }

  return {
    ok: !error || lastText.length > 0,
    text: lastText || (error ? `error: ${error}` : ""),
    confidence: lastConfidence,
    requestedModel,
    resolvedModel,
    provider: resolvedProvider,
    ladderStep: lastStep,
    councilRecommended,
    escalationPath,
    invocationIds,
    latencyMs: Date.now() - t0,
    costUsd: totalCost,
    contextSummary: ctx.summary,
    error,
  };
}

/** Explain routing for an agent without invoking */
export async function explainAgentRoute(
  db: Db,
  workspaceSlug: string,
  agentSlug: string
): Promise<{
  agent: AgentRow;
  policySlug: string;
  explanation: string;
  ladder: ModelId[];
  startAt: ModelId;
  skipCheap: boolean;
}> {
  const { agent } = await loadAgent(db, workspaceSlug, agentSlug);
  const policy = await loadPolicyForAgent(db, agent);
  const decision = route(policy, undefined, null);
  const explanation = [
    `Workspace: ${workspaceSlug}`,
    `Agent: ${agent.slug} (${agent.name})`,
    `Kind/role: ${agent.kind} / ${agent.role}`,
    `Policy: ${policy.slug}`,
    `Skip cheap: ${policy.skipCheap}`,
    `Start at: ${policy.startAt}`,
    `Threshold: ${policy.threshold}`,
    `Ladder: ${policy.ladder.join(" → ")} → [council]`,
    `Initial model: ${decision.model} (provider=${decision.provider}, step=${decision.ladderStep})`,
    `Reason: ${decision.reason}`,
    `Model mode: ${getModelMode()}`,
  ].join("\n");

  return {
    agent,
    policySlug: policy.slug,
    explanation,
    ladder: policy.ladder,
    startAt: policy.startAt,
    skipCheap: policy.skipCheap,
  };
}
