-- NEXUS Phase 1 Week 2 — Campaign loop (status machine, council positions, creative gates)

-- ── campaign status check (allowed set) ─────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_status_check'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_status_check
      CHECK (status IN (
        'draft', 'research', 'strategy', 'creative', 'review',
        'approved', 'live', 'paused', 'learned', 'killed'
      ));
  END IF;
END $$;

-- ── campaign_status_history ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_status_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  actor         TEXT,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_status_history_campaign_idx
  ON campaign_status_history(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_status_history_workspace_idx
  ON campaign_status_history(workspace_id, created_at DESC);

-- ── council_positions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS council_positions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES council_cases(id),
  agent_id      UUID REFERENCES agents(id),
  agent_slug    TEXT NOT NULL,
  stance        TEXT NOT NULL,
  body          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS council_positions_case_idx
  ON council_positions(case_id, created_at);

-- ── creative_gate_actions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_gate_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id   UUID NOT NULL REFERENCES creatives(id),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  action        TEXT NOT NULL CHECK (action IN ('approve', 'kill')),
  actor         TEXT,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_gate_actions_creative_idx
  ON creative_gate_actions(creative_id, created_at DESC);
CREATE INDEX IF NOT EXISTS creative_gate_actions_workspace_idx
  ON creative_gate_actions(workspace_id, created_at DESC);
