-- NEXUS Phase 1 Week 4 — Harden + Phase 1 exit (absorb plan + digest runs)

-- ── agent_absorb_plan ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_absorb_plan (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  agent_id      UUID NOT NULL REFERENCES agents(id),
  seed_source   TEXT,
  status        TEXT NOT NULL DEFAULT 'dual_run'
                  CHECK (status IN ('dual_run', 'retire_scheduled', 'retired')),
  retire_after  DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS agent_absorb_plan_workspace_idx
  ON agent_absorb_plan(workspace_id, status);

CREATE INDEX IF NOT EXISTS agent_absorb_plan_retire_idx
  ON agent_absorb_plan(retire_after)
  WHERE retire_after IS NOT NULL AND status = 'retire_scheduled';

-- ── digest_runs (optional Hebrew daily digest store) ────────────────────────
CREATE TABLE IF NOT EXISTS digest_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  digest_date   DATE NOT NULL,
  body_he       TEXT,
  body_en       TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, digest_date)
);

CREATE INDEX IF NOT EXISTS digest_runs_workspace_date_idx
  ON digest_runs(workspace_id, digest_date DESC);
