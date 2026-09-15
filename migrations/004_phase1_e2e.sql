-- NEXUS Phase 1 Week 3 — FRH E2E dry-run (performance_daily CSV stub ingest)

CREATE TABLE IF NOT EXISTS performance_daily (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id),
  market_code      TEXT NOT NULL,
  campaign_id      UUID REFERENCES campaigns(id),
  creative_id      UUID REFERENCES creatives(id),
  date             DATE NOT NULL,
  spend            NUMERIC(14,4) NOT NULL DEFAULT 0,
  impressions      BIGINT NOT NULL DEFAULT 0,
  clicks           BIGINT NOT NULL DEFAULT 0,
  leads            INT NOT NULL DEFAULT 0,
  qualified_leads  INT NOT NULL DEFAULT 0,
  cpl              NUMERIC(14,4),
  ql_cpl           NUMERIC(14,4),
  source           TEXT NOT NULL DEFAULT 'csv_stub',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS performance_daily_workspace_date_idx
  ON performance_daily(workspace_id, date DESC);

CREATE INDEX IF NOT EXISTS performance_daily_market_idx
  ON performance_daily(workspace_id, market_code, date DESC);

CREATE INDEX IF NOT EXISTS performance_daily_campaign_idx
  ON performance_daily(campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS performance_daily_creative_idx
  ON performance_daily(creative_id)
  WHERE creative_id IS NOT NULL;

-- Soft uniqueness for stub re-ingest (same day/market/campaign/creative/source)
CREATE UNIQUE INDEX IF NOT EXISTS performance_daily_stub_uniq
  ON performance_daily (
    workspace_id,
    date,
    market_code,
    COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(creative_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source
  );
