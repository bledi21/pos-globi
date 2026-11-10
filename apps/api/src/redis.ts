import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
// Lidhje e veçantë për subscribe (një lidhje në modalitet subscribe nuk mund të bëjë komanda të tjera).
export const redisSub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
