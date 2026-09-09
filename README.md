# NEXUS Phase 0+1

**English** | [Hebrew](#hebrew)

Multi-agent campaign orchestration scaffold.

- **Phase 0**: schema + seed + dry-run CLI — **brief -> blackboard -> human gate**, with **no spend**.
- **Phase 1 (Week 1)**: Model Router (Cheap First ladder) + agent invoke + handoff validator + Context Engine v0.

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
- Phase 1 tables: `model_invocations`, `agent_handoffs`
- Seed: core+frh workspaces, directors (managers-astra6), dual-run specialists (cheap-first), markets GP/MQ/GF/RE/CORSE
- CLI: campaign create/list, dry-run, router explain, agent invoke, handoff validate

---

<a id="hebrew"></a>
## עברית / Hebrew

**NEXUS פאזה 0+1** — scaffold + model router. dry-run: brief -> blackboard -> human gate, no spend.
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

Keep `NEXUS_ALLOW_SPEND=false`. Do not push `.env`. GP = Guadeloupe.
