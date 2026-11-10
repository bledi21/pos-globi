import { redis } from '../redis.js';
import type { Role } from '../auth/access.js';

export const EVENTS_CHANNEL = 'globi:events';

export interface RealtimeEvent {
  type: string;                // p.sh. order.created, payment.created, alert.created
  orgId: string;
  businessId: string;
  branchId?: string | null;
  roles?: Role[];              // nëse vendoset, vetëm këto role e marrin
  data: unknown;
  at?: string;
}

/** Ngjarjet mblidhen gjatë transaksionit dhe publikohen vetëm pas COMMIT. */
export class Outbox {
  events: RealtimeEvent[] = [];
  push(e: RealtimeEvent) { this.events.push({ ...e, at: new Date().toISOString() }); }
  async flush() {
    const evs = this.events.splice(0);
    for (const e of evs) await redis.publish(EVENTS_CHANNEL, JSON.stringify(e));
  }
}
