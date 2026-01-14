import { RedisCache } from '../cache/redis';
import { getAdditionalTrackers } from './trackers';
import { UdpTracker } from './udp-tracker';

interface Peers {
    seed: number;
    leech: number;
}

const PEERS_CACHE_EXPIRATION = 24 * 60 * 60; // 24 hours

export async function getLeechsAndSeeds(
    redisCache: RedisCache,
    infoHash: string,
    trackers: string[]
): Promise<[number, number]> {
    // Check cache first
    const cached = await redisCache.get(infoHash);
    if (cached) {
        try {
            const peers = JSON.parse(cached) as Peers;
            return [peers.leech, peers.seed];
        } catch (e) {
            console.error('Failed to parse cached peers', e);
        }
    }

    const additionalTrackers = await getAdditionalTrackers(redisCache);
    const allTrackers = Array.from(new Set([...trackers, ...additionalTrackers]));

    // Limit concurrent scrapes to avoid overwhelming resources? 
    // The Go implementation fires all at once. We'll do the same but maybe limit to UDP trackers only.
    
    const udpTrackers = allTrackers.filter(t => t.startsWith('udp://'));

    const scrapePromises = udpTrackers.map(async (trackerUrl) => {
        try {
            const scraper = new UdpTracker(trackerUrl);
            scraper.setTimeout(1500); // 1.5s timeout per tracker
            const results = await scraper.scrape([infoHash]);
            const firstResult = results[0];
            if (firstResult) {
                return {
                    seed: firstResult.seeders,
                    leech: firstResult.leechers
                };
            }
        } catch (e) {
            // Ignore errors
        }
        return null;
    });

    // We want the first successful non-zero result, or at least some result.
    // We can't easily use Promise.race for "first non-null", so we'll wrap it.
    
    // Actually, let's just wait for all (with timeout) or use a custom race.
    // Go implementation uses a channel and returns on first non-zero response.

    return new Promise<[number, number]>((resolve) => {
        let completed = 0;
        let hasFallback = false;
        let fallbackPeers: Peers = { seed: 0, leech: 0 };
        const total = scrapePromises.length;
        
        if (total === 0) {
            resolve([0, 0]);
            return;
        }

        let resolved = false;

        scrapePromises.forEach(p => {
            p.then(peers => {
                if (resolved) return;
                
                if (peers) {
                    if (peers.seed > 0) {
                        resolved = true;
                        // Cache and return
                        redisCache.set(infoHash, JSON.stringify(peers), PEERS_CACHE_EXPIRATION).catch(console.error);
                        resolve([peers.leech, peers.seed]);
                        return;
                    } else if (peers.leech > 0) {
                        if (!hasFallback) {
                            hasFallback = true;
                            fallbackPeers = peers;
                        }
                    }
                }
            }).finally(() => {
                if (resolved) return;
                completed++;
                if (completed === total) {
                    if (hasFallback) {
                        redisCache.set(infoHash, JSON.stringify(fallbackPeers), PEERS_CACHE_EXPIRATION).catch(console.error);
                        resolve([fallbackPeers.leech, fallbackPeers.seed]);
                    } else {
                        resolve([0, 0]);
                    }
                }
            });
        });

        // Global timeout
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                 if (hasFallback) {
                    redisCache.set(infoHash, JSON.stringify(fallbackPeers), PEERS_CACHE_EXPIRATION).catch(console.error);
                    resolve([fallbackPeers.leech, fallbackPeers.seed]);
                } else {
                    resolve([0, 0]);
                }
            }
        }, 5000); // 5s global timeout
    });
}
