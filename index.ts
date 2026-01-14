import { Hono } from 'hono';
import { redisCache } from './src/cache/redis';
import { FlareSolverr } from './src/requester/flaresolverr';
import { Requester } from './src/requester/requester';
import { getEnvOrDefault } from './src/utils';
import { starckFilmesIndexer } from './src/api/starck_filmes';
import { bludvIndexer } from './src/api/bludv';
import { torrentDosFilmesIndexer } from './src/api/torrent_dos_filmes';
import { redeTorrentIndexer } from './src/api/rede_torrent';
import { comandoIndexer } from './src/api/comando_torrents';
import { vacaTorrentIndexer } from './src/api/vaca_torrent';
import { MagnetMetadataClient } from './src/magnet/metadata-client';
import { SearchIndexer } from './src/search/meilisearch';
import { searchHandler, searchHealthHandler, searchStatsHandler } from './src/api/search';

const app = new Hono();

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize services
const flaresolverrUrl = getEnvOrDefault('FLARESOLVERR_ADDRESS', 'http://localhost:8191');
const flaresolverr = new FlareSolverr(flaresolverrUrl, 60000);
const requester = new Requester(flaresolverr);

const magnetMetadataClient = new MagnetMetadataClient(
    getEnvOrDefault('MAGNET_METADATA_API_URL', ''),
    redisCache
);

const searchIndexer = new SearchIndexer(
    getEnvOrDefault('MEILISEARCH_HOST', 'http://localhost:7700'),
    getEnvOrDefault('MEILISEARCH_API_KEY', ''),
    getEnvOrDefault('MEILISEARCH_INDEX', 'torrents')
);

app.get('/', (c) => {
  return c.text('Torrent Indexer (Bun Edition) is running!');
});

app.get('/health', async (c) => {
    try {
        await redisCache.set('health', 'ok', 10);
        return c.json({ status: 'ok', redis: 'connected', flaresolverr: flaresolverrUrl });
    } catch (e) {
        return c.json({ status: 'error', error: String(e) }, 500);
    }
});

// Search Routes
app.get('/search', (c) => searchHandler(c, searchIndexer));
app.get('/search/health', (c) => searchHealthHandler(c, searchIndexer));
app.get('/search/stats', (c) => searchStatsHandler(c, searchIndexer));

// Indexer Routes
app.get('/indexers/starck-filmes', (c) => starckFilmesIndexer(c, requester, magnetMetadataClient, searchIndexer));
app.get('/indexers/bludv', (c) => bludvIndexer(c, requester, redisCache, magnetMetadataClient, searchIndexer));
app.get('/indexers/torrent-dos-filmes', (c) => torrentDosFilmesIndexer(c, requester, redisCache, magnetMetadataClient, searchIndexer));
app.get('/indexers/rede-torrent', (c) => redeTorrentIndexer(c, requester, redisCache, magnetMetadataClient, searchIndexer));
app.get('/indexers/comando', (c) => comandoIndexer(c, requester, redisCache, magnetMetadataClient, searchIndexer));
app.get('/indexers/vaca-torrent', (c) => vacaTorrentIndexer(c, requester, redisCache, magnetMetadataClient, searchIndexer));

export default {
  port: 3000,
  fetch: app.fetch,
  idleTimeout: 255, // 255 seconds (max)
};