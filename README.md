# Weaboo API

A lightweight anime aggregator REST API built with Bun and TypeScript. Scrapes and deduplicates anime data from multiple providers into a single unified endpoint.

## Features

- Aggregates data from multiple anime providers concurrently
- Intelligent deduplication via canonical slug normalization and string similarity matching
- Graceful fallback when a provider is unavailable
- Strict TypeScript with full type safety
- Color-coded structured logging

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (Strict Mode)
- **HTTP Scraping**: axios + cheerio
- **Linting**: ESLint (standard-with-typescript) + Prettier

## Project Structure

```
src/
├── config/         # Constants and configuration
├── controllers/    # Route handlers
├── middleware/     # Logger and request middleware
├── providers/      # Per-source scraper logic
├── services/       # Aggregation and business logic
├── scripts/        # Developer tools (e.g., DOM scanner)
├── types/          # TypeScript interfaces
├── utils/          # Shared helpers
└── index.ts        # Entry point
```

## Quick Start

```bash
bun install
bun run dev
```

## Documentation

- [API Endpoint Specification](docs/API_ENDPOINT_SPEC.md)
- [Technical Stack](docs/TECHNICAL_STACK.md)
- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md)

## License

Private Project — All Rights Reserved
