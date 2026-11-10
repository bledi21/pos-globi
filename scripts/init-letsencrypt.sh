#!/usr/bin/env bash
# Merr certifikatën e parë HTTPS nga Let's Encrypt.
# Kërkesa: DNS-i i DOMAIN duhet të tregojë IP-në e serverit dhe portat 80/443 të jenë të hapura.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${DOMAIN:?}" "${LETSENCRYPT_EMAIL:?vendos LETSENCRYPT_EMAIL në .env}"

echo ">> Certifikatë e përkohshme që Nginx të niset"
docker compose run --rm --entrypoint sh certbot -c "
  mkdir -p /etc/letsencrypt/live/$DOMAIN &&
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
    -out /etc/letsencrypt/live/$DOMAIN/fullchain.pem -subj /CN=localhost"
docker compose up -d nginx

echo ">> Fshihet certifikata e përkohshme dhe kërkohet e vërteta"
docker compose run --rm --entrypoint sh certbot -c "
  rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"
docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email --non-interactive

docker compose exec nginx nginx -s reload
echo ">> HTTPS gati: https://$DOMAIN"
