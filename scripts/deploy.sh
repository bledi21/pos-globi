#!/usr/bin/env bash
# Përditësim pa humbje të dhënash:
# 1) backup para çdo përditësimi, 2) ndërtim i imazhit të ri, 3) migrimet ekzekutohen nga kontejneri i ri para nisjes,
# 4) kontejneri i vjetër mbyllet butësisht (SIGTERM, 30s) — terminalet POS vazhdojnë offline dhe sinkronizojnë pas rikthimit.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
echo ">> Backup para përditësimit"
docker compose exec -T backup /usr/local/bin/backup.sh
echo ">> Ndërtimi"
docker compose build api
echo ">> Nisja e versionit të ri"
docker compose up -d --no-deps api
for i in $(seq 1 30); do
  if docker compose exec -T api curl -fsS http://localhost:3000/ready >/dev/null 2>&1; then echo ">> API gati"; break; fi
  sleep 2
done
docker compose up -d nginx
docker image prune -f >/dev/null
echo ">> Përditësimi përfundoi"
