-- NEXUS Phase 1 Week 1 — Model Router + agent handoffs telemetry

-- ── model_invocations ───────────────────────────────────────────────────────
CREATE TABLE model_invocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id),
  agent_id        UUID REFERENCES agents(id),
  campaign_id     UUID REFERENCES campaigns(id),
  task_id         UUID REFERENCES tasks(id),
  requested_model TEXT NOT NULL,
  resolved_model  TEXT NOT NULL,
  provider        TEXT NOT NULL,
  ladder_step     INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  confidence      NUMERIC(4,3),
  cost_usd        NUMERIC(12,6),
  latency_ms      INT,
  input_tokens    INT,
  output_tokens   INT,
  request         JSONB NOT NULL DEFAULT '{}'::jsonb,
  response        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX model_invocations_workspace_idx
  ON model_invocations(workspace_id, created_at DESC);
CREATE INDEX model_invocations_agent_idx
  ON model_invocations(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX model_invocations_campaign_idx
  ON model_invocations(campaign_id) WHERE campaign_id IS NOT NULL;

-- ── agent_handoffs ──────────────────────────────────────────────────────────
CREATE TABLE agent_handoffs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id),
  from_agent_id   UUID REFERENCES agents(id),
  to_agent_id     UUID REFERENCES agents(id),
  campaign_id     UUID REFERENCES campaigns(id),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid           BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_handoffs_workspace_idx
  ON agent_handoffs(workspace_id, created_at DESC);
CREATE INDEX agent_handoffs_campaign_idx
  ON agent_handoffs(campaign_id) WHERE campaign_id IS NOT NULL;

-- Enrich seed policies with explicit escalation ladders (idempotent)
UPDATE model_policies
SET policy = policy || '{"escalation_ladder":["qwen-local","glm","specialist","astra"],"confidence_threshold":0.9,"start_at":"qwen-local"}'::jsonb,
    updated_at = now()
WHERE slug = 'cheap-first'
  AND (policy->>'escalation_ladder') IS NULL;

UPDATE model_policies
SET policy = policy || '{"escalation_ladder":["astra"],"confidence_threshold":0.9,"start_at":"astra","skip_cheap":true}'::jsonb,
    updated_at = now()
WHERE slug = 'managers-astra6'
  AND (policy->>'escalation_ladder') IS NULL;
