import type { Context } from 'hono';
import * as cheerio from 'cheerio';
import * as magnetUri from 'magnet-uri';
import { Requester } from '../requester/requester';
import { decodeAdLink } from '../utils/decoder';
import { AudioMap } from '../schema';
import type { IndexedTorrent } from '../schema';
import { getEnvOrDefault } from '../utils';
import { getLeechsAndSeeds } from '../scrape';
import { RedisCache } from '../cache/redis';
import { MagnetMetadataClient } from '../magnet/metadata-client';
import { SearchIndexer } from '../search/meilisearch';
import * as pp from './post-processors';

const BLUDV_URL = getEnvOrDefault('INDEXER_BLUDV_URL', 'https://bludv-v1.xyz/');
const SEARCH_URL = '?s=';
const PAGE_PATTERN = 'page/%s';

export const bludvIndexer = async (
    c: Context, 
    requester: Requester, 
    redisCache: RedisCache,
    magnetClient: MagnetMetadataClient,
    searchIndexer: SearchIndexer
) => {
    const q = c.req.query('q') || '';
    const page = c.req.query('page') || '';
    const limit = c.req.query('limit');
    const sortBy = c.req.query('sortBy');
    const sortDirection = c.req.query('sortDirection');
    const audio = c.req.query('audio');
    const year = c.req.query('year');
    const imdb = c.req.query('imdb');
    
    let url = BLUDV_URL;
    if (page) {
        url = `${BLUDV_URL}page/${page}`;
    } else {
        url = `${BLUDV_URL}${SEARCH_URL}${encodeURIComponent(q)}`;
    }

    console.log(`Processing indexer request: ${url}`);
    
    try {
        const html = await requester.getDocument(url);
        if (!html) {
            console.error('Failed to fetch document');
            return c.json({ error: 'Failed to fetch document' }, 500);
        }

        const $ = cheerio.load(html);
        const links: string[] = [];
        
        $('.post').each((_, el) => {
            const link = $(el).find('div.title > a').attr('href');
            if (link) links.push(link);
        });
        console.log(`Found ${links.length} links`);

        let indexedTorrents: IndexedTorrent[] = [];

        // Determine if we need to fetch peers during initial scrape
        const shouldFetchPeers = sortBy === 'seed_count' || sortBy === 'seeders' || sortBy === 'leech_count' || sortBy === 'leechers';

        // Parallel processing of links
        await Promise.all(links.map(async (link) => {
            try {
                const torrents = await getTorrentsBluDV(requester, redisCache, link, url, shouldFetchPeers);
                indexedTorrents.push(...torrents);
            } catch (e) {
                console.error(`Failed to process link ${link}`, e);
            }
        }));

        // Post-processing
        console.log(`[DEBUG] Finished processing links. Found ${indexedTorrents.length} torrents. Starting post-processing.`);
        indexedTorrents = pp.cleanupTitleWebsites(indexedTorrents);
        indexedTorrents = pp.appendAudioTags(indexedTorrents);
        indexedTorrents = pp.fallbackPostTitle(true, indexedTorrents); // Assuming enabled=true for now
        indexedTorrents = pp.addSimilarityCheck(q, indexedTorrents);
        indexedTorrents = pp.filterBy(audio, year, imdb, indexedTorrents);
        indexedTorrents = pp.applySorting(sortBy, sortDirection, q, indexedTorrents);
        indexedTorrents = pp.applyLimit(limit, indexedTorrents);
        
        // Enrich with peers if not already fetched
        if (!shouldFetchPeers) {
             const BATCH_SIZE = 30;
             const results: IndexedTorrent[] = [];
             for (let i = 0; i < indexedTorrents.length; i += BATCH_SIZE) {
                const batch = indexedTorrents.slice(i, i + BATCH_SIZE);
                const batchResults = await Promise.all(batch.map(async (t) => {
                    const [leech, seed] = await getLeechsAndSeeds(redisCache, t.info_hash, t.trackers);
                    return { ...t, leech_count: leech, seed_count: seed };
                }));
                results.push(...batchResults);
             }
             indexedTorrents = results;
        }

        indexedTorrents = await pp.fullfilMissingMetadata(magnetClient, indexedTorrents);
        
        pp.sendToSearchIndexer(searchIndexer, indexedTorrents);

        return c.json({
            results: indexedTorrents,
            count: indexedTorrents.length,
            indexed_count: indexedTorrents.length
        });
    } catch (e: any) {
        console.error('Error in bludvIndexer', e);
        return c.json({ error: e.message }, 500);
    }
};

async function getTorrentsBluDV(requester: Requester, redisCache: RedisCache, link: string, referer: string, fetchPeers: boolean): Promise<IndexedTorrent[]> {
    const html = await requester.getDocument(link, referer);
    if (!html) return [];

    const $ = cheerio.load(html);
    const article = $('.post');
    const title = article.find('.title > h1').text().replace(' - Download', '');
    let year = "";
    const textContent = article.find('div.content');
    
    // Date extraction (simplified)
    const datePublished = $('meta[property="article:published_time"]').attr('content') || new Date().toISOString();

    const magnetLinks: string[] = [];
    
    // Direct magnets
    textContent.find('a[href^="magnet"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) magnetLinks.push(href);
    });

    // Adware links
    const adwareDomains = [
        "https://www.seuvideo.xyz",
        "https://www.systemads.org",
    ];

    for (const domain of adwareDomains) {
        textContent.find(`a[href^="${domain}"]`).each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
                try {
                    const urlObj = new URL(href);
                    const id = urlObj.searchParams.get('id');
                    if (id) {
                        const decoded = decodeAdLink(id);
                        if (decoded.startsWith('magnet:')) {
                            magnetLinks.push(decoded);
                        }
                    }
                } catch (e) {
                    console.error('Failed to parse/decode ad link', href, e);
                }
            }
        });
    }

    const audio: string[] = [];
    let size: string[] = [];

    article.find('div.content p').each((_, el) => {
        const text = $(el).text();
        
        if (text.includes('Ano de Lançamento:')) {
             const match = text.match(/Ano de Lançamento:\s*(\d{4})/);
             if (match && match[1]) year = match[1];
        }

        // Simple audio detection
        for (const key in AudioMap) {
            if (text.includes(key)) {
                const tag = AudioMap[key];
                if (tag) audio.push(tag);
            }
        }
    });
    
    const results: IndexedTorrent[] = [];
    
    for (const magnetLink of magnetLinks) {
        try {
            const parsed = magnetUri.decode(magnetLink);
            const dn = parsed.dn;
            const releaseTitle = (Array.isArray(dn) ? dn[0] : dn) || title; 
            const infoHash = parsed.infoHash || '';
            const trackers = parsed.tr ? (Array.isArray(parsed.tr) ? parsed.tr : [parsed.tr]) : [];

            let leech = 0;
            let seed = 0;

            if (fetchPeers) {
                [leech, seed] = await getLeechsAndSeeds(redisCache, infoHash, trackers);
            }
            
            results.push({
                title: releaseTitle,
                original_title: title,
                details: link,
                year: year,
                imdb: '',
                audio: [...new Set(audio)], // unique
                magnet_link: magnetLink,
                date: datePublished,
                info_hash: infoHash,
                trackers: trackers,
                size: '', 
                leech_count: leech,
                seed_count: seed,
                similarity: 0
            });
        } catch (e) {
            console.error('Failed to decode magnet link', magnetLink, e);
        }
    }

    return results;
}
