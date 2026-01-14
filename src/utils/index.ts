export const SPOOFED_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function isValidHTML(input: string): boolean {
  const doctypeRegex = /<!DOCTYPE\s+html>/i;
  const htmlTagRegex = /<html[\s\S]*?>[\s\S]*?<\/html>/i;
  const bodyTagRegex = /<body[\s\S]*?>[\s\S]*?<\/body>/i;

  if (!doctypeRegex.test(input) && !htmlTagRegex.test(input) && !bodyTagRegex.test(input)) {
    return false;
  }
  return true;
}

export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function parseSize(sizeStr: string): number {
    if (!sizeStr) return 0;
    const parts = sizeStr.trim().split(/\s+/);
    if (parts.length < 2) return 0;

    const value = parseFloat(parts[0]);
    const unit = (parts[1] || '').toUpperCase();

    const units: { [key: string]: number } = {
        'BYTES': 1,
        'KB': 1024,
        'MB': 1024 * 1024,
        'GB': 1024 * 1024 * 1024,
        'TB': 1024 * 1024 * 1024 * 1024
    };

    return Math.floor(value * (units[unit] || 1));
}

export function isVideoFile(path: string): boolean {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    return videoExtensions.some(ext => path.toLowerCase().endsWith(ext));
}

export function removeKnownWebsites(title: string): string {
    const websites = [
        "www.bludv.com", "bludv.com", "bludv",
        "www.comando.la", "comando.la", "comando",
        "www.torrentdosfilmes.net", "torrentdosfilmes.net", "torrentdosfilmes",
        "www.vacatorrent.com", "vacatorrent.com", "vacatorrent",
        "www.redetorrent.com", "redetorrent.com", "redetorrent",
        "www.starckfilmes.com.br", "starckfilmes.com.br", "starckfilmes",
    ];
    
    let cleanTitle = title;
    for (const site of websites) {
        const regex = new RegExp(site, 'gi');
        cleanTitle = cleanTitle.replace(regex, '');
    }
    return cleanTitle.replace(/\s+/g, ' ').trim();
}

export function jaccardSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;

    const bigrams1 = new Set<string>();
    for (let i = 0; i < s1.length - 1; i++) {
        bigrams1.add(s1.substring(i, i + 2));
    }

    const bigrams2 = new Set<string>();
    for (let i = 0; i < s2.length - 1; i++) {
        bigrams2.add(s2.substring(i, i + 2));
    }

    const intersection = new Set([...bigrams1].filter(x => bigrams2.has(x)));
    const union = new Set([...bigrams1, ...bigrams2]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
}
