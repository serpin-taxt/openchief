# workers/dashboard — Dashboard SPA + API

The user-facing Cloudflare Worker that serves the React SPA and provides all management API endpoints. Handles agent CRUD, connector configuration, identity management, job tracking, model settings, and proxies chat/report requests to the runtime.

## Worker Info

- **Name**: `openchief-dashboard`
- **Entry**: `worker/index.ts` (API) + `src/` (React SPA, built by Vite)
- **Bindings**: D1 (`DB`), KV (`KV`), `AGENT_RUNTIME` (service binding to runtime worker), `ASSETS` (Vite SPA), `CF_API_TOKEN` (secret), `CF_ACCOUNT_ID` (var), `AUTH_PROVIDER` (var), `ADMIN_PASSWORD` (secret, optional), `CF_ACCESS_TEAM_DOMAIN` (var, optional)
- **Asset serving**: SPA mode — all non-`/api/*` routes serve the React app; 404s redirect to `index.html`

## File Structure

```
worker/
└── index.ts              # 1,671 lines — ALL API routes + connector registry

src/
├── main.tsx              # React entry point
├── App.tsx               # React Router with 9 routes (+ /login)
├── index.css             # Tailwind v4 + OKLch color system + dark mode
├── pages/
│   ├── Home.tsx          # Dashboard landing (agent cards + connection cards)
│   ├── AgentDetail.tsx   # Agent editor (persona, events, reports, subscriptions)
│   ├── AgentHistory.tsx  # Revision history table
│   ├── ReportView.tsx    # Full report display (sections, action items, health)
│   ├── ConnectionDetail.tsx # Connector settings + access control + recent events
│   ├── Team.tsx          # Identity management (filter, merge, cross-platform)
│   ├── Jobs.tsx          # Report job status + manual triggers
│   ├── Models.tsx        # AI model configuration per job type
│   └── Login.tsx         # Password auth login page
├── components/
│   ├── Layout.tsx        # Main layout with collapsible sidebar + chat widget
│   ├── AppSidebar.tsx    # Navigation + logout button (password mode)
│   ├── RequireAuth.tsx   # Route guard (redirects based on auth mode)
│   ├── ChatSidebar.tsx   # Floating chat widget (SSE streaming, tool status, config proposals)
│   ├── HealthBadge.tsx   # Green/yellow/red status indicator
│   └── SourceIcon.tsx    # Lucide icon mapper for data sources
├── components/ui/        # shadcn/ui primitives (badge, button, card, dialog, etc.)
├── lib/
│   ├── api.ts            # API client (get/post/put/delete + SSE parser + 401 handling)
│   ├── auth.tsx          # AuthProvider context + useAuth() hook
│   └── utils.ts          # cn(), timeAgo(), formatDate(), formatDateTime()
└── data/
    └── planned.ts        # Planned future connections (coming-soon list)
```

## React Routes (`App.tsx`)

| Path | Page | Description |
|------|------|-------------|
| `/` | Home | Agent cards with latest report + connection cards with status |
| `/modules/:id` | AgentDetail | Full agent editor with persona, events, reports |
| `/modules/:id/history` | AgentHistory | Revision change log |
| `/modules/:id/reports/:reportId` | ReportView | Single report with sections + action items |
| `/connections/:source` | ConnectionDetail | Connector config fields + agent access + events |
| `/team` | Team | Identity management with merge functionality |
| `/jobs` | Jobs | Report generation status + manual trigger |
| `/models` | Models | AI model selection per job type |

## API Routes (`worker/index.ts`)

### User Profile
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/me` | Current user (email, displayName, avatarUrl, team, role) |

### Agents
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents` | List all enabled agents |
| POST | `/api/agents` | Create new agent (validates id/name, creates subscriptions + revision) |
| GET | `/api/agents/:id` | Get single agent config |
| PUT | `/api/agents/:id` | Update agent (replaces subscriptions, creates revision, invalidates KV) |

### Agent Avatars
| Method | Route | Description |
|--------|-------|-------------|
| PUT | `/api/agents/:id/avatar` | Upload image (max 5MB, detects PNG/JPEG/GIF/WebP/SVG) |
| GET | `/api/agents/:id/avatar` | Serve avatar (edge-cached, 1 week TTL, ETag) |
| DELETE | `/api/agents/:id/avatar` | Delete avatar |

