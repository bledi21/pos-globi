export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Nuk jeni i identifikuar') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Nuk keni të drejtë për këtë veprim') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Regjistrimi') => new AppError(404, 'not_found', `${what} nuk u gjet`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
