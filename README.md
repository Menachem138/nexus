# NEXUS Phase 0+1 (Week 4: Harden + Phase 1 exit)

**English** | [Hebrew](#hebrew)

Multi-agent campaign orchestration scaffold.

- **Phase 0**: schema + seed + dry-run CLI — **brief -> blackboard -> human gate**, with **no spend**.
- **Phase 1 (Week 1)**: Model Router (Cheap First ladder) + agent invoke + handoff validator + Context Engine v0.
- **Phase 1 (Week 2)**: Campaign status state machine + tasks + council cases + creative human gate.
- **Phase 1 (Week 3)**: FRH E2E dry-run on GF (dual-run) + CSV → `performance_daily` + learnings with decay.
- **Phase 1 (Week 4)**: Workspace isolation + audit completeness + Hebrew digest + absorb/retire plan + Phase 1 acceptance checklist.

Cloud Agents / Cursor Pro are **not required**.

## Prerequisites

- docker (Postgres 16 via `docker compose`)
- Node.js **20+**
- npm

## Setup

```bash
cp .env.example .env
docker compose up -d
npm i
npm run migrate
npm run seed
```

`.env` defaults match compose file. Keep `NEXUS_ALLOW_SPEND=false`.
Default model mode is stub: `NEXUS_MODEL_MODE=stub` (no external API calls).

## CLI examples (Phase 0)

```bash
npm run nexus -- dry-run
npm run nexus -- campaign create --workspace frh --slug demo-gf --title Demo-GF
npm run nexus -- campaign list --workspace frh
```

### Dry-run path (no spend)

1. **brief** - campaigns.brief JSON
2. **blackboard** - empty blackboard linked to campaign
3. **human gate** - campaigns.human_gate = pending

Phase 0 never calls paid APIs.

## Phase 1 — Model Router

Cheap First escalation ladder:

`qwen-local` → `glm` → `specialist` → `astra` → `council` (flag)

Managers (`kind` cmo/director, policy `managers-astra6`) **start at `astra`** (skip cheap ladder) unless overridden.

### Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXUS_MODEL_MODE` | `stub` | `stub` = deterministic fake completions; `live` = real providers (keys required) |
| `OPENCODEX_API_KEY` | — | Astra / council live placeholder |
| `GLM_API_KEY` | — | GLM live placeholder |
| `SPECIALIST_API_KEY` | — | Specialist live placeholder |
| `QWEN_LOCAL_URL` | — | Local qwen endpoint |

Never commit real secrets. Live adapters throw clearly if keys are missing or not yet wired.

### CLI examples (Phase 1)

```bash
# Explain ladder decision (no invoke)
npm run nexus -- router explain --workspace frh --agent global-cmo

# Invoke via stub ladder (writes model_invocations)
npm run nexus -- agent invoke --workspace frh --slug strategy --prompt "Why CPL rose?"
npm run nexus -- agent invoke --workspace frh --slug strategy --prompt "test" --campaign demo-gf --max-escalations 3

# Validate structured handoff
npm run nexus -- handoff validate --json '{"finding":"x","evidence":"y","source":"z","confidence":0.8,"recommendation":"r","risks":"k","unknowns":"u","question_for_next_agent":"q?"}'
echo '{"finding":"..."}' | npm run nexus -- handoff validate --file -
```

### Handoff required keys

`finding`, `evidence`, `source`, `confidence`, `recommendation`, `risks`, `unknowns`, `question_for_next_agent`

### Context Engine v0

When `--campaign` is set, invoke loads campaign.brief + last-N `blackboard_entries` and compresses them into prompt context.


## Phase 1 Week 2 — Campaign loop

Status machine (enforced in code + `campaign_status_history`):

`draft` → `research` → `strategy` → `creative` → `review` → `approved` → `live` → `learned`

Also: `live` ↔ `paused`; kill from most states → `killed`. Keep `NEXUS_ALLOW_SPEND=false` (no live Meta).

### CLI examples (Week 2)

```bash
npm run nexus -- campaign transition --workspace frh --slug demo-gf --to research --reason "start loop"
npm run nexus -- campaign status --workspace frh --slug demo-gf

npm run nexus -- task assign --workspace frh --campaign demo-gf --agent strategy --title "Diagnose CPL"
npm run nexus -- task list --workspace frh --campaign demo-gf

npm run nexus -- council open --workspace frh --campaign demo-gf --topic "CPL spike" --slug cpl-spike-1
npm run nexus -- council position --workspace frh --case cpl-spike-1 --agent performance --stance "fatigue" --body '{"note":"creative fatigue"}'
npm run nexus -- council decide --workspace frh --case cpl-spike-1 --verdict '{"cause":"fatigue","confidence":0.78}'

npm run nexus -- creative approve --workspace frh --slug <creative>
npm run nexus -- creative kill --workspace frh --slug GF-tomber-typo-poster-v1 --reason "sterile stock"
```

Tables added in `migrations/003_phase1_campaign_loop.sql`: `campaign_status_history`, `council_positions`, `creative_gate_actions` (+ campaigns.status check).



## Phase 1 Week 3 — FRH E2E dry-run

Goals (no paid spend):

1. Run FRH workflow on **GF** via stub agents
2. Dual-run: seed specialists (`stratege-creative`, `art-director`) vs NEXUS directors (`strategy`, `creative`) on the same brief
3. Ingest performance via CSV stub → `performance_daily`
4. Write learnings into `insights` with epistemic + decay fields

Tables added in `migrations/004_phase1_e2e.sql`: `performance_daily`.

Sample CSV: `fixtures/performance_stub_gf.csv`.

### CLI examples (Week 3)

```bash
npm run nexus -- frh dry-run --workspace frh --market GF --slug e2e-gf-1
npm run nexus -- performance ingest --workspace frh --file fixtures/performance_stub_gf.csv
npm run nexus -- learnings from-performance --workspace frh --market GF
```

### Menager isolate (local .env only)

Committed `docker-compose.yml` keeps host port **5432**. On the Menager Mac isolate (`/Users/menachem/nexus-frh-menager`) override locally — do **not** commit port changes:

```bash
# local .env (not committed)
DATABASE_URL=postgres://nexus:nexus@localhost:5433/nexus
```

```bash
cd /Users/menachem/nexus-frh-menager
git pull
npm install
npm run migrate
npm run nexus -- frh dry-run --workspace frh --market GF --slug e2e-gf-1
```



## Phase 1 Week 4 — Harden + Phase 1 exit

Goals:

1. **Isolation** — FRH tenant rows never return under a `core` workspace filter
2. **Audit completeness** — recent campaign transitions / creative gates / council decides have matching `audit_log` rows
3. **Hebrew daily digest** — prototype chairman digest (HE + EN) from yesterday/today activity
4. **Absorb plan** — mark seed agents `dual_run`; schedule retire dates
5. **Phase 1 acceptance** — read-only checklist against PRD §9

Tables added in `migrations/005_phase1_harden.sql`: `agent_absorb_plan`, `digest_runs`.

### CLI examples (Week 4)

```bash
npm run nexus -- harden isolation --workspace frh
npm run nexus -- harden audit --workspace frh --days 7
npm run nexus -- digest daily --workspace frh
npm run nexus -- digest daily --workspace frh --date 2026-09-15
npm run nexus -- absorb status --workspace frh
npm run nexus -- absorb schedule-retire --workspace frh --slug art-director --after 2026-10-15
npm run nexus -- phase1 checklist --workspace frh
```

### Phase 1 exit note

When `phase1 checklist` is green (all PRD §9 signals + router/campaign/e2e tables), Phase 1 MVP Core Brain is ready to exit. Keep `NEXUS_ALLOW_SPEND=false` until Phase 3 spend gates. Dual-run seed agents remain until their `retire_after` date; directors stay on `managers-astra6`.

### Menager isolate (Week 4)

```bash
cd /Users/menachem/nexus-frh-menager
git pull
npm install
npm run migrate
npm run nexus -- harden isolation --workspace frh
npm run nexus -- harden audit --workspace frh
npm run nexus -- digest daily --workspace frh
npm run nexus -- absorb status --workspace frh
npm run nexus -- phase1 checklist --workspace frh
```

Local `.env` may keep port **5433**; committed compose stays **5432**.

## Smoke / tests

```bash
npm run smoke
npm test
npm run typecheck
```

## Push to GitHub

Target: https://github.com/Menachem138/nexus

Do not commit `.env`. Cloud Agents/Pro not required.
Market code **GP** = Guadeloupe (not Grand Public).

## What is included

- Schema: workspaces, agents, markets, blackboards, campaigns, tasks, events, audit, creatives, insights
- Phase 1 tables: `model_invocations`, `agent_handoffs`, `campaign_status_history`, `council_positions`, `creative_gate_actions`, `performance_daily`, `agent_absorb_plan`, `digest_runs`
- Seed: core+frh workspaces, directors (managers-astra6), dual-run specialists (cheap-first), markets GP/MQ/GF/RE/CORSE
- CLI: campaign create/list/transition/status, task assign/list, council open/position/decide, creative approve/kill, dry-run, router explain, agent invoke, handoff validate, frh dry-run, performance ingest, learnings from-performance, harden isolation/audit, digest daily, absorb status/schedule-retire, phase1 checklist

---

<a id="hebrew"></a>
## עברית / Hebrew

**NEXUS פאזה 0+1** — scaffold + model router + campaign loop. dry-run: brief -> blackboard -> human gate, no spend.
Router stub by default (`NEXUS_MODEL_MODE=stub`). Cloud Agents / Cursor Pro not required.

### Setup

```bash
cp .env.example .env
docker compose up -d
npm i
npm run migrate
npm run seed
```

### Phase 1 demo

```bash
npm run nexus -- router explain --workspace frh --agent global-cmo
npm run nexus -- agent invoke --workspace frh --slug strategy --prompt "test"
```


### Phase 1 Week 2 demo

```bash
npm run nexus -- campaign transition --workspace frh --slug demo-gf --to research --reason "start loop"
npm run nexus -- campaign status --workspace frh --slug demo-gf
npm run nexus -- council open --workspace frh --campaign demo-gf --topic "CPL spike" --slug cpl-spike-1
```

### Phase 1 Week 3 demo

```bash
npm run nexus -- frh dry-run --workspace frh --market GF --slug e2e-gf-1
npm run nexus -- performance ingest --workspace frh --file fixtures/performance_stub_gf.csv
npm run nexus -- learnings from-performance --workspace frh --market GF
```


### Phase 1 Week 4 demo

```bash
npm run nexus -- harden isolation --workspace frh
npm run nexus -- digest daily --workspace frh
npm run nexus -- phase1 checklist --workspace frh
```

Keep `NEXUS_ALLOW_SPEND=false`. Do not push `.env`. GP = Guadeloupe. Menager isolate may use port **5433** via local `.env` only (repo compose stays 5432).
