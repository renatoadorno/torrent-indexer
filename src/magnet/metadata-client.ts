import { RedisCache } from '../cache/redis';
import * as magnetUri from 'magnet-uri';

interface MetadataRequest {
    magnet_uri: string;
}

interface TorrentFile {
    path: string;
    size: number;
    offset: number;
}

interface MetadataResponse {
    info_hash: string;
    name: string;
    size: number;
    files: TorrentFile[];
    created_by: string;
    created_at: string;
    comment: string;
    trackers: string[];
    download_url: string;
}

export class MagnetMetadataClient {
    private baseURL: string;
    private redisCache: RedisCache;
    private enabled: boolean;

    constructor(baseURL: string, redisCache: RedisCache) {
        this.baseURL = baseURL;
        this.redisCache = redisCache;
        this.enabled = !!baseURL;
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public async fetchMetadata(magnetLink: string): Promise<MetadataResponse | null> {
        if (!this.enabled) {
            return null;
        }

        try {
            const parsed = magnetUri.decode(magnetLink);
            const infoHash = parsed.infoHash;
            if (!infoHash) {
                throw new Error('Invalid magnet link: missing infoHash');
            }

            const cacheKey = `metadata:${infoHash}`;
            const cached = await this.redisCache.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as MetadataResponse;
            }

            console.log(`Fetching metadata for ${infoHash} from ${this.baseURL}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout

            const response = await fetch(`${this.baseURL}/api/v1/metadata`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ magnet_uri: magnetLink }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`API responded with status: ${response.status}`);
            }

            const metadata = await response.json() as MetadataResponse;

            // Cache for 7 days
            await this.redisCache.set(cacheKey, JSON.stringify(metadata), 7 * 24 * 60 * 60);

            return metadata;

        } catch (e) {
            console.error('Failed to fetch magnet metadata', e);
            return null;
        }
    }
}
