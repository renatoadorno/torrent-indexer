import type { IndexedTorrent } from '../schema';

interface IndexStats {
    numberOfDocuments: number;
    isIndexing: boolean;
    fieldDistribution: Record<string, number>;
}

interface SearchResponse {
    hits: IndexedTorrent[];
}

export class SearchIndexer {
    private baseURL: string;
    private apiKey: string;
    private indexName: string;

    constructor(baseURL: string, apiKey: string, indexName: string) {
        this.baseURL = baseURL;
        this.apiKey = apiKey;
        this.indexName = indexName;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        return headers;
    }

    public async indexTorrents(torrents: IndexedTorrent[]): Promise<void> {
        const url = `${this.baseURL}/indexes/${this.indexName}/documents`;
        
        const documents = torrents.map(t => ({
            id: t.info_hash,
            ...t
        }));

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify(documents),
            });

            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Failed to index documents: ${response.status} ${body}`);
            }
        } catch (e) {
            console.error('Failed to index torrents in Meilisearch', e);
        }
    }

    public async searchTorrent(query: string, limit: number = 10): Promise<IndexedTorrent[]> {
        const url = `${this.baseURL}/indexes/${this.indexName}/search`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    q: query,
                    limit: Math.min(limit, 100),
                }),
            });

            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Search failed: ${response.status} ${body}`);
            }

            const result = await response.json() as SearchResponse;
            return result.hits;

        } catch (e) {
            console.error('Failed to search torrents in Meilisearch', e);
            return [];
        }
    }

    public async getStats(): Promise<IndexStats | null> {
        const url = `${this.baseURL}/indexes/${this.indexName}/stats`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: this.getHeaders(),
            });

            if (!response.ok) {
                return null;
            }

            return await response.json() as IndexStats;
        } catch (e) {
            console.error('Failed to get Meilisearch stats', e);
            return null;
        }
    }

    public async isHealthy(): Promise<boolean> {
        const url = `${this.baseURL}/health`;
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: this.getHeaders(),
            }); // Default timeout usually applies
            return response.ok;
        } catch (e) {
            return false;
        }
    }
}
