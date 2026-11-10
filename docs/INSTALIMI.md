# Instalimi në server

## 0. Çfarë duhet paraprakisht

| Nevoja | Rekomandim |
|---|---|
| Server cloud | Ubuntu 24.04 LTS, 4 vCPU, 8 GB RAM, 80 GB SSD (p.sh. Hetzner CPX31, DigitalOcean, AWS Lightsail). Rajon në Evropë (Frankfurt/Helsinki/Vjenë). |
| Domain | p.sh. `pos.globi.al`: rekord DNS `A` që tregon IP-në e serverit |
| Object storage për backup | Bucket S3-compatible te një provider ose rajon **tjetër** nga serveri (Backblaze B2, Hetzner Object Storage, AWS S3) |
| Email për Let's Encrypt | për njoftimet e certifikatës |

## 1. Sigurimi i serverit

```bash
# si root, pasi të keni krijuar përdoruesin admin dhe të keni vendosur çelësin SSH:
adduser globi && usermod -aG sudo globi
mkdir -p /home/globi/.ssh && cp ~/.ssh/authorized_keys /home/globi/.ssh/ && chown -R globi: /home/globi/.ssh
git clone <repo> /opt/globi && cd /opt/globi
sudo ./scripts/harden-server.sh globi
```

Skripti ndez firewall-in (vetëm 22, 80, 443), çaktivizon hyrjen me fjalëkalim dhe root, ndez fail2ban dhe
përditësimet automatike të sigurisë, dhe instalon Docker.

## 2. Konfigurimi

```bash
cd /opt/globi
cp .env.example .env
for k in POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET BACKUP_ENCRYPTION_PASSPHRASE; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 48 | tr -d '/+=')|" .env
done
nano .env     # DOMAIN, LETSENCRYPT_EMAIL, S3_*
chmod 600 .env
```

**Ruajeni `BACKUP_ENCRYPTION_PASSPHRASE` edhe jashtë serverit** (p.sh. në një menaxher fjalëkalimesh). Pa të, backup-et nuk hapen.

## 3. Nisja

```bash
docker compose build
docker compose up -d postgres redis api backup
./scripts/init-letsencrypt.sh          # merr certifikatën HTTPS dhe nis Nginx
docker compose up -d                    # certbot për rinovim automatik
docker compose --profile monitoring up -d   # opsionale: Prometheus + Grafana në https://DOMAIN/grafana/
```

Migrimet e databazës ekzekutohen automatikisht sa herë niset API.

## 4. Konfigurimi fillestar i të dhënave

Në server, krijoni pronarin dhe subjektet:

```bash
docker compose exec api node -e "
const { pool } = await import('./dist/db.js'); const { hashSecret } = await import('./dist/auth/crypto.js');
const org = (await pool.query(\"INSERT INTO organizations(name) VALUES ('GLOBI') RETURNING id\")).rows[0].id;
const u = (await pool.query('INSERT INTO users(org_id,full_name,email,password_hash) VALUES (\$1,\$2,\$3,\$4) RETURNING id',
  [org, 'EMRI I PRONARIT', 'EMAIL', await hashSecret('FJALEKALIM-I-FORTE')])).rows[0].id;
await pool.query(\"INSERT INTO user_roles(user_id, role) VALUES (\$1,'owner')\", [u]); await pool.end();" --input-type=module
```

Pastaj nga API (me token-in e pronarit): `POST /api/v1/businesses` për çdo subjekt (NIPT), `POST /api/v1/businesses/:id/branches`,
`POST /api/v1/branches/:id/devices` (ruani `deviceToken` në terminal), `POST /api/v1/users` për punonjësit me PIN,
`POST /api/v1/businesses/:id/products`. Menjëherë pas hyrjes së parë aktivizoni 2FA: `POST /api/v1/auth/totp/setup` dhe `/enable`.

## 5. Verifikimi

```bash
curl -fsS https://$DOMAIN/ready                         # {"ok":true,"db":"ok","redis":"ok"}
curl -sI http://$DOMAIN | grep -i location               # ridrejtim në https
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/metrics   # 404 (i bllokuar nga interneti)
docker compose ps                                        # të gjitha "healthy"/"running"
```

## 6. Backup dhe rikthimi

- Backup ditor në 03:15 (ora e Tiranës): `pg_dump` → enkriptim AES-256 → object storage. Kopjet lokale mbahen 7 ditë, ato jashtë serverit 30 ditë.
- Test automatik i rikthimit çdo të diel në 05:00: shkarkon backup-in e fundit, verifikon checksum-in, e rikthen në një databazë të përkohshme dhe numëron rreshtat.
- Manualisht:

```bash
docker compose exec backup backup.sh          # backup tani
docker compose exec backup restore-test.sh    # provë rikthimi tani
docker compose logs backup --tail 50
```

- Rikthim real pas një incidenti:

```bash
docker compose stop api
docker compose exec backup restore.sh globi-YYYYMMDD-HHMMSS.dump.gpg
docker compose start api
```

Vendosni `BACKUP_HEALTHCHECK_URL` (healthchecks.io ose Uptime Kuma) që të njoftoheni nëse një backup nuk ndodh.

## 7. Përditësime pa humbje të dhënash

```bash
./scripts/deploy.sh
```

Bën backup, ndërton imazhin e ri, ekzekuton migrimet dhe ndërron kontejnerin me mbyllje të butë (30 s).
Terminalet POS vazhdojnë offline gjatë ndërrimit dhe sinkronizojnë vetë pas rikthimit. Rregullat për migrimet:
vetëm shtim kolonash/tabelash në një version; heqja e kolonave bëhet në versionin pasardhës, pasi kodi i vjetër s'është më në punë.

## 8. Monitorimi dhe logimi

- `/health` dhe `/ready` për monitorim të jashtëm (Uptime Kuma, UptimeRobot): kontrollojeni `https://DOMAIN/ready` çdo minutë.
- Prometheus mbledh metrikat e API-së (kohëzgjatja e kërkesave, lidhjet WebSocket, veprimet e sinkronizimit, radha fiskale) dhe të serverit.
  Alarmet në `infra/monitoring/alerts.yml`: API poshtë, gabime > 2%, fatura të pafiskalizuara > 30 min, disk < 15%.
- Logjet janë JSON (`docker compose logs api`), me rrotullim 5 × 20 MB për shërbim. Fjalëkalimet, PIN-et dhe token-at fshihen nga logjet.
