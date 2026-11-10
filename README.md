# GLOBI POS Enterprise

Sistem POS dhe ERP 100% cloud për grupin GLOBI (Piceri GLOBI, Bar Café GLOBI dhe pika të tjera në të ardhmen).

| Pjesa | Teknologjia | Vendndodhja |
|---|---|---|
| Backend API | Node.js 22, TypeScript, Fastify | `apps/api` |
| Databaza qendrore | PostgreSQL 16 (migrime SQL) | `apps/api/migrations` |
| Kohë reale, cache, queue | Redis 7 + WebSocket | `apps/api/src/realtime` |
| Paneli i pronarit | Faqe web (punon në telefon) | `apps/owner-web` |
| Deployment | Docker Compose, Nginx, Let's Encrypt | `docker-compose.yml`, `infra/` |
| Backup | pg_dump i enkriptuar → object storage S3 | `infra/backup` |
| Monitorimi | Prometheus, Grafana, node-exporter | `infra/monitoring` |

Dokumentimi:

- [docs/PLANI.md](docs/PLANI.md): fazat, çfarë është gati dhe çfarë duhet nga pronari
- [docs/ARKITEKTURA.md](docs/ARKITEKTURA.md): modeli multi-biznes, sinkronizimi offline, siguria
- [docs/INSTALIMI.md](docs/INSTALIMI.md): instalimi në server, HTTPS, backup, përditësime
- [docs/FISKALIZIMI.md](docs/FISKALIZIMI.md): çfarë kërkohet për fiskalizimin

## Nisja lokale (zhvillim)

```bash
docker compose -f docker-compose.dev.yml up -d     # PostgreSQL + Redis
cd apps/api
npm install
npm run migrate
npm run seed        # të dhëna demo: 2 subjekte, punonjës, terminale, produkte
OWNER_WEB_DIR=../owner-web npm run dev
```

Hapni http://localhost:3000 për panelin e pronarit (`pronari@globi.local` / `Ndrysho-Kete-2026!`).

## Testet

```bash
cd apps/api
npm test            # kërkon PostgreSQL + Redis lokal; përdor databazën globi_test
```

Testet mbulojnë: hyrjen me PIN dhe bllokimin pas 5 tentativave, rrotullimin e token-ave, rrjedhën e plotë
porosi → pagesë → fiskalizim → stok → mbyllje turni, 50 porosi njëkohësisht, pagesa paralele që s'e kalojnë totalin,
sinkronizim offline i përsëritur paralelisht pa dyfishime, ndarjen e bizneseve, miratimet me 2FA, njoftimet live
me WebSocket dhe pandryshueshmërinë e auditimit.
