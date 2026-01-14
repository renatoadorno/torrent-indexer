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

const REDE_TORRENT_URL = getEnvOrDefault('INDEXER_REDE_TORRENT_URL', 'https://redetorrent.com/');
const SEARCH_URL = 'index.php?s=';

export const redeTorrentIndexer = async (
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
    
    let url = REDE_TORRENT_URL;
    if (q) {
        url = `${REDE_TORRENT_URL}${SEARCH_URL}${encodeURIComponent(q)}`;
    } else if (page) {
        // Pagination pattern: base_url + page_number
        // e.g. https://redetorrent.com/2
        // Ensure trailing slash on base URL if needed, but usually it has it.
        // If REDE_TORRENT_URL ends with /, we just append page.
        url = `${REDE_TORRENT_URL}${page}`;
    }

    console.log(`Processing indexer request: ${url}`);
    
    const html = await requester.getDocument(url);
    if (!html) {
        return c.json({ error: 'Failed to fetch document' }, 500);
    }

    const $ = cheerio.load(html);
    const links: string[] = [];
    
    $('.capa_lista').each((_, el) => {
        const link = $(el).find('a').attr('href');
        if (link) links.push(link);
    });

    let indexedTorrents: IndexedTorrent[] = [];

    // Parallel processing of links
    await Promise.all(links.map(async (link) => {
        try {
            const torrents = await getTorrentsRedeTorrent(requester, redisCache, link, url);
            indexedTorrents.push(...torrents);
        } catch (e) {
            console.error(`Failed to process link ${link}`, e);
        }
    }));

    // Post-processing
    indexedTorrents = pp.cleanupTitleWebsites(indexedTorrents);
    indexedTorrents = pp.appendAudioTags(indexedTorrents);
    indexedTorrents = await pp.fullfilMissingMetadata(magnetClient, indexedTorrents);
    indexedTorrents = pp.fallbackPostTitle(true, indexedTorrents);
    indexedTorrents = pp.addSimilarityCheck(q, indexedTorrents);
    indexedTorrents = pp.filterBy(audio, year, imdb, indexedTorrents);
    indexedTorrents = pp.applySorting(sortBy, sortDirection, q, indexedTorrents);
    indexedTorrents = pp.applyLimit(limit, indexedTorrents);
    
    pp.sendToSearchIndexer(searchIndexer, indexedTorrents);

    return c.json({
        results: indexedTorrents,
        count: indexedTorrents.length,
        indexed_count: indexedTorrents.length
    });
};

async function getTorrentsRedeTorrent(requester: Requester, redisCache: RedisCache, link: string, referer: string): Promise<IndexedTorrent[]> {
    const html = await requester.getDocument(link, referer);
    if (!html) return [];

    const $ = cheerio.load(html);
    const article = $('.conteudo');
    
    const h1Text = article.find('h1').text();
    // Regex: ^(.*?)(?: - (.*?))? \((\d{4})\)
    const titleMatch = h1Text.match(/^(.*?)(?: - (.*?))? \((\d{4})\)/);
    
    let title = h1Text;
    let year = "";
    
    if (titleMatch && titleMatch.length >= 4) {
        title = titleMatch[1]!.trim();
        year = titleMatch[3]!.trim();
    }

    const textContent = article.find('.apenas_itemprop');
    
    // Date extraction
    const datePublished = $('meta[property="article:published_time"]').attr('content') || new Date().toISOString();

    const magnetLinks: string[] = [];
    textContent.find('a[href^="magnet"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) magnetLinks.push(href);
    });

    const audio: string[] = [];
    const sizes: string[] = [];
    let imdbLink = "";

    // Parse info block: div#informacoes > p
    article.find('div#informacoes > p').each((_, el) => {
        // The content is separated by <br>. Cheerio .text() might merge them.
        // We can get .html() and split by <br>
        const htmlContent = $(el).html() || '';
        const lines = htmlContent.split(/<br\s*\/?>/i);
        
        lines.forEach(line => {
            // Strip HTML tags
            const text = line.replace(/<[^>]*>/g, '').trim();
            
            if (text.includes('Lançamento:')) {
                 const match = text.match(/Lançamento:\s*(\d{4})/);
                 if (match && match[1]) year = match[1];
            }

            if (text.includes('Tamanho:')) {
                const match = text.match(/Tamanho:\s*(.*)/);
                if (match && match[1]) {
                    // Sometimes size is split by | or just one
                    const parts = match[1].split('|');
                    parts.forEach(p => sizes.push(p.trim()));
                }
            }

            // Audio detection
            for (const key in AudioMap) {
                if (text.includes(key)) {
                    const tag = AudioMap[key];
                    if (tag) audio.push(tag);
                }
            }
        });
    });

    // Find IMDB link
    article.find('a').each((_, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('imdb.com/title/') || href.includes('imdb.to/title/'))) {
            imdbLink = href;
        }
    });

    const results: IndexedTorrent[] = [];
    
    for (let i = 0; i < magnetLinks.length; i++) {
        const magnetLink = magnetLinks[i];
        try {
            const parsed = magnetUri.decode(magnetLink);
            const dn = parsed.dn;
            const releaseTitle = (Array.isArray(dn) ? dn[0] : dn) || title; 
            const infoHash = parsed.infoHash || '';
            const trackers = parsed.tr ? (Array.isArray(parsed.tr) ? parsed.tr : [parsed.tr]) : [];

            // Get peers
            const [leech, seed] = await getLeechsAndSeeds(redisCache, infoHash, trackers as string[]);
            
            // Assign size if counts match
            let mySize = "";
            if (sizes.length === magnetLinks.length) {
                mySize = sizes[i];
            }

            results.push({
                title: releaseTitle as string,
                original_title: title,
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
