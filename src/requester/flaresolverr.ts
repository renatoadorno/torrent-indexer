import { isValidHTML } from '../utils';

interface FlareSolverrResponse {
  status: string;
  message: string;
  solution: {
    url: string;
    status: number;
    cookies: {
      domain: string;
      expiry: number;
      httpOnly: boolean;
      name: string;
      path: string;
      sameSite: string;
      secure: boolean;
      value: string;
    }[];
    userAgent: string;
    headers: Record<string, string>;
    response: string;
  };
}

export class FlareSolverr {
  private url: string;
  private maxTimeout: number;
  private sessionPool: string[] = [];
  private poolSize = 5;
  private initiated = false;

  constructor(url: string, timeoutMilli: number) {
    this.url = url;
    this.maxTimeout = timeoutMilli;
    this.fillSessionPool().then(() => {
      this.initiated = true;
    }).catch(console.error);
  }

  async fillSessionPool() {
    if (this.sessionPool.length >= this.poolSize) return;

    try {
      const sessions = await this.listSessions();
      for (const session of sessions) {
        if (this.sessionPool.length < this.poolSize) {
          this.sessionPool.push(session);
        }
      }
    } catch (e) {
      console.error('Failed to list sessions', e);
    }

    while (this.sessionPool.length < this.poolSize) {
      const session = await this.createSession();
      if (session) {
        this.sessionPool.push(session);
      } else {
        break; // Stop if creation fails
      }
    }
  }

  async createSession(): Promise<string | null> {
    try {
      const res = await fetch(`${this.url}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'sessions.create' }),
      });
      const data = await res.json() as any;
      if (data.session) {
        return data.session;
      }
    } catch (e) {
      console.error('Failed to create session', e);
    }
    return null;
  }

  async listSessions(): Promise<string[]> {
    try {
      const res = await fetch(`${this.url}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'sessions.list' }),
      });
      const data = await res.json() as any;
      return data.sessions || [];
    } catch (e) {
      return [];
    }
  }

  async get(url: string, attempts = 3): Promise<string | null> {
    if (!this.initiated && this.sessionPool.length === 0) {
        // Try to fill pool if not initiated
        await this.fillSessionPool();
        if (this.sessionPool.length === 0) return null;
    }

    const session = this.sessionPool.shift();
    if (!session) return null;

    try {
      const res = await fetch(`${this.url}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url: url,
          maxTimeout: this.maxTimeout,
          session: session,
        }),
      });

      const data = await res.json() as FlareSolverrResponse;
      
      this.sessionPool.push(session); // Return session to pool

      if (data.status !== 'ok') {
        if (attempts > 0) {
            return this.get(url, attempts - 1);
        }
        throw new Error(data.message || 'FlareSolverr error');
      }

      if (data.solution.response.includes('Under attack')) {
        throw new Error('Under attack');
      }

      if (!isValidHTML(data.solution.response)) {
         console.warn('Invalid HTML from FlareSolverr');
      }

      return data.solution.response;

    } catch (e) {
      this.sessionPool.push(session); // Return session even on error
      console.error('FlareSolverr request failed', e);
      return null;
    }
  }
}