### Agent Reports
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:id/reports` | List up to 50 reports (newest first) |
| GET | `/api/agents/:id/reports/latest` | Latest report (KV-cached, 5 min TTL) |
| GET | `/api/agents/:id/reports/:reportId` | Single report by ID |

### Agent Revisions
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:id/revisions` | List up to 50 revisions (newest first) |

### Agent Chat (proxied to runtime)
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/agents/:id/chat` | SSE streaming chat (proxied to runtime worker) |
| GET | `/api/agents/:id/chat/history` | Chat history by user email |

### Agent Events
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:id/events/volume` | Event volume by source/date (1-90 days) |
| POST | `/api/agents/:id/trigger/:reportType` | Manual report trigger (proxied to runtime) |

### Connections
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/connections` | All 14 connectors with status (connected/not_configured) |
| GET | `/api/connections/:source/settings` | Connector config fields (secrets masked) |
| PUT | `/api/connections/:source/settings` | Update connector secrets via Cloudflare API |
| GET | `/api/connections/:source/events` | Recent 100 events from source |
| GET | `/api/connections/:source/access` | Which agents have access to this source's tool |

### Identities
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/identities` | All identity mappings |
| POST | `/api/identities/merge` | Merge two identities (primary absorbs secondary) |

### Jobs
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/jobs/status?date=YYYY-MM-DD` | Expected vs generated reports per agent per date |

### Models
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/models` | Model settings per job type |
| PUT | `/api/models/:jobType` | Update model (validates model + jobType) |

## Connector Registry (`CONNECTOR_CONFIGS`)

14 connectors defined with display name, worker name, and configuration fields:

| Source | Worker | Key Fields |
|--------|--------|------------|
| github | openchief-connector-github | App ID, Private Key, Installation ID, Webhook Secret, Repos |
| slack | openchief-connector-slack | Bot Token, Signing Secret |
| discord | openchief-connector-discord | Bot Token, Public Key, Guild ID |
| figma | openchief-connector-figma | Personal Access Token, Webhook Passcode |
| amplitude | openchief-connector-amplitude | API Key, Secret Key, Project Name |
| intercom | openchief-connector-intercom | Access Token, Client Secret |
| twitter | openchief-connector-twitter | Bearer Token, OAuth Client ID/Secret, Monitored Accounts, Search Queries |
| google-analytics | openchief-connector-googleanalytics | Service Account Key (JSON), GA4 Property ID |
| google-calendar | openchief-connector-googlecalendar | OAuth Client ID/Secret, Calendar ID |
| notion | openchief-connector-notion | Integration Token |
| jira | openchief-connector-jira | API Email, API Token, Instance URL, Projects |
| quickbooks | openchief-connector-quickbooks | Client ID, Client Secret |
| rippling | openchief-connector-rippling | API Token |
| jpd | openchief-connector-jpd | API Email, API Token, Instance URL, JPD Projects |

Each connector field has: `name`, `label`, `secret` (boolean), optional `placeholder`.

## Source-to-Tool Mapping (`SOURCE_TO_TOOL`)

Maps connector sources to agent tool names (used for access control):

```
github → github_file       slack → slack_search
discord → discord_search   jira → jira_query
notion → notion_query      figma → figma_data
amplitude → amplitude_query   intercom → intercom_data
twitter → twitter_search   googleanalytics → ga4_query
googlecalendar → gcal_events   quickbooks → quickbooks_query
database → query_database  rippling → rippling_data
jpd → jpd_query
```

## Authentication

Three auth modes controlled by `AUTH_PROVIDER` wrangler var:

### `"none"` — Open Access
- No auth checks, all routes accessible
- `getUserEmail()` returns `"unknown"`
- Best for local dev or VPN-protected instances

### `"password"` — Admin Password (Recommended)
- Single password stored as `ADMIN_PASSWORD` wrangler secret
- Sessions use HMAC-SHA256 signed cookies: `oc_session` (HttpOnly, Secure, SameSite=Lax, 7-day TTL)
- Token format: `email|expiry|hmac_hex` signed via Web Crypto `crypto.subtle`
- Password verified with constant-time comparison to prevent timing attacks
- Login page: `src/pages/Login.tsx` → React Router `/login`
- Logout button in sidebar footer (password mode only)

### `"cloudflare-access"` — Cloudflare Zero Trust SSO
- CF Access handles authentication at the edge before requests reach the Worker
- User email from `cf-access-authenticated-user-email` header
- Middleware rejects requests missing the header (returns 401)
- Frontend redirects to CF Access login: `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/login?redirect_url=...`
- If `CF_ACCESS_TEAM_DOMAIN` is not set, shows an error page with setup instructions
- Requires manually creating an Access application in the CF Zero Trust dashboard

