# Contributing to OpenChief

Thank you for your interest in contributing to OpenChief! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/openchief/openchief.git
cd openchief
pnpm install
pnpm build
```

## Project Structure

```
openchief/
├── packages/shared/          # Core types and utilities
├── workers/
│   ├── runtime/              # Agent Durable Object runtime
│   ├── router/               # Event routing + identity resolution
│   ├── dashboard/            # React SPA
│   └── connectors/           # Data source integrations
│       ├── github/
│       ├── slack/
│       └── ...
├── agents/                   # Starter agent definitions (JSON)
├── migrations/               # D1 database schema
└── scripts/                  # Setup and seed scripts
```

## How to Contribute

### Adding a New Connector

Connectors are the most impactful contribution. Each connector brings a new data source into OpenChief.

1. Create a directory: `workers/connectors/your-source/`
2. Set up the standard files:
   - `package.json` (name: `@openchief/connector-your-source`)
   - `tsconfig.json` (extends `../../../tsconfig.base.json`)
   - `wrangler.jsonc` (produces to `openchief-events` queue)
   - `src/index.ts` (main worker)
   - `src/normalize.ts` (convert source events to `OpenChiefEvent`)

3. Your connector should:
   - Accept webhooks and/or poll the source API
   - Normalize events into `OpenChiefEvent` format
   - Publish to the `openchief-events` queue
   - Handle authentication (OAuth, API keys, etc.)

4. Follow the naming conventions:
   - Event types: `entity.action` (e.g., `pr.opened`, `message.posted`)
   - Source name: lowercase, hyphenated (e.g., `google-calendar`)

### Adding a Starter Agent

Agent definitions are JSON files in `agents/`. Good starter agents:
- Are generic enough to work for any company
- Have clear, well-written personas
- Define specific watch patterns and report sections
- Don't reference any specific company, product, or team

### Improving the Runtime

The runtime (`workers/runtime/`) is the core engine. Key areas:
- `prompt-builder.ts` — How events become Claude prompts
- `agent-tools.ts` — Tools available to agents during chat
- `agent-do.ts` — Durable Object lifecycle and report generation

### Improving the Dashboard

The dashboard (`workers/dashboard/`) is a React + Tailwind SPA.

## Code Style

- TypeScript strict mode
- ES2022 target
- Prefer explicit types over `any`
- Use `OpenChiefEvent` (not generic "event") for event references
- Keep functions small and focused

## Commit Messages

Use descriptive commit messages:
- `feat: add Linear connector for issue tracking`
- `fix: handle rate limits in Slack polling`
- `docs: add connector development guide`

## Testing

```bash
pnpm typecheck      # Type-check all packages
pnpm build          # Verify everything builds
```

## Questions?

Open an issue or start a discussion on GitHub.
