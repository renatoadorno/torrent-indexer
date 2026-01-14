export interface IndexedTorrent {
  title: string;
  original_title: string;
  details: string;
  year: string;
  imdb: string;
  audio: string[];
  magnet_link: string;
  date: string; // ISO string
  info_hash: string;
  trackers: string[];
  size: string;
  files?: File[];
  leech_count: number;
  seed_count: number;
  similarity: number;
}

export interface File {
  path: string;
  size: string;
}

export const AudioMap: Record<string, string> = {
  "Português": "brazilian",
  "Portugues": "brazilian",
  "PT-BR": "brazilian",
  "Dublado": "brazilian",
  "Nacional": "brazilian",
  "Inglês": "eng",
  "Ingles": "eng",
  "Espanhol": "spa",
  "Francês": "fra",
  "Alemão": "deu",
  "Italiano": "ita",
  "Japonês": "jpn",
  "Coreano": "kor",
  "Russo": "rus",
  "Dual Áudio": "dual"
};

export function getAudioTag(audio: string): string {
    return AudioMap[audio] || "";
}
