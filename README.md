# Torrent Indexer (Bun Edition)

This project is a high-performance rewrite of the [original Torrent Indexer](https://github.com/felipemarinho97/torrent-indexer) by [felipemarinho97](https://github.com/felipemarinho97), built using [Bun](https://bun.sh).

It replicates the logic, structure, and functionality of the original Go application but leverages the Bun runtime for speed and efficiency.

## 🚀 Features

- **Fast & Efficient**: Built on Bun, optimized for performance.
- **Multiple Indexers**: Supports various Brazilian torrent sites.
- **Metadata Enrichment**: Automatically fetches metadata from the P2P network (via Magnet Metadata API).
- **Search Integration**: Optional integration with Meilisearch for indexing and searching.
- **Caching**: Redis-based caching for high-speed responses.
- **Anti-Bot Bypass**: Integrated FlareSolverr support for bypassing Cloudflare protection.

## 🛠️ Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev)
- **Scraping**: [Cheerio](https://cheerio.js.org)
- **Database/Cache**: Redis
- **Search Engine**: Meilisearch (Optional)

## 📡 API Endpoints

### General
- `GET /`: Welcome message.
- `GET /health`: Health check (Redis & FlareSolverr status).

### Search (Meilisearch)
- `GET /search?q=<query>`: Search indexed torrents.
- `GET /search/health`: Check search engine health.
- `GET /search/stats`: Get search engine statistics.

### Indexers
All indexer endpoints support the following query parameters:
- `q`: Search query (optional).
- `page`: Page number (optional).
- `limit`: Limit number of results (optional).
- `sortBy`: Sort field (e.g., `seed_count`, `leech_count`, `date`).
- `sortDirection`: `asc` or `desc`.

**Available Indexers:**
- `GET /indexers/bludv` - BluDV
- `GET /indexers/comando` - Comando Torrents
- `GET /indexers/rede-torrent` - Rede Torrent
- `GET /indexers/starck-filmes` - Starck Filmes
- `GET /indexers/torrent-dos-filmes` - Torrent dos Filmes
- `GET /indexers/vaca-torrent` - Vaca Torrent

## 🐳 Docker

The application is containerized using a multi-stage build to produce a minimal image with a standalone binary.

```bash
docker-compose up -d --build
```

## 📜 Credits

All credit for the original idea, architecture, and scraping logic goes to **[Felipe Marinho](https://github.com/felipemarinho97)**. This project is simply a port to the Bun ecosystem.
