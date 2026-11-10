// Llogaritjet bëhen në qindarka (integer) për të shmangur gabimet e presjes dhjetore.
export const toCents = (v: string | number): number => Math.round(Number(v) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);
/** TVSH e përfshirë në një çmim bruto. */
export const vatFromGross = (grossCents: number, rate: number): number => Math.round((grossCents * rate) / (100 + rate));
