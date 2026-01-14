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

const COMANDO_URL = getEnvOrDefault('INDEXER_COMANDO_URL', 'https://comando.la/');
const SEARCH_URL = '?s=';
const PAGE_PATTERN = 'page/%s';

export const comandoIndexer = async (
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
    
    let url = COMANDO_URL;
    if (q) {
        url = `${COMANDO_URL}${SEARCH_URL}${encodeURIComponent(q)}`;
    } else if (page) {
        url = `${COMANDO_URL}${PAGE_PATTERN.replace('%s', page)}`;
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
        
        $('article').each((_, el) => {
            const link = $(el).find('h2.entry-title > a').attr('href');
            if (link) links.push(link);
        });
        console.log(`Found ${links.length} links`);

        let indexedTorrents: IndexedTorrent[] = [];

        // Parallel processing of links
        await Promise.all(links.map(async (link) => {
            try {
                const torrents = await getTorrentsComando(requester, redisCache, link, url);
                indexedTorrents.push(...torrents);
            } catch (e) {
                console.error(`Failed to process link ${link}`, e);
            }
        }));
        console.log(`Processed ${indexedTorrents.length} torrents`);


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
    } catch (e: any) {
        console.error('Error in comandoIndexer', e);
        return c.json({ error: e.message }, 500);
    }
};

async function getTorrentsComando(requester: Requester, redisCache: RedisCache, link: string, referer: string): Promise<IndexedTorrent[]> {
    const html = await requester.getDocument(link, referer);
    if (!html) return [];

    const $ = cheerio.load(html);
    const article = $('article');
    
    const title = article.find('.entry-title').text().replace(' - Download', '').trim();
    const textContent = article.find('div.entry-content');
    
    // Date extraction
    let datePublished: string | undefined | null = $('meta[property="article:published_time"]').attr('content');
    if (!datePublished) {
        const dateText = article.find('div[itemprop="datePublished"]').text().trim();
        datePublished = parseLocalizedDate(dateText);
    }
    if (!datePublished) datePublished = new Date().toISOString();

    const magnetLinks: string[] = [];
    textContent.find('a[href^="magnet"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) magnetLinks.push(href);
    });

    const audio: string[] = [];
    let year = "";
    const sizes: string[] = [];
    let imdbLink = "";

    article.find('div.entry-content > p').each((_, el) => {
        const text = $(el).text();
        
        if (text.includes('Ano de Lançamento:')) {
          const match = text.match(/Ano de Lançamento:\s*(\d{4})/);
          if (match && match[1]) year = match[1];
        }

        if (text.includes('Tamanho:')) {
          const match = text.match(/Tamanho:\s*(.*)/);
          if (match && match[1]) {
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

        if (!magnetLink) continue;

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
                mySize = String(sizes[i]);
            }

            results.push({
                title: releaseTitle as string,
                original_title: title,
                details: link,
                year: year,
                imdb: imdbLink,
                audio: [...new Set(audio)], // unique
                magnet_link: magnetLink,
                date: datePublished || new Date().toISOString(),
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

function parseLocalizedDate(dateStr: string): string | null {
    // pattern: 10 de setembro de 2021
    const months: Record<string, string> = {
        'janeiro': '01', 'fevereiro': '02', 'março': '03', 'abril': '04',
        'maio': '05', 'junho': '06', 'julho': '07', 'agosto': '08',
        'setembro': '09', 'outubro': '10', 'novembro': '11', 'dezembro': '12'
    };

    const match = dateStr.match(/(\d{1,2}) de (\w+) de (\d{4})/);
    if (match && match[1] && match[2] && match[3]) {
        let day = match[1];
        if (day.length === 1) day = '0' + day;
        const monthName = match[2].toLowerCase();
        const month = months[monthName];
        const year = match[3];
        
        if (month) {
            return `${year}-${month}-${day}T00:00:00Z`;
        }
    }
    return null;
}
