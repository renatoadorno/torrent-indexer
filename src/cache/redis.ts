import Redis from 'ioredis';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 7; // 7 days in seconds

export class RedisCache {
  private client: Redis;
  private defaultExpiration: number;

  constructor() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPassword = process.env.REDIS_PASSWORD;

    this.client = new Redis({
      host: redisHost,
      port: 6379,
      password: redisPassword,
    });
    this.defaultExpiration = DEFAULT_EXPIRATION;
  }

  setDefaultExpiration(expiration: number) {
    this.defaultExpiration = expiration;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, expiration?: number): Promise<void> {
    const exp = expiration || this.defaultExpiration;
    await this.client.set(key, value, 'EX', exp);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

export const redisCache = new RedisCache();
