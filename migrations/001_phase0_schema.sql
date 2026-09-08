-- NEXUS Phase 0 schema
-- Conventions: uuid PKs, timestamptz, soft delete (deleted_at), workspace_id isolation

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── workspaces ──────────────────────────────────────────────────────────────
CREATE TABLE workspaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ── model_policies ──────────────────────────────────────────────────────────
CREATE TABLE model_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id),
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  policy        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

-- ── agents ──────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id),
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'director',
  seed_source   TEXT,
  dual_run      BOOLEAN NOT NULL DEFAULT false,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_id     UUID REFERENCES model_policies(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX agents_workspace_idx ON agents(workspace_id) WHERE deleted_at IS NULL;

-- ── markets / market_twins ──────────────────────────────────────────────────
CREATE TABLE markets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  locale        TEXT,
  timezone      TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, code)
);

CREATE TABLE market_twins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  market_id     UUID NOT NULL REFERENCES markets(id),
  slug          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'stub',
  twin_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

-- ── blackboards ─────────────────────────────────────────────────────────────
CREATE TABLE blackboards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  campaign_id   UUID,
  slug          TEXT NOT NULL,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'empty',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE blackboard_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  blackboard_id UUID NOT NULL REFERENCES blackboards(id),
  entry_type    TEXT NOT NULL,
  author_agent  TEXT,
  content       JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX blackboard_entries_bb_idx ON blackboard_entries(blackboard_id) WHERE deleted_at IS NULL;

-- ── campaigns ───────────────────────────────────────────────────────────────
CREATE TABLE campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  market_id     UUID REFERENCES markets(id),
  blackboard_id UUID REFERENCES blackboards(id),
  brief         JSONB NOT NULL DEFAULT '{}'::jsonb,
  human_gate    TEXT NOT NULL DEFAULT 'pending',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

-- late FK: blackboards.campaign_id
ALTER TABLE blackboards
  ADD CONSTRAINT blackboards_campaign_fk
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

-- ── tasks ───────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  campaign_id   UUID REFERENCES campaigns(id),
  agent_id      UUID REFERENCES agents(id),
  slug          TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX tasks_campaign_idx ON tasks(campaign_id) WHERE deleted_at IS NULL;

-- ── events ──────────────────────────────────────────────────────────────────
CREATE TABLE events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  campaign_id   UUID REFERENCES campaigns(id),
  event_type    TEXT NOT NULL,
  actor         TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_workspace_idx ON events(workspace_id, created_at DESC);

-- ── audit_log ───────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id),
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     UUID,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_workspace_idx ON audit_log(workspace_id, created_at DESC);

-- ── creatives / creative_dna ────────────────────────────────────────────────
CREATE TABLE creatives (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  campaign_id   UUID REFERENCES campaigns(id),
  market_id     UUID REFERENCES markets(id),
  slug          TEXT NOT NULL,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  sterile_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_qa_status  TEXT,
  human_taste   TEXT,
  asset_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE creative_dna (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  creative_id   UUID NOT NULL REFERENCES creatives(id),
  dna           JSONB NOT NULL DEFAULT '{}'::jsonb,
  version       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ── experiments ─────────────────────────────────────────────────────────────
CREATE TABLE experiments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  campaign_id   UUID REFERENCES campaigns(id),
  slug          TEXT NOT NULL,
  hypothesis    TEXT,
  status        TEXT NOT NULL DEFAULT 'planned',
  design        JSONB NOT NULL DEFAULT '{}'::jsonb,
  results       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

-- ── council_cases ───────────────────────────────────────────────────────────
CREATE TABLE council_cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  campaign_id   UUID REFERENCES campaigns(id),
  slug          TEXT NOT NULL,
  topic         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  case_body     JSONB NOT NULL DEFAULT '{}'::jsonb,
  verdict       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);

-- ── insights (epistemic + evidence + decay) ─────────────────────────────────
CREATE TABLE insights (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id),
  creative_id      UUID REFERENCES creatives(id),
  campaign_id      UUID REFERENCES campaigns(id),
  slug             TEXT,
  title            TEXT NOT NULL,
  body             TEXT,
  epistemic_class  TEXT NOT NULL DEFAULT 'hypothesis',
  evidence_class   TEXT NOT NULL DEFAULT 'anecdotal',
  confidence       NUMERIC(4,3) DEFAULT 0.500,
  decay_halflife_days NUMERIC(8,2) DEFAULT 30,
  decay_score      NUMERIC(6,4) DEFAULT 1.0000,
  last_reinforced_at TIMESTAMPTZ,
  tags             JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

CREATE INDEX insights_workspace_idx ON insights(workspace_id) WHERE deleted_at IS NULL;

-- ── frh_profiles (stub) ─────────────────────────────────────────────────────
CREATE TABLE frh_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  slug          TEXT NOT NULL,
  display_name  TEXT,
  profile       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (workspace_id, slug)
);
