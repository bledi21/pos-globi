#!/usr/bin/env bash
# Cron brenda kontejnerit: backup ditor + test rikthimi çdo të diel.
set -euo pipefail
env | grep -E '^(PG|S3_|BACKUP_|HEALTHCHECK_URL|TZ)' | sed 's/^/export /; s/=\(.*\)$/="\1"/' > /etc/backup.env
cat > /etc/crontabs/root <<CRON
${BACKUP_CRON:-15 3 * * *} . /etc/backup.env && /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1
${RESTORE_TEST_CRON:-0 5 * * 0} . /etc/backup.env && /usr/local/bin/restore-test.sh >> /proc/1/fd/1 2>&1
CRON
echo "backup: cron aktiv (${BACKUP_CRON:-15 3 * * *}), test rikthimi (${RESTORE_TEST_CRON:-0 5 * * 0})"
exec crond -f -l 8
