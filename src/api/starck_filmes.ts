import type { Context } from 'hono';
import * as cheerio from 'cheerio';
import * as magnetUri from 'magnet-uri';
import { Requester } from '../requester/requester';
import { unshuffleString } from '../utils/decoder';
import { AudioMap } from '../schema';
import type { IndexedTorrent } from '../schema';
import { getEnvOrDefault } from '../utils';

import { MagnetMetadataClient } from '../magnet/metadata-client';
import { SearchIndexer } from '../search/meilisearch';
import * as pp from './post-processors';

const STARCK_FILMES_URL = getEnvOrDefault('INDEXER_STARCK_FILMES_URL', 'https://starckfilmes-v8.com/');
const SEARCH_URL = '?s=';
const PAGE_PATTERN = 'page/%s';

export const starckFilmesIndexer = async (
    c: Context, 
    requester: Requester,
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
    
    let url = STARCK_FILMES_URL;
    if (!url.endsWith('/')) {
        url += '/';
    }

    if (q) {
        url = `${url}${SEARCH_URL.replace(/^\?/, '')}${encodeURIComponent(q)}`; // Adjust if SEARCH_URL needs ? or not. Actually existing code was ?s=.
        // Let's stick to the original logic but fix the slash.
        // Original: url = `${STARCK_FILMES_URL}${SEARCH_URL}${encodeURIComponent(q)}`;
        // If STARCK_FILMES_URL has slash, ?s= works.
    } 
    
    // Let's rewrite safely
    const baseUrl = STARCK_FILMES_URL.endsWith('/') ? STARCK_FILMES_URL : `${STARCK_FILMES_URL}/`;

    if (q) {
        url = `${baseUrl}${SEARCH_URL}${encodeURIComponent(q)}`;
    } else {
        url = `${baseUrl}page/${page}`;
    }

    console.log(`Processing indexer request: ${url}`);
    
    const html = await requester.getDocument(url);
    if (!html) {
        return c.json({ error: 'Failed to fetch document' }, 500);
    }

    const $ = cheerio.load(html);
    const links: string[] = [];
    
    $('.item').each((_, el) => {
        const link = $(el).find('div.sub-item > a').attr('href');
        if (link) links.push(link);
    });

    let indexedTorrents: IndexedTorrent[] = [];

    // Parallel processing of links
    await Promise.all(links.map(async (link) => {
        try {
            const torrents = await getTorrentStarckFilmes(requester, link, url);
            indexedTorrents.push(...torrents);
        } catch (e) {
            console.error(`Failed to process link ${link}`, e);
        }
    }));

    // Post-processing
    indexedTorrents = pp.cleanupTitleWebsites(indexedTorrents);
    indexedTorrents = pp.appendAudioTags(indexedTorrents);
    indexedTorrents = await pp.fullfilMissingMetadata(magnetClient, indexedTorrents);
    indexedTorrents = pp.fallbackPostTitle(true, indexedTorrents); // Assuming enabled=true for now
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

async function getTorrentStarckFilmes(requester: Requester, link: string, referer: string): Promise<IndexedTorrent[]> {
    const html = await requester.getDocument(link, referer);
    if (!html) return [];

    const $ = cheerio.load(html);
    const post = $('.post');
    const capa = post.find('.capa');
    const title = capa.find('.post-description > h2').text();
    const magnets = post.find('.post-buttons a');
    
    const magnetLinks: string[] = [];
    magnets.each((_, el) => {
        const dataU = $(el).attr('data-u');
        if (dataU) {
            let decoded = unshuffleString(dataU);
            decoded = decodeURIComponent(decoded);
            if (decoded.includes('magnet:')) {
                magnetLinks.push(decoded);
            }
        }
    });

    const audio: string[] = [];
    let year = "";
    let size: string[] = [];

    capa.find('.post-description p').each((_, el) => {
        const text = $(el).text();
        if (text.includes('Lançamento:')) {
            const match = text.match(/Lançamento:\s*(\d{4})/);
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
        const parsed = magnetUri.decode(magnetLink);
        const dn = parsed.dn;
        const releaseTitle = (Array.isArray(dn) ? dn[0] : dn) || title; 
        
        results.push({
            title: releaseTitle,
            original_title: title,
            details: link,
            year: year,
            imdb: '',
            audio: [...new Set(audio)], // unique
            magnet_link: magnetLink,
            date: new Date().toISOString(),
            info_hash: parsed.infoHash || '',
            trackers: parsed.tr ? (Array.isArray(parsed.tr) ? parsed.tr : [parsed.tr]) : [],
            size: '', 
            leech_count: 0,
            seed_count: 0,
            similarity: 0
        });
    }

    return results;
}
