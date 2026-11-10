#!/usr/bin/env bash
# Backup i plotë i PostgreSQL: pg_dump (format custom) -> enkriptim GPG (AES256) -> object storage jashtë serverit.
set -euo pipefail
export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other \
  RCLONE_CONFIG_OFFSITE_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$S3_SECRET_KEY" RCLONE_CONFIG_OFFSITE_REGION="${S3_REGION:-auto}"
ts=$(date +%Y%m%d-%H%M%S)
file="/backups/globi-$ts.dump.gpg"
echo "[$(date -Is)] backup fillon: $file"
pg_dump -Fc --no-owner | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" -o "$file"
sha256sum "$file" > "$file.sha256"
rclone copy "$file" "offsite:$S3_BUCKET/postgres/" --s3-no-check-bucket
rclone copy "$file.sha256" "offsite:$S3_BUCKET/postgres/" --s3-no-check-bucket
# Kopjet lokale mbahen 7 ditë, ato jashtë serverit sipas BACKUP_RETENTION_DAYS
find /backups -name 'globi-*.dump.gpg*' -mtime +7 -delete
rclone delete "offsite:$S3_BUCKET/postgres/" --min-age "${BACKUP_RETENTION_DAYS:-30}d" --s3-no-check-bucket
size=$(du -h "$file" | cut -f1)
echo "[$(date -Is)] backup OK ($size)"
[ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
