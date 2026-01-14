import type { Context } from 'hono';
import type { IndexedTorrent } from '../schema';
import { AudioMap } from '../schema';
import { removeKnownWebsites, isVideoFile, formatBytes, parseSize, jaccardSimilarity } from '../utils';
import { MagnetMetadataClient } from '../magnet/metadata-client';
import { SearchIndexer } from '../search/meilisearch';

export function cleanupTitleWebsites(torrents: IndexedTorrent[]): IndexedTorrent[] {
    return torrents.map(t => ({
        ...t,
        title: removeKnownWebsites(t.title)
    }));
}

function getAudioFromTitle(title: string, currentAudio: string[]): string[] {
    const audio = new Set(currentAudio);
    for (const [key, tag] of Object.entries(AudioMap)) {
        if (title.toLowerCase().includes(key.toLowerCase())) {
            audio.add(tag);
        }
    }
    return Array.from(audio);
}

function appendAudioISO639_2Code(title: string, audio: string[]): string {
    const codeMap: Record<string, string> = {
        'dual': 'Dual Áudio',
        'dublado': 'Dublado',
        'legendado': 'Legendado',
        'nacional': 'Nacional',
        'original': 'Original',
        'multi': 'Multi-Áudio',
    };

    let newTitle = title;
    // This logic in Go was a bit more complex, checking if title already has the tag.
    // Simplifying for now to match the intent: ensure audio info is in title if relevant.
    // Actually the Go code appends specific strings based on audio tags.
    
    // For now, let's just leave it as is, or implement a simple version if needed.
    // The Go code `appendAudioISO639_2Code` seems to append "Dual Áudio" etc.
    
    return newTitle;
}

export function appendAudioTags(torrents: IndexedTorrent[]): IndexedTorrent[] {
    return torrents.map(t => {
        if (!t.title) return t;
        
        let audio = getAudioFromTitle(t.title, t.audio);
        
        // Check files if available (not implemented in schema yet fully, but let's assume)
        // In Go: for _, file := range it.Files ...
        
        return {
            ...t,
            audio
        };
    });
}

export function sendToSearchIndexer(searchIndexer: SearchIndexer | null, torrents: IndexedTorrent[]) {
    if (searchIndexer) {
        // Fire and forget
        searchIndexer.indexTorrents(torrents).catch(console.error);
    }
    return torrents;
}

export async function fullfilMissingMetadata(
    magnetClient: MagnetMetadataClient, 
    torrents: IndexedTorrent[]
): Promise<IndexedTorrent[]> {
    if (!magnetClient.isEnabled()) {
        return torrents;
    }

    const results: IndexedTorrent[] = [];
    const BATCH_SIZE = 30;
    
    for (let i = 0; i < torrents.length; i += BATCH_SIZE) {
        const batch = torrents.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (t) => {
            if (t.size && t.title && t.original_title) {
                return t;
            }

            const metadata = await magnetClient.fetchMetadata(t.magnet_link);
            if (!metadata) {
                return t;
            }

            return {
                ...t,
                size: formatBytes(metadata.size),
                title: metadata.name || t.title,
                date: t.date || metadata.created_at,
            };
        }));
        results.push(...batchResults);
    }

    return results;
}

export function fallbackPostTitle(enabled: boolean, torrents: IndexedTorrent[]): IndexedTorrent[] {
    return torrents.map(t => {
        if (!t.title) {
            if (enabled) {
                return { ...t, title: `[UNSAFE] ${t.original_title}` };
            }
            // If not enabled, it remains empty (and might be filtered out later or just shown empty)
        }
        return t;
    });
}

export function addSimilarityCheck(query: string, torrents: IndexedTorrent[]): IndexedTorrent[] {
    if (!query) return torrents;

    const qLower = query.toLowerCase();
    
    const withSimilarity = torrents.map(t => {
        const jLower = `${t.title} ${t.original_title}`.toLowerCase().replace(/\./g, ' ');
        const similarity = jaccardSimilarity(jLower, qLower);
        return { ...t, similarity };
    });

    // Filter zero similarity if many results
    let filtered = withSimilarity;
    if (withSimilarity.length > 20) {
        filtered = withSimilarity.filter(t => t.similarity > 0);
    }

    // Sort by similarity desc
    return filtered.sort((a, b) => b.similarity - a.similarity);
}

export function applyLimit(limitStr: string | undefined, torrents: IndexedTorrent[]): IndexedTorrent[] {
    if (!limitStr) return torrents;
    const limit = parseInt(limitStr);
    if (isNaN(limit) || limit <= 0) return torrents;
    return torrents.slice(0, limit);
}

export function applySorting(sortBy: string | undefined, sortDirection: string | undefined, query: string, torrents: IndexedTorrent[]): IndexedTorrent[] {
    let sortKey = sortBy;
    if (!sortKey) {
        sortKey = query ? 'similarity' : 'date';
    }

    const ascending = sortDirection === 'asc';

    return [...torrents].sort((a, b) => {
        let cmp = 0;
        switch (sortKey) {
            case 'title':
                cmp = a.title.localeCompare(b.title);
                break;
            case 'original_title':
                cmp = a.original_title.localeCompare(b.original_title);
                break;
            case 'year':
                cmp = (a.year || '').localeCompare(b.year || '');
                break;
            case 'date':
                cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
                break;
            case 'seed_count':
            case 'seeders':
                cmp = a.seed_count - b.seed_count;
                break;
            case 'leech_count':
            case 'leechers':
                cmp = a.leech_count - b.leech_count;
                break;
            case 'size':
                cmp = parseSize(a.size) - parseSize(b.size);
                break;
            case 'similarity':
                cmp = a.similarity - b.similarity;
                break;
        }
        return ascending ? cmp : -cmp;
    });
}

export function filterBy(audioParam: string | undefined, yearParam: string | undefined, imdbParam: string | undefined, torrents: IndexedTorrent[]): IndexedTorrent[] {
    if (!audioParam && !yearParam && !imdbParam) return torrents;

    const requestedAudioTags = audioParam ? audioParam.split(',').map(s => s.trim().toLowerCase()).filter(s => s) : [];

    return torrents.filter(t => {
        // Audio
        if (requestedAudioTags.length > 0) {
            const hasAudio = t.audio.some(a => requestedAudioTags.includes(a.toLowerCase()));
            if (!hasAudio) return false;
        }

        // Year
        if (yearParam && t.year !== yearParam) return false;

        // IMDB
        if (imdbParam && t.imdb && !t.imdb.includes(imdbParam)) return false;

        return true;
    });
}
