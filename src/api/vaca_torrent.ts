import type { Context } from 'hono';
import * as cheerio from 'cheerio';
import * as magnetUri from 'magnet-uri';
import { Requester } from '../requester/requester';
import { RedisCache } from '../cache/redis';
import { MagnetMetadataClient } from '../magnet/metadata-client';
import { SearchIndexer } from '../search/meilisearch';
import { getEnvOrDefault } from '../utils';
import { getLeechsAndSeeds } from '../scrape';
import { AudioMap } from '../schema';
import type { IndexedTorrent } from '../schema';
import * as pp from './post-processors';
import { SoraLinkFetcher } from '../utils/sora-link-fetcher';

const VACA_TORRENT_URL = getEnvOrDefault('INDEXER_VACA_TORRENT_URL', 'https://vacatorrentmov.com/');
const SEARCH_URL = 'wp-admin/admin-ajax.php';

export const vacaTorrentIndexer = async (
    c: Context, 
    requester: Requester, 
    redisCache: RedisCache,
    magnetClient: MagnetMetadataClient,
    searchIndexer: SearchIndexer
) => {
    const q = c.req.query('q') || '';
    const page = c.req.query('page') || '1';
    const limit = c.req.query('limit');
    const sortBy = c.req.query('sortBy');
    const sortDirection = c.req.query('sortDirection');
    const audio = c.req.query('audio');
    const year = c.req.query('year');
    const imdb = c.req.query('imdb');
    
    let html = '';
    let url = VACA_TORRENT_URL;

    if (q) {
        // Perform POST request to WordPress AJAX endpoint
        const targetURL = `${VACA_TORRENT_URL}${SEARCH_URL}`;
        console.log(`Processing indexer search request: ${targetURL} query=${q}`);
        
        try {
            const formData = new URLSearchParams();
            formData.append('action', 'filtrar_busca');
            formData.append('s', q);
            formData.append('tipo', 'todos');
            formData.append('paged', page);

            const response = await fetch(targetURL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
                    'Origin': 'https://vacatorrentmov.com',
                    'Referer': `https://vacatorrentmov.com/?s=${encodeURIComponent(q)}&lang=en-US`
                },
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Search failed with status ${response.status}`);
            }

            const json = await response.json() as any;
            if (json && json.html) {
                html = json.html;
            } else {
                console.warn('VacaTorrent search returned no HTML');
                return c.json({ results: [], count: 0, indexed_count: 0 });
            }
        } catch (e) {
            console.error('VacaTorrent search error', e);
            return c.json({ error: 'Search failed' }, 500);
        }
    } else {
        // Home page or pagination
        if (page !== '1') {
            url = `${VACA_TORRENT_URL}page/${page}`;
        }
        console.log(`Processing indexer request: ${url}`);
        const doc = await requester.getDocument(url);
        if (doc) html = doc;
    }

    if (!html) {
        return c.json({ error: 'Failed to fetch document' }, 500);
    }

    const $ = cheerio.load(html);
    const links: string[] = [];
    
    // Selector for home/search results
    const selector = '.i-tem_ht';
    $(selector).each((_, el) => {
        const link = $(el).find('a').attr('href');
        if (link) links.push(link);
    });

    const soraFetcher = new SoraLinkFetcher('https://vacadb.org', redisCache);
    let indexedTorrents: IndexedTorrent[] = [];

    // Determine if we need to fetch peers during initial scrape
    const shouldFetchPeers = sortBy === 'seed_count' || sortBy === 'seeders' || sortBy === 'leech_count' || sortBy === 'leechers';

    // Parallel processing of links
    await Promise.all(links.map(async (link) => {
        try {
            const torrents = await getTorrentsVacaTorrent(requester, redisCache, link, url, soraFetcher, shouldFetchPeers);
            indexedTorrents.push(...torrents);
        } catch (e) {
            console.error(`Failed to process link ${link}`, e);
        }
    }));

    // Post-processing
    indexedTorrents = pp.cleanupTitleWebsites(indexedTorrents);
    indexedTorrents = pp.appendAudioTags(indexedTorrents);
    indexedTorrents = pp.fallbackPostTitle(true, indexedTorrents);
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
};

async function getTorrentsVacaTorrent(
    requester: Requester, 
    redisCache: RedisCache, 
    link: string, 
    referer: string,
    soraFetcher: SoraLinkFetcher,
    fetchPeers: boolean
): Promise<IndexedTorrent[]> {
    const html = await requester.getDocument(link, referer);
    if (!html) return [];

    const $ = cheerio.load(html);
    
    // Extract title
    let title = $('.custom-main-title').first().text().trim();
    if (!title) {
        title = $('h1').first().text().trim();
    }
    // Remove release date from title if present (e.g. "Title (2024)")
    title = title.split('(')[0]?.trim() || title;

    // Extract metadata
    let year = "";
    let imdbLink = "";
    const audio: string[] = [];
    const sizes: string[] = [];
    let season = "";
    const datePublished = $('meta[property="article:published_time"]').attr('content') || new Date().toISOString();

    $('.col-left ul li, .content p').each((_, el) => {
        const text = $(el).text();
        const htmlContent = $(el).html() || '';

        // Extract Year
        if (!year) {
             const match = text.match(/(\d{4})/);
             if (match) year = match[1]!;
        }

        // Extract IMDB
        if (!imdbLink) {
            $(el).find('a').each((_, a) => {
                const href = $(a).attr('href');
                if (href && (href.includes('imdb.com') || href.includes('imdb.to'))) {
                    imdbLink = href;
                }
            });
        }

        // Extract Audio
        for (const key in AudioMap) {
            if (text.includes(key)) {
                const tag = AudioMap[key];
                if (tag) audio.push(tag);
            }
        }

        // Extract Season
        if (text.includes('Season:') || text.includes('Temporada:')) {
            const match = text.match(/(\d+)/);
            if (match) season = match[1]!;
        }

        // Extract Sizes
        if (text.includes('Tamanho:') || htmlContent.includes('Tamanho:')) {
             // Simple regex for size like 1.2 GB
             const sizeMatches = text.match(/\d+(?:\.\d+)?\s*(?:GB|MB)/gi);
             if (sizeMatches) {
                 sizeMatches.forEach(s => sizes.push(s));
             }
        }
    });

    const magnetLinks: string[] = [];
    
    // Direct magnets
    $('a[href^="magnet"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) magnetLinks.push(href);
    });

    // SoraLink protected links
    const soraPromises: Promise<void>[] = [];
    $('.area-links-download a').each((_, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('vacadb.org')) {
            try {
                const urlObj = new URL(href);
                const id = urlObj.searchParams.get('id');
                if (id) {
                    soraPromises.push((async () => {
                        const magnet = await soraFetcher.fetchLink(id);
                        if (magnet) magnetLinks.push(magnet);
                    })());
                }
            } catch (e) {
                // ignore invalid urls
            }
        }
    });

    await Promise.all(soraPromises);

    const results: IndexedTorrent[] = [];
    const uniqueSizes = [...new Set(sizes)];

    for (let i = 0; i < magnetLinks.length; i++) {
        const magnetLink = magnetLinks[i]!;
        try {
            const parsed = magnetUri.decode(magnetLink);
            const dn = parsed.dn;
            const releaseTitle = (Array.isArray(dn) ? dn[0] : dn) || title; 
            const infoHash = parsed.infoHash || '';
            const trackers = parsed.tr ? (Array.isArray(parsed.tr) ? parsed.tr : [parsed.tr]) : [];

            let leech = 0;
            let seed = 0;

            if (fetchPeers) {
                [leech, seed] = await getLeechsAndSeeds(redisCache, infoHash, trackers as string[]);
            }
            
            // Assign size if counts match
            let mySize = "";
            if (uniqueSizes.length === magnetLinks.length) {
                mySize = uniqueSizes[i]!;
            }

            // Process title similar to Go: processVacaTorrentTitle
            let processedTitle = title;
            processedTitle = processedTitle.replace(' – Download', '').replace(' - Download', '').trim();
            if (season) {
                processedTitle = `${processedTitle} S${season.padStart(2, '0')} - ${season}ª Temporada`;
            }
            // Append audio tags to title? The Go code does `appendAudioISO639_2Code`. 
            // Our `pp.appendAudioTags` does something similar but generic.
            // We'll rely on generic post-processor for now.

            results.push({
                title: releaseTitle as string,
                original_title: processedTitle,
                details: link,
                year: year,
                imdb: imdbLink,
                audio: [...new Set(audio)], // unique
                magnet_link: magnetLink,
                date: datePublished,
                info_hash: infoHash,
                trackers: trackers as string[],
                size: mySize, 
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
