/** NEXUS Phase 1 — Model Router types */

export type ModelId =
  | "qwen-local"
  | "glm"
  | "specialist"
  | "astra"
  | "council";

export type LadderStep = number;

export interface RouteDecision {
  model: ModelId;
  ladderStep: LadderStep;
  provider: string;
  reason: string;
  councilRecommended?: boolean;
  ladder: ModelId[];
  startAt: ModelId;
  threshold: number;
}

export interface InvokeRequest {
  workspaceSlug: string;
  agentSlug: string;
  prompt: string;
  campaignSlug?: string;
  taskId?: string;
  maxEscalations?: number;
  confidenceThreshold?: number;
  /** Force start model (overrides policy start_at) */
  forceModel?: ModelId;
}

export interface InvokeResult {
  ok: boolean;
  text: string;
  confidence: number;
  requestedModel: ModelId;
  resolvedModel: ModelId;
  provider: string;
  ladderStep: number;
  councilRecommended: boolean;
  escalationPath: ModelId[];
  invocationIds: string[];
  latencyMs: number;
  costUsd: number;
  contextSummary?: string;
  error?: string;
}

/** Structured handoff payload between agents */
export interface HandoffPayload {
  finding: string;
  evidence: string;
  source: string;
  confidence: number;
  recommendation: string;
  risks: string;
  unknowns: string;
  question_for_next_agent: string;
  [key: string]: unknown;
}

export const HANDOFF_REQUIRED_KEYS = [
  "finding",
  "evidence",
  "source",
  "confidence",
  "recommendation",
  "risks",
  "unknowns",
  "question_for_next_agent",
] as const;

export type HandoffRequiredKey = (typeof HANDOFF_REQUIRED_KEYS)[number];

export interface AgentRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  role: string;
  kind: string;
  policy_id: string | null;
  config: Record<string, unknown>;
}

export interface PolicyRow {
  id: string;
  workspace_id: string | null;
  slug: string;
  name: string;
  policy: Record<string, unknown>;
  is_default: boolean;
}

export interface ParsedPolicy {
  slug: string;
  ladder: ModelId[];
  startAt: ModelId;
  threshold: number;
  skipCheap: boolean;
  raw: Record<string, unknown>;
}

export interface ProviderCompletion {
  text: string;
  confidence: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  raw: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly model: ModelId;
  complete(prompt: string, context?: string): Promise<ProviderCompletion>;
}
