# Fiskalizimi

## Gjendja aktuale

- Çdo porosi e paguar plotësisht krijon një dokument në `fiscal_documents` me status `pending`.
- Një proces në sfond (me bllokim në Redis, që vetëm një instancë ta punojë) i dërgon te ofruesi fiskal, me riprovim
  të shtyrë (1 s, 2 s, 4 s … deri në 1 orë, maksimum 20 herë). Rezultati ruhet: IIC, FIC, XML-ja e kërkesës dhe e përgjigjes.
- Alarmi Prometheus `FiscalQueueStuck` njofton nëse mbi 20 fatura mbeten pa u fiskalizuar për 30 minuta.
- **Tani funksionon vetëm `FISCAL_MODE=mock`**, që gjeneron kode fiktive për testim. **Nuk është fiskalizim i vlefshëm ligjor.**
  Sistemi nuk duhet përdorur me klientë realë para se të përfundojë dhe të verifikohet faza e fiskalizimit.

## Çfarë duhet për fiskalizimin real (sistemi CIS i DPT-së)

Për **secilin subjekt** (Piceri GLOBI, Bar Café GLOBI):

1. Certifikata elektronike e NIPT-it (skedar `.p12` + fjalëkalimi), e pajisur nga AKSHI / portali e-Albania.
2. Kodi i njësisë së biznesit (Business Unit) për çdo pikë, i regjistruar në portalin self-care të tatimeve.
3. Kodi TCR për çdo arkë/terminal.
4. Kodi i softuerit dhe kodi i mirëmbajtësit (nga regjistrimi i softuerit fiskal te DPT).
5. Kodet e operatorëve (arkëtarëve) sipas regjistrimit.
6. Akses në mjedisin TEST të DPT-së për verifikim para kalimit në prodhim.

## Çfarë do të ndërtohet (faza 4)

- `AlbaniaCisProvider` në `apps/api/src/services/fiscal/provider.ts`: llogaritja e IIC me nënshkrim RSA-SHA256,
  ndërtimi i `RegisterInvoiceRequest`, nënshkrimi XMLDSig, dërgimi SOAP dhe ruajtja e FIC.
- Fatura offline: lëshohet me IIC lokalisht dhe dërgohet sapo të rikthehet lidhja, brenda afatit ligjor.
- Faturat korrigjuese për anulimet e porosive tashmë të fiskalizuara.
- Regjistrimi i gjendjes fillestare të arkës (cash deposit) për çdo TCR në fillim të ditës.
- Kodi QR i verifikimit në kupon.
- Testim i plotë në mjedisin TEST të DPT-së dhe verifikim i faturave në portalin e verifikimit.

Certifikatat do të ruhen jashtë databazës, në një volum të enkriptuar me leje vetëm për kontejnerin e API-së.
