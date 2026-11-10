#!/usr/bin/env bash
# Rikthim REAL (shkatërron të dhënat aktuale). Përdorim:
#   docker compose stop api
#   docker compose exec backup restore.sh globi-YYYYMMDD-HHMMSS.dump.gpg
#   docker compose start api
set -euo pipefail
name="${1:?jepni emrin e skedarit të backup-it}"
export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other \
  RCLONE_CONFIG_OFFSITE_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$S3_SECRET_KEY" RCLONE_CONFIG_OFFSITE_REGION="${S3_REGION:-auto}"
read -r -p "Kjo do të ZËVENDËSOJË databazën '$PGDATABASE'. Shkruani PO për të vazhduar: " ok
[ "$ok" = "PO" ] || exit 1
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
[ -f "/backups/$name" ] && cp "/backups/$name" "$work/" || rclone copy "offsite:$S3_BUCKET/postgres/$name" "$work/"
gpg --batch --decrypt --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" "$work/$name" > "$work/db.dump"
pg_restore --clean --if-exists --no-owner -d "$PGDATABASE" "$work/db.dump"
echo "Rikthimi përfundoi."
