/**
 * Provider adapters. Default mode is stub (deterministic, no network).
 * Live placeholders throw clearly when keys are missing.
 * Never commit secrets; keys come from env only.
 */

import type { ModelId, ProviderAdapter, ProviderCompletion } from "./types.js";

export function getModelMode(): "stub" | "live" {
  const m = (process.env.NEXUS_MODEL_MODE ?? "stub").toLowerCase();
  return m === "live" ? "live" : "stub";
}

/** Deterministic fake completion — confidence rises with ladder step / model tier */
export class StubProvider implements ProviderAdapter {
  readonly id = "stub";
  readonly model: ModelId;
  private readonly forcedConfidence?: number;

  constructor(model: ModelId, forcedConfidence?: number) {
    this.model = model;
    this.forcedConfidence = forcedConfidence;
  }

  async complete(prompt: string, context?: string): Promise<ProviderCompletion> {
    const start = Date.now();
    const base: Record<ModelId, number> = {
      "qwen-local": 0.55,
      glm: 0.72,
      specialist: 0.85,
      astra: 0.94,
      council: 0.98,
    };
    let confidence = this.forcedConfidence ?? base[this.model] ?? 0.5;

    const lower = prompt.toLowerCase();
    if (lower.includes("certain") || lower.includes("definitive")) {
      confidence = Math.min(0.99, confidence + 0.05);
    }
    if (lower.includes("[low-confidence]") || lower.includes("force-escalate")) {
      confidence = Math.min(confidence, 0.4);
    }

    const contextNote = context ? ` [ctx:${context.length} chars]` : "";
    const text =
      `[stub:${this.model}] ${prompt.slice(0, 200)}${contextNote}\n` +
      `Confidence=${confidence.toFixed(3)}. This is a deterministic stub reply; ` +
      `set NEXUS_MODEL_MODE=live and configure provider keys for real calls.`;

    const inputTokens = Math.ceil((prompt.length + (context?.length ?? 0)) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    const costUsd =
      this.model === "qwen-local"
        ? 0
        : this.model === "glm"
          ? 0.0001
          : this.model === "specialist"
            ? 0.001
            : this.model === "astra"
              ? 0.01
              : 0.05;

    await new Promise((r) => setTimeout(r, 1));

    return {
      text,
      confidence,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: Date.now() - start,
      raw: { stub: true, model: this.model, confidence },
    };
  }
}

/** Live placeholders — throw until keys are configured */
export class RealProviderPlaceholder implements ProviderAdapter {
  readonly id: string;
  readonly model: ModelId;
  private readonly envKey: string;

  constructor(model: ModelId, providerId: string, envKey: string) {
    this.model = model;
    this.id = providerId;
    this.envKey = envKey;
  }

  async complete(_prompt: string, _context?: string): Promise<ProviderCompletion> {
    const key = process.env[this.envKey];
    if (!key) {
      throw new Error(
        `Provider ${this.id} not configured: set ${this.envKey} and NEXUS_MODEL_MODE=live`
      );
    }
    throw new Error(
      `Provider ${this.id} live adapter is a placeholder (Phase 1 Week 1). ` +
        `Key ${this.envKey} is present but real HTTP client is not wired yet.`
    );
  }
}

const MODEL_PROVIDER: Record<ModelId, { id: string; envKey: string }> = {
  "qwen-local": { id: "qwen-local", envKey: "QWEN_LOCAL_URL" },
  glm: { id: "glm", envKey: "GLM_API_KEY" },
  specialist: { id: "specialist", envKey: "SPECIALIST_API_KEY" },
  astra: { id: "astra", envKey: "OPENCODEX_API_KEY" },
  council: { id: "council", envKey: "OPENCODEX_API_KEY" },
};

export function getProvider(
  model: ModelId,
  opts?: { forcedConfidence?: number }
): ProviderAdapter {
  if (getModelMode() === "stub") {
    return new StubProvider(model, opts?.forcedConfidence);
  }
  const meta = MODEL_PROVIDER[model];
  return new RealProviderPlaceholder(model, meta.id, meta.envKey);
}
