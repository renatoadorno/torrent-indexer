import { redisCache } from '../cache/redis';
import { FlareSolverr } from './flaresolverr';
import { SPOOFED_USER_AGENT, isValidHTML } from '../utils';

const CACHE_KEY = 'shortLivedCache';
const CHALLENGE_REGEX = /(just a moment|cf-chl-bypass|under attack)/i;

export class Requester {
  private fs: FlareSolverr;
  private shortLivedCacheExpiration: number = 30 * 60; // 30 minutes

  constructor(fs: FlareSolverr) {
    this.fs = fs;
  }

  async getDocument(url: string, referer?: string): Promise<string | null> {
    const key = `${CACHE_KEY}:${url}`;
    
    // Try cache
    const cached = await redisCache.get(key);
    if (cached) {
      console.log('Returning from short-lived cache', url);
      return cached;
    }

    // Try plain request
    try {
      const headers: Record<string, string> = {
        'User-Agent': SPOOFED_USER_AGENT,
        'Referer': referer || 'https://google.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      };

      const res = await fetch(url, { headers });
      const text = await res.text();

      if (CHALLENGE_REGEX.test(text)) {
        throw new Error('Challenge detected');
      }

      if (isValidHTML(text)) {
        await redisCache.set(key, text, this.shortLivedCacheExpiration);
        return text;
      }
    } catch (e) {
      console.log('Plain request failed or challenge detected, using FlareSolverr', url);
    }

    // Try FlareSolverr
    console.log('Using FlareSolverr for', url);
    const fsBody = await this.fs.get(url);
    if (fsBody) {
        console.log('FlareSolverr returned body length:', fsBody.length);
        if (isValidHTML(fsBody) && !CHALLENGE_REGEX.test(fsBody)) {
            await redisCache.set(key, fsBody, this.shortLivedCacheExpiration);
            return fsBody;
        } else {
            console.log('FlareSolverr returned invalid HTML or challenge');
        }
    } else {
        console.log('FlareSolverr returned null');
    }

    return null;
  }
}
