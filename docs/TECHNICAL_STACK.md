# Technical Stack

## Runtime & Language

- **Runtime**: Bun (v1.3.8+)
  - Ultra-fast JavaScript runtime
  - Native TypeScript support
  - Built-in bundler and test runner
  
- **Language**: TypeScript 5.x (Strict Mode)
  - Explicit return types enforced
  - No unused imports/variables allowed
  - Full type safety across codebase

## Core Dependencies

### Production
- **cheerio** (^1.0.0-rc.12): Fast, flexible HTML parsing and scraping

### Development
- **@typescript-eslint/eslint-plugin** (^6.21.0): TypeScript linting rules
- **@typescript-eslint/parser** (^6.21.0): TypeScript parser for ESLint
- **eslint** (^8.56.0): JavaScript/TypeScript linter
- **eslint-config-standard-with-typescript** (^43.0.1): Standard style guide with TypeScript support
- **prettier** (^3.2.4): Code formatter

## Code Quality Standards

### ESLint Configuration
- Explicit function return types required
- Unused variables/imports detection
- Member ordering enforcement
- Import statement ordering
- No explicit `any` types allowed

### Prettier Configuration
- No semicolons
- Single quotes
- 2-space indentation
- Trailing commas (ES5)
- 100 character line width

## Architecture Patterns

### Modular Structure
```
src/
├── config/         # Configuration and constants
├── controllers/    # HTTP request handlers
├── middleware/     # Request/response middleware
├── providers/      # Data source scrapers
├── services/       # Business logic layer
├── scripts/        # Automation tools
├── types/          # TypeScript type definitions
└── utils/          # Helper functions
```

### Design Principles
- **Separation of Concerns**: Each module has a single responsibility
- **Dependency Injection**: Controllers receive services via constructor
- **Error Handling**: Graceful degradation when providers fail
- **Type Safety**: Strict TypeScript throughout

## Performance Optimizations

- **Parallel Fetching**: All providers scraped concurrently using `Promise.allSettled`
- **Efficient Deduplication**: O(n) string similarity algorithm with early exit
- **Lazy Loading**: Providers instantiated once, reused across requests
- **Native Performance**: Bun's native speed advantages

## Logging System

Custom logger with color-coded output:
- INFO (Cyan): General information
- SUCCESS (Green): Successful operations
- WARNING (Yellow): Non-critical issues
- ERROR (Red): Critical failures
- DEBUG (Magenta): Debug information

## Security Considerations

- User-Agent spoofing to avoid bot detection
- Cloudflare challenge handling
- Rate limiting (future enhancement)
- Input validation (future enhancement)
