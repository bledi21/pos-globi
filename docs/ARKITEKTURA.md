# Arkitektura

```
 Terminalet POS / Kuzhina / Magazina / Delivery           Pronari (telefon/kompjuter)
        │  HTTPS + WebSocket (wss)                                 │
        ▼                                                          ▼
 ┌──────────────────────────── Nginx (TLS, rate limit, firewall) ─────────────────┐
 │                                                                                │
 │   API (Fastify, 1..N instanca)  ◄──── Redis pub/sub ────►  WebSocket hub       │
 │        │                                   │                                   │
 │        ▼                                   ▼                                   │
 │   PostgreSQL 16 (databaza qendrore)    Redis (cache, rate-limit, lock, queue)  │
 │        │                                                                       │
 │        └── backup ditor i enkriptuar ──► Object storage S3 (jashtë serverit)   │
 └────────────────────────────────────────────────────────────────────────────────┘
```

## 1. Modeli multi-biznes

```
organizations (grupi GLOBI)
 └── businesses (subjekt ligjor: NIPT, TVSH, konfigurim fiskal, pragje miratimi)
      └── branches (pikë shitjeje: kodi i njësisë së biznesit)
           └── devices (terminal: POS, kuzhinë, bar, magazinë, delivery; kodi TCR)
```

- Çdo regjistrim kontabël (porosi, pagesë, shpenzim, stok, dokument fiskal, turn) ka `business_id`. Raportet e grupit
  (`/dashboard/consolidated`) japin **një rresht për çdo subjekt** dhe nuk i bashkojnë regjistrimet.
- Produktet, kategoritë dhe çmimet janë për biznes; inventari është për pikë.
- Rolet: `owner`, `admin`, `manager`, `cashier`, `waiter`, `kitchen`, `warehouse`, `driver`. Një rol jepet në nivel
  organizate, biznesi ose pike. Kontrolli bëhet në çdo kërkesë (`requireScope`): biznesi duhet t'i përkasë
  organizatës së përdoruesit dhe përdoruesi duhet të ketë rolin në atë biznes/pikë. Testet verifikojnë që
  punonjësi i barit nuk sheh dhe nuk prek asgjë të picerisë.

## 2. Sinkronizimi në kohë reale

- Çdo ndryshim (porosi, pagesë, anulim, turn, shpenzim, alarm, miratim, artikuj kuzhine) publikohet si ngjarje pas
  COMMIT në kanalin Redis `globi:events`. Çdo instancë e API-së ua shpërndan ngjarjet klientëve WebSocket të saj
  që kanë të drejtë t'i shohin (filtrim sipas organizatës, biznesit, pikës dhe rolit).
- Lidhja: `wss://DOMAIN/api/v1/ws?token=<access token>`. Mesazhet: `{type, businessId, branchId, data, at}`.

## 3. Puna offline dhe parandalimi i dyfishimeve

Terminali gjeneron vetë UUID për çdo porosi, artikull, pagesë, turn dhe shpenzim. Kur s'ka internet, veprimet
ruhen në një outbox lokal dhe dërgohen me `POST /api/v1/sync/push` kur lidhja rikthehet:

```json
{ "ops": [
  { "opId": "uuid", "type": "order.create",   "clientTs": "...", "payload": { "id": "uuid", "branchId": "...", "items": [...] } },
  { "opId": "uuid", "type": "payment.create", "payload": { "id": "uuid", "orderId": "...", "method": "cash", "amount": 800 } }
]}
```

Përgjigja jep për çdo veprim `applied`, `duplicate` (u pa më parë, kthehet i njëjti rezultat) ose `rejected` (me arsye).

Garancitë, secila e testuar:

1. `op_id` rezervohet brenda transaksionit (`sync_ops`, PRIMARY KEY). I njëjti batch i dërguar 5 herë paralelisht aplikohet një herë.
2. Porosia dhe pagesa kanë si PRIMARY KEY UUID-në e klientit. Edhe me `op_id` të ndryshëm, pagesa ruhet një herë.
3. Pagesat bllokojnë porosinë (`SELECT … FOR UPDATE`) dhe refuzojnë çdo shumë mbi detyrimin e mbetur. 10 pagesa
   paralele mbi një porosi 600 L pranohen vetëm 3 × 200 L.
4. Numrat e porosive jepen nga serveri për pikë dhe ditë (`branch_counters`), pa përplasje edhe me 50 porosi njëkohësisht.
5. Nëse katalogu lokal kishte çmim të vjetër, respektohet çmimi që pa klienti dhe krijohet alarm për pronarin.

Veprimet e lejuara offline: hapje/mbyllje turni, porosi, shtim artikujsh, pagesa, shpenzime, dorëzim parash nga shoferi.
Nuk lejohen offline (kërkojnë server): anulimi i porosive të paguara, zbritjet mbi pragun, ndryshimet e çmimeve.

Terminali tërheq katalogun me `GET /api/v1/sync/pull?since=<serverTime>` dhe e ruan lokalisht.

## 4. Paneli i pronarit dhe miratimet

`GET /api/v1/dashboard/business/:id` jep: xhiron, porositë e paguara/të hapura/të anuluara, shitjet sipas punonjësve,
pagesat sipas mënyrës, delivery, arkëtimet dhe detyrimet e shoferëve, gjendjen e çdo arke të hapur, shpenzimet,
koston e mallit, fitimin e përllogaritur, inventarin nën minimum, alarmet dhe miratimet në pritje.

Operacionet kritike (anulimi i porosisë së paguar, zbritja mbi `approvalRules.discountPercentMax`) krijojnë një
kërkesë miratimi. Pronari e miraton nga telefoni me kodin TOTP (Google Authenticator, Authy etj.) në **çdo vendim**.
Diferencat e arkës mbi `cashDifferenceMax`, anulimet, stoku i ulët dhe delivery e dështuar krijojnë alarme live.

## 5. Siguria

- Fjalëkalimet dhe PIN-et me bcrypt. PIN-i bllokohet 15 min pas 5 tentativave. Hyrja e pronarit me 2FA.
- Access token 15 minuta, refresh token me rrotullim; ripërdorimi i një refresh token-i anulon të gjitha sesionet.
- Terminalet identifikohen me token pajisjeje (ruhet vetëm hash-i) dhe mund të çaktivizohen menjëherë.
- Rate limiting në Nginx dhe në API (Redis). Helmet, HSTS, CORS i kufizuar, `/metrics` i bllokuar nga interneti.
- `audit_log` është vetëm-shtim (trigger në databazë që ndalon UPDATE/DELETE).
- Vetëm portat 80/443 janë të hapura; PostgreSQL dhe Redis nuk ekspozohen. SSH vetëm me çelës (`scripts/harden-server.sh`).
