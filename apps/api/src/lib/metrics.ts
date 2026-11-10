import client from 'prom-client';
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
export const httpDuration = new client.Histogram({
  name: 'globi_http_request_duration_seconds', help: 'Kohëzgjatja e kërkesave HTTP',
  labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.3, 1, 3], registers: [registry],
});
export const wsConnections = new client.Gauge({ name: 'globi_ws_connections', help: 'Lidhje WebSocket aktive', registers: [registry] });
export const syncOps = new client.Counter({ name: 'globi_sync_ops_total', help: 'Veprime sinkronizimi', labelNames: ['type', 'result'], registers: [registry] });
export const fiscalQueue = new client.Gauge({ name: 'globi_fiscal_pending', help: 'Dokumente fiskale në pritje', registers: [registry] });
