# NEXUS Phase 0

**English** | [Hebrew](#hebrew)
Multi-agent campaign orchestration scaffold.
Phase 0 is schema + seed + dry-run CLI only.
**brief -> blackboard -> human gate**, with **no spend**.
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

`.env` defaults match compose file. Keep NEXUS_ALLOW_SPEND=false.

## CLI examples

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

## Smoke test

```bash
npm run smoke
```

## Push to GitHub

Target: https://github.com/Menachem138/nexus

```bash
cd nexus-phase0
git init
git add .
git commit -m NEXUS-Phase-0-scaffold
git branch -M main
git remote add origin https://github.com/Menachem138/nexus.git
git push -u origin main
```

Do not commit .env. Cloud Agents/Pro not required.
Market code GP = Guadeloupe (not Grand Public).

## What is included

- Schema: workspaces, agents, markets, blackboards, campaigns, tasks, events, audit, creatives, insights
- Seed: core+frh workspaces, directors, dual-run specialists (frh-grok:...), markets GP/MQ/GF/RE/CORSE
- CLI: campaign create/list, dry-run

---

<a id="hebrew"></a>
## עברית / Hebrew

**NEXUS פאזה 0** — scaffold. dry-run only: brief -> blackboard -> human gate, no spend.
Cloud Agents / Cursor Pro not required.

### Setup

```bash
cp .env.example .env
docker compose up -d
npm i
npm run migrate
npm run seed
```

### Push

git init && git add . && git commit && git remote add origin https://github.com/Menachem138/nexus.git && git push -u origin main

Keep NEXUS_ALLOW_SPEND=false. Do not push .env. GP = Guadeloupe.
