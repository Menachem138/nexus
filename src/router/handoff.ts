/** Structured handoff validator / normalizer */

import {
  HANDOFF_REQUIRED_KEYS,
  type HandoffPayload,
  type HandoffRequiredKey,
} from "./types.js";

export interface HandoffValidation {
  valid: boolean;
  payload: HandoffPayload | null;
  missing: string[];
  errors: string[];
  normalized?: HandoffPayload;
}

function asString(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
}

function asConfidence(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Validate and normalize a handoff object */
export function validateHandoff(input: unknown): HandoffValidation {
  const errors: string[] = [];
  const missing: string[] = [];

  if (input === null || input === undefined) {
    return {
      valid: false,
      payload: null,
      missing: [...HANDOFF_REQUIRED_KEYS],
      errors: ["handoff payload is null/undefined"],
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      payload: null,
      missing: [...HANDOFF_REQUIRED_KEYS],
      errors: ["handoff payload must be a JSON object"],
    };
  }

  const obj = input as Record<string, unknown>;
  for (const key of HANDOFF_REQUIRED_KEYS) {
    if (!(key in obj) || obj[key] === null || obj[key] === undefined) {
      missing.push(key);
    } else if (key !== "confidence" && asString(obj[key]).trim() === "") {
      missing.push(key);
      errors.push(`${key} must be a non-empty string`);
    }
  }

  const conf = asConfidence(obj.confidence);
  if (conf === null) {
    if (!missing.includes("confidence")) missing.push("confidence");
    errors.push("confidence must be a finite number");
  } else if (conf < 0 || conf > 1) {
    errors.push("confidence must be between 0 and 1 inclusive");
  }

  if (missing.length > 0 || errors.length > 0) {
    return { valid: false, payload: obj as HandoffPayload, missing, errors };
  }

  const normalized: HandoffPayload = {
    finding: asString(obj.finding).trim(),
    evidence: asString(obj.evidence).trim(),
    source: asString(obj.source).trim(),
    confidence: conf as number,
    recommendation: asString(obj.recommendation).trim(),
    risks: asString(obj.risks).trim(),
    unknowns: asString(obj.unknowns).trim(),
    question_for_next_agent: asString(obj.question_for_next_agent).trim(),
  };

  for (const [k, v] of Object.entries(obj)) {
    if (!(k in normalized)) normalized[k] = v;
  }

  return {
    valid: true,
    payload: normalized,
    missing: [],
    errors: [],
    normalized,
  };
}

export function requiredKeysList(): HandoffRequiredKey[] {
  return [...HANDOFF_REQUIRED_KEYS];
}
