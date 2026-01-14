import type { Context } from 'hono';
import { SearchIndexer } from '../search/meilisearch';

export const searchHandler = async (c: Context, searchIndexer: SearchIndexer) => {
    const q = c.req.query('q') || new Date().toISOString().split('T')[0];
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr) : 10;

    if (limit <= 0) {
        return c.json({ error: 'Invalid limit parameter' }, 400);
    }

    const results = await searchIndexer.searchTorrent(q, limit);
    
    return c.json({
        results: results,
        count: results.length
    });
};

export const searchHealthHandler = async (c: Context, searchIndexer: SearchIndexer) => {
    const isHealthy = await searchIndexer.isHealthy();
    const response: any = {
        service: 'meilisearch',
        timestamp: new Date().toISOString(),
    };

    if (isHealthy) {
        const stats = await searchIndexer.getStats();
        if (stats) {
            response.status = 'healthy';
            response.details = {
                documents: stats.numberOfDocuments,
                indexing: stats.isIndexing
            };
            return c.json(response, 200);
        } else {
            response.status = 'degraded';
            response.details = { error: 'Could not retrieve stats' };
            return c.json(response, 200);
        }
    } else {
        response.status = 'unhealthy';
        return c.json(response, 503);
    }
};

export const searchStatsHandler = async (c: Context, searchIndexer: SearchIndexer) => {
    const stats = await searchIndexer.getStats();
    if (!stats) {
        const isHealthy = await searchIndexer.isHealthy();
        if (!isHealthy) {
            return c.json({ error: 'Meilisearch service is unavailable' }, 503);
        }
        return c.json({ error: 'Failed to retrieve statistics' }, 500);
    }

    return c.json({
        status: 'healthy',
        service: 'meilisearch',
        numberOfDocuments: stats.numberOfDocuments,
        isIndexing: stats.isIndexing,
        fieldDistribution: stats.fieldDistribution
    });
};