### Auth Middleware Flow (in `worker/index.ts` fetch handler)
1. Auth routes (`/api/auth/*`) are handled first — always accessible
2. Middleware checks run before all other `/api/*` routes:
   - `"cloudflare-access"`: verify `cf-access-authenticated-user-email` header exists
   - `"password"`: verify `oc_session` cookie has valid HMAC signature and isn't expired
   - `"none"`: no checks
3. Protected routes proceed with `await getUserEmail(request, env)` to get the current user

### Auth Frontend Components
- **`src/lib/auth.tsx`** — `AuthProvider` wraps the app, calls `/api/auth/session` on mount. Exposes `useAuth()` hook with `{ checked, authenticated, provider, teamDomain, login, logout }`
- **`src/components/RequireAuth.tsx`** — Route guard wrapping all dashboard routes. `"none"` passes through, `"password"` redirects to `/login`, `"cloudflare-access"` redirects to CF Access login URL or shows setup error
- **`src/pages/Login.tsx`** — Password form with OpenChief branding, error state, loading spinner
- **`src/components/AppSidebar.tsx`** — Logout button in user footer (password mode, expanded sidebar only)
- **`src/lib/api.ts`** — On 401 from non-auth endpoints, calls `window.location.reload()` to re-enter the auth flow

### Auth API Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/auth/session` | Returns `{ authenticated, provider, email?, teamDomain? }` |
| POST | `/api/auth/login` | Password login (constant-time compare, sets cookie) |
| POST | `/api/auth/logout` | Clears session cookie |

### Wrangler Bindings
| Name | Type | Description |
|------|------|-------------|
| `AUTH_PROVIDER` | var | `"none"` / `"cloudflare-access"` / `"password"` |
| `ADMIN_PASSWORD` | secret | Password for admin login (password mode only) |
| `CF_ACCESS_TEAM_DOMAIN` | var | CF Access team domain for login redirect (CF Access mode only) |

### Identity Resolution
Regardless of auth mode, user email is resolved via the `identity_mappings` D1 table for display names, avatars, team, and role. Falls back to email prefix if no identity found.

## Secret Management

Connector secrets are managed via the Cloudflare API (not stored in code):
- **Secret fields**: `PUT /accounts/{id}/workers/scripts/{worker}/secrets` (type: `secret_text`)
- **Plain text fields**: `PATCH /accounts/{id}/workers/scripts/{worker}/settings` (type: `plain_text`)
- **Metadata**: Stored in KV (`connector-secret:{source}:{field}`) to track which fields are configured
- **Display**: Secrets masked as first 4 + last 4 chars

## Frontend Components

### Key Pages

**Home** — Grid of agent cards (shows latest report headline, health signal, event count) + connection cards (shows status dot, event count, last activity). Planned connections shown as "coming soon" cards.

**AgentDetail** — Full agent editor with editable persona fields (role, voice, personality, instructions, output style, watch patterns). Includes event volume bar chart (Recharts), report history table, subscription list, and tools display. Save triggers PUT to create a new revision.

**ConnectionDetail** — Settings form with reveal/hide for secrets. Shows which agents have tool access to this source. Lists recent 100 events with expandable details.

**ChatSidebar** — Floating chat widget attached to the currently-viewed agent. Parses SSE stream for real-time deltas, tool status indicators, and `<config_update>` blocks (proposed agent config changes with Apply/Dismiss buttons).

### UI Library

shadcn/ui components in `components/ui/`: badge, button, card, chart, dialog, input, select, separator, sheet, skeleton, table, textarea, tooltip. All built on Radix primitives + class-variance-authority (CVA) for variants.

### Styling

- Tailwind CSS v4 with OKLch color space
- Dark mode support (`.dark` class)
- CSS custom properties for all colors, shadows, spacing
- Chart colors: `--chart-1` through `--chart-5`
- Sidebar theme colors: `--sidebar`, `--sidebar-primary`, `--sidebar-accent`

## Build

```bash
cd workers/dashboard
npx vite build        # Build React SPA → dist/
npx wrangler deploy   # Deploy Worker + assets
```

Vite config: `@vitejs/plugin-react` + `@tailwindcss/vite` + `@cloudflare/vite-plugin`

Path alias: `@` → `./src/`
