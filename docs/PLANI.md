# Plani i fazave

## Faza 1: Themeli cloud ✅ (ky dorëzim)

- Backend API me PostgreSQL, Redis dhe WebSocket; migrime SQL të automatizuara.
- Modeli multi-biznes: organizatë → subjekte (NIPT) → pika → terminale; role dhe ndarje e plotë e të dhënave.
- Porosi, artikuj, pagesa (cash, kartë, bankë, arkëtim nga shoferi), turne dhe arka, shpenzime, delivery, kuzhina, inventar me alarme minimumi.
- Sinkronizim offline idempotent, pa dyfishim porosish dhe pagesash.
- Paneli i pronarit (web, punon në telefon) me të dhëna live dhe miratime me 2FA.
- Docker Compose, Nginx me HTTPS, backup ditor i enkriptuar jashtë serverit me test javor rikthimi, Prometheus/Grafana, skript sigurimi i serverit, skript përditësimi.
- 18 teste integrimi me PostgreSQL dhe Redis realë; CI në GitHub Actions.

## Faza 2: Aplikacionet e punonjësve

- Terminali POS (PWA, instalohet në tablet/PC): ekrani i shitjes, tavolinat, ndarja e faturës, outbox offline në IndexedDB, sinkronizimi automatik.
- Ekrani i kuzhinës (KDS) me statuset në kohë reale.
- Aplikacioni i shoferit: porositë e caktuara, statusi, arkëtimi.
- Paneli i administrimit: produkte, çmime, punonjës, terminale, pragje miratimi.

## Faza 3: Printerët

- Kupon klienti dhe fletë kuzhine/bari në printera termikë ESC/POS (rrjet LAN ose USB), me një "print bridge" të vogël lokal për çdo pikë.
- Testim me printerat realë në vend.

## Faza 4: Fiskalizimi

Shih [FISKALIZIMI.md](FISKALIZIMI.md). Integrimi CIS, testim në mjedisin TEST të DPT-së, fatura offline dhe korrigjuese.

## Faza 5: ERP dhe raporte

- Magazina: furnizime, furnitorë, receta (ingredientë për çdo produkt), humbje, transferime mes pikave.
- Raporte ditore/mujore (Z-report, TVSH, shitje, fitim) në PDF/Excel, të ruajtura në object storage.

## Faza 6: Vënia në prodhim

Deployment në serverin real, domain dhe HTTPS, test ngarkese me shumë terminale, pilot në një pikë, pastaj në të gjitha.

---

## Kushtet për përdorim operacional

| Kërkesa | Gjendja |
|---|---|
| Database migrations | ✅ Gati, automatike në çdo nisje, me bllokim kundër ekzekutimit të dyfishtë |
| Autentikim dhe autorizime | ✅ Gati dhe testuar (PIN, fjalëkalim, 2FA, role për biznes/pikë) |
| Shumë përdorues njëkohësisht | ✅ Testuar lokalisht (50 porosi paralele, pagesa paralele, sinkronizim paralel). ⏳ Test ngarkese në serverin real |
| Backup dhe restore | ✅ Skriptet gati, zinxhiri dump → enkriptim → rikthim u provua lokalisht. ⏳ Provë me bucket-in real |
| Monitorim dhe logim | ✅ Konfiguruar. ⏳ Aktivizim në server |
| Procedurë përditësimi pa humbje | ✅ `scripts/deploy.sh` + mbyllje e butë + offline në terminale |
| Dokumentim i instalimit | ✅ [INSTALIMI.md](INSTALIMI.md) |
| Deployment në server real | ⏳ Kërkon serverin tuaj |
| Domain dhe HTTPS funksional | ⏳ Kërkon domain-in dhe DNS |
| Testim aksesi nga interneti | ⏳ Pas deployment |
| Integrim dhe testim printerësh | ⏳ Faza 3, kërkon printerat |
| Verifikim i fiskalizimit | ⏳ Faza 4, kërkon certifikatat. **Pa këtë sistemi nuk përdoret me klientë.** |

## Çfarë duhet nga pronari

1. **Repo GitHub** bosh (p.sh. `globi-pos`) ku të ruhet kodi.
2. **Serveri cloud** (Ubuntu 24.04, 4 vCPU / 8 GB) dhe akses SSH me çelës, ose kredenciale te provider-i.
3. **Domain-i** (p.sh. `pos.globi.al`) dhe akses te DNS-i për rekordin `A`.
4. **Bucket object storage** te një provider tjetër për backup-et (access key + secret).
5. **Të dhënat e subjekteve**: emri ligjor, NIPT-i, statusi TVSH për Piceri GLOBI dhe Bar Café GLOBI; pikat dhe adresat.
6. **Fiskalizimi**: certifikatat `.p12`, kodet e njësive të biznesit, kodet TCR, kodi i softuerit/mirëmbajtësit.
7. **Printerët**: modelet (p.sh. Epson TM-T20, Xprinter) dhe si lidhen (LAN/USB).
8. **Menuja dhe çmimet** aktuale, punonjësit dhe rolet e tyre.
