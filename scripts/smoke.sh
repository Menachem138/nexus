#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
test -f .env || cp .env.example .env
docker compose up -d
for i in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U nexus -d nexus && break
  sleep 1
done
test -d node_modules || npm i
npm run migrate
npm run seed
docker compose exec -T postgres psql -U nexus -d nexus -c "SELECT count(*) AS workspaces FROM workspaces; SELECT count(*) AS agents FROM agents; SELECT count(*) AS markets FROM markets; SELECT count(*) AS creatives FROM creatives; SELECT count(*) AS insights FROM insights;"
npx tsx src/cli/index.ts campaign create --workspace frh --slug demo-gf --title Demo-GF
echo smoke-OK
