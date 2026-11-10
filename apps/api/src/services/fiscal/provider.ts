// Fiskalizimi (Shqipëri, sistemi CIS i DPT-së).
// Rrjedha: (1) gjenerohet IIC lokalisht duke nënshkruar me çelësin privat të certifikatës së biznesit,
// (2) fatura dërgohet si XML e nënshkruar te shërbimi SOAP i tatimeve, (3) kthehet FIC.
// Kur s'ka internet, fatura lëshohet me IIC dhe dërgohet më vonë brenda afatit ligjor (rasti "subsequent delivery").
//
// KUJDES: implementimi real kërkon certifikatën .p12 të lëshuar nga AKSHI/DPT për NIPT-in, kodet TCR,
// kodin e njësisë së biznesit, kodin e softuerit dhe kodin e mirëmbajtësit. Këto duhen nga pronari.
// Deri atëherë përdoret MockFiscalProvider (vetëm për zhvillim/testim — NUK është fiskalizim i vlefshëm).
import { createHash, randomUUID } from 'node:crypto';

export interface FiscalInvoice {
  orderId: string; nipt: string; businessUnitCode: string | null; tcrCode: string | null;
  issuedAt: string; invoiceNumber: string; total: string; vatTotal: string; offline: boolean;
  items: { name: string; qty: string; unitPrice: string; vatRate: string; lineTotal: string }[];
}
export interface FiscalResult { iic: string; fic: string; requestXml?: string; responseXml?: string }

export interface FiscalProvider {
  readonly name: string;
  fiscalize(inv: FiscalInvoice): Promise<FiscalResult>;
}

export class MockFiscalProvider implements FiscalProvider {
  readonly name = 'mock';
  async fiscalize(inv: FiscalInvoice): Promise<FiscalResult> {
    const iic = createHash('md5').update(`${inv.nipt}|${inv.issuedAt}|${inv.invoiceNumber}|${inv.total}`).digest('hex').toUpperCase();
    return { iic, fic: `MOCK-${randomUUID()}` };
  }
}

export class AlbaniaCisProvider implements FiscalProvider {
  readonly name = 'cis';
  constructor(private opts: { endpoint: string; p12Path: string; p12Password: string; softCode: string; maintainerCode: string }) {}
  async fiscalize(_inv: FiscalInvoice): Promise<FiscalResult> {
    // TODO(faza 4): IIC = MD5(RSA-SHA256(NIPT|dateTime|invoiceNumber|businessUnit|TCR|softCode|totalPrice)),
    // ndërtimi i RegisterInvoiceRequest XML, nënshkrimi XMLDSig dhe dërgimi SOAP. Testohet në mjedisin test të DPT-së.
    throw new Error(`Fiskalizimi CIS nuk është konfiguruar ende (${this.opts.endpoint})`);
  }
}
