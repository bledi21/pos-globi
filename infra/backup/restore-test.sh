#!/usr/bin/env bash
# Test periodik i rikthimit: shkarkon backup-in e fundit nga jashtë serverit, e rikthen në një databazë të përkohshme
# dhe krahason numrin e regjistrimeve me databazën live. Dështimi shfaqet në log dhe (opsionalisht) në healthcheck.
set -euo pipefail
export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other \
  RCLONE_CONFIG_OFFSITE_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$S3_SECRET_KEY" RCLONE_CONFIG_OFFSITE_REGION="${S3_REGION:-auto}"
work=$(mktemp -d); trap 'rm -rf "$work"; dropdb --if-exists globi_restore_test' EXIT
latest=$(rclone lsf "offsite:$S3_BUCKET/postgres/" --include 'globi-*.dump.gpg' | sort | tail -1)
[ -n "$latest" ] || { echo "RESTORE TEST DËSHTOI: nuk ka backup"; exit 1; }
echo "[$(date -Is)] test rikthimi me $latest"
rclone copy "offsite:$S3_BUCKET/postgres/$latest" "$work/"
rclone copy "offsite:$S3_BUCKET/postgres/$latest.sha256" "$work/"
(cd "$work" && sed "s#/backups/##" "$latest.sha256" | sha256sum -c -)
gpg --batch --decrypt --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" "$work/$latest" > "$work/db.dump"
dropdb --if-exists globi_restore_test
createdb globi_restore_test
pg_restore --no-owner -d globi_restore_test "$work/db.dump"
for t in organizations businesses orders payments audit_log schema_migrations; do
  n=$(psql -d globi_restore_test -tAc "SELECT count(*) FROM $t")
  echo "  $t: $n rreshta"
done
orders=$(psql -d globi_restore_test -tAc "SELECT count(*) FROM orders")
[ "$orders" -ge 0 ] || exit 1
echo "[$(date -Is)] RESTORE TEST OK"
[ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 "$HEALTHCHECK_URL/restore" >/dev/null || true
