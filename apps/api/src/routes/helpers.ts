import type { FastifyRequest } from 'fastify';
import { tx } from '../db.js';
import { Outbox } from '../realtime/events.js';
import type { Ctx } from '../services/orders.js';

/** Ekzekuton një veprim në transaksion dhe publikon ngjarjet live vetëm pasi ruhet. */
export async function run<T>(req: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const out = new Outbox();
  const r = await tx((c) => fn({ c, p: req.principal, out, ip: req.ip }));
  await out.flush();
  return r;
}
