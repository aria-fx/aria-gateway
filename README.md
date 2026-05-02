# ARIA Distribution Gateway

> **Distribution gateway and catalog API for ARIA-compliant AI assets.**
> Provides a governed, browsable marketplace endpoint for AI platforms like Claude Desktop, ChatGPT, and VS Code.

[![CI](https://github.com/aria-fx/aria-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/aria-fx/aria-gateway/actions/workflows/ci.yml)
[![Docker](https://github.com/aria-fx/aria-gateway/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/aria-fx/aria-gateway/actions/workflows/docker-publish.yml)

---

## What is this?

The ARIA Distribution Gateway is the "last mile" delivery layer for the [ARIA Asset Registry for Intelligent Agents](https://github.com/aria-fx/aria) framework.

It translates governed OCI artifacts stored in the ARIA marketplace into platform-native install experiences:

| Platform | Experience |
|----------|-----------|
| **Claude Desktop** | Browse and add skills via MCP server integration |
| **ChatGPT / GPT Actions** | Catalog appears as a plugin via OpenAPI spec |
| **VS Code** | Skills install into `.vscode/mcp.json` via config snippet |
| **Web Browser** | Non-technical users browse and install from the catalog UI |

---

## Quick Start

### Using Docker Compose (recommended)

```bash
git clone https://github.com/aria-fx/aria-gateway
cd aria-gateway
docker compose up -d
```

Open **http://localhost:8080** to browse the catalog.

| Service | URL |
|---------|-----|
| Web Catalog UI | http://localhost:8080 |
| Catalog API | http://localhost:8080/catalog/assets |
| MCP Server (Claude) | http://localhost:8080/mcp |
| ChatGPT Plugin | http://localhost:8080/.well-known/ai-plugin.json |
| OpenAPI Spec | http://localhost:8080/openapi.json |

### Local development

```bash
# Start the API
cd api && npm install && npm run dev
# API running at http://localhost:3001

# Start the UI (in another terminal)
cd ui && npm install && npm run dev
# UI running at http://localhost:5173
```

---

## Integration Guides

### Claude Desktop

Add the ARIA catalog as an MCP server in Claude Desktop:

1. Open Claude Desktop → **Settings → Developer → Edit Config**
2. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aria-gateway": {
      "url": "http://your-gateway-host/mcp"
    }
  }
}
```

3. Restart Claude Desktop. Type `@aria-gateway` in any conversation to search and install skills.

Available MCP tools:
- `search_assets` — find skills by keyword or department
- `get_asset_detail` — get details about a specific skill
- `install_asset` — get step-by-step installation instructions

### ChatGPT / GPT Actions

1. In the GPT editor, select **Create new action**
2. Set the OpenAPI URL to: `https://your-gateway-host/openapi.json`
3. Or point to the plugin manifest: `https://your-gateway-host/.well-known/ai-plugin.json`

ChatGPT will be able to search the catalog and help users install skills.

### VS Code (GitHub Copilot MCP)

Skills from the catalog install directly into VS Code by adding to `.vscode/mcp.json`:

```json
{
  "servers": {
    "skill-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@aria-fx/skill-name@version"]
    }
  }
}
```

The "Add to VS Code" button on the catalog UI generates this snippet automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ARIA Distribution Gateway                      │
│                                                                   │
│  ┌─────────┐    ┌──────────────────────┐    ┌───────────────┐   │
│  │  nginx  │    │    Catalog API        │    │  Web Catalog  │   │
│  │ :8080   │───▶│    (Express/TS)       │    │  UI (React)   │   │
│  │         │    │    :3001              │    │  :80          │   │
│  │ /catalog│    │                       │    │               │   │
│  │ /mcp    │    │ • OASF record store   │    │ • Browse      │   │
│  │ /v1/    │    │ • Governance checks   │    │ • Search      │   │
│  │ /chatgpt│    │ • .mcpb packager      │    │ • Install     │   │
│  │ /claude │    │ • MCP JSON-RPC        │    │ • Request     │   │
│  │ /.w-k/  │    │ • ChatGPT manifest    │    │   Access      │   │
│  └─────────┘    └──────────────────────┘    └───────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### URL Rewrite Rules (nginx)

| Incoming URL | Routes to | Notes |
|-------------|-----------|-------|
| `/.well-known/ai-plugin.json` | Catalog API | ChatGPT plugin manifest |
| `/.well-known/openapi.yaml` | Catalog API | OpenAPI spec (alias) |
| `/openapi.json` | Catalog API | OpenAPI spec |
| `/mcp`, `/mcp/*` | Catalog API | Claude Desktop MCP endpoint |
| `/catalog/*` | Catalog API | Direct API access |
| `/v1/*` | Catalog API | Versioned alias (`/v1/assets` → `/catalog/assets`) |
| `/chatgpt/*` | Catalog API | ChatGPT-tagged requests |
| `/claude/*` | Catalog API | Claude Enterprise-tagged requests |
| `/` and everything else | Web UI | React SPA |

---

## Catalog API Reference

All endpoints are under `/catalog/`. Requests tagged from AI platforms via nginx headers.

### Authentication

The gateway reads governance context from HTTP headers:
- `X-Consumer-Id` — your team identity (e.g., `hr-team`)
- `X-Sensitivity-Ceiling` — your clearance level (`public`, `internal`, `confidential`, `highly_confidential`)

When not provided, the gateway defaults to `all-employees` / `internal` access.

> **Policy Contract:** The identity, access, and decision types used internally are defined in the versioned Auth-Core Policy Contract (`v1.0.0`).  See [`api/docs/policy-contract.md`](api/docs/policy-contract.md) for the full contract specification, versioning strategy, and IDP extension points.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/catalog/assets` | List all assets you're authorized to see |
| `GET` | `/catalog/assets?keyword=hr&domain=human_resources` | Search/filter assets |
| `GET` | `/catalog/assets/{name}/versions` | List versions of an asset |
| `GET` | `/catalog/assets/{name}/{version}/manifest` | Full OASF record + governance overlay |
| `GET` | `/catalog/assets/{name}/{version}/mcpb` | Download `.mcpb` bundle for Claude Desktop |
| `POST` | `/catalog/assets/{name}/{version}/install` | Get install config for a target platform |
| `POST` | `/catalog/assets/{name}/{version}/request-access` | Submit access request |
| `GET` | `/catalog/stats` | Catalog summary statistics |

### Governance

Every request is checked against the OASF governance overlay:

1. **Sensitivity ceiling** — asset tier ≤ consumer ceiling
2. **Consumer allow-list** — consumer identity in `allowed_consumers`
3. **Dependency ceiling** — recursive dependency check

If blocked, the API returns `403` with a plain-language reason and an `action_url` to request access.

---

## Sensitivity Tiers

| Tier | Who can see it | Example |
|------|----------------|---------|
| `public` | Everyone (including AI platforms) | Code review skill |
| `internal` | All employees | HR policy lookup |
| `confidential` | Specific teams with approval | Onboarding assistant |
| `highly_confidential` | Restricted to named consumers | Financial analyzer |

---

## Project Structure

```
aria-gateway/
├── api/                    # Catalog API (Express + TypeScript)
│   ├── src/
│   │   ├── models/         # OASF type definitions + policy contract types
│   │   │   ├── oasf.ts     # OASF record, governance, asset types
│   │   │   └── policy-contract.ts  # Auth-core policy contract v1.0.0
│   │   ├── data/           # Sample asset catalog
│   │   ├── services/       # Catalog, governance, .mcpb services
│   │   └── routes/         # catalog, plugins (ChatGPT), mcp (Claude)
│   ├── docs/               # Contract documentation and JSON Schema
│   │   ├── policy-contract.md          # Contract spec, versioning, IDP guide
│   │   └── policy-contract.schema.json # JSON Schema for contract objects
│   ├── tests/              # Vitest + Supertest API tests
│   └── Dockerfile
├── ui/                     # Web Catalog UI (React + TypeScript + Tailwind)
│   ├── src/
│   │   ├── api/            # Catalog API client
│   │   ├── components/     # AssetCard, SearchBar, TrustBadge, InstallPanel
│   │   ├── pages/          # CatalogPage, AssetDetailPage
│   │   └── tests/          # Vitest + Testing Library UI tests
│   └── Dockerfile
├── nginx/
│   └── nginx.conf          # URL rewrite rules + reverse proxy
├── docker-compose.yml
├── CHANGELOG.md
└── .github/workflows/
    ├── ci.yml              # Lint + build + test on every PR
    ├── docker-publish.yml  # Build and push Docker images on merge
    └── release.yml         # Create GitHub release on tag
```

---

## Running Tests

```bash
# API tests (Vitest + Supertest)
cd api && npm test

# UI tests (Vitest + Testing Library)
cd ui && npm test

# With coverage
cd api && npm run test:coverage
```

---

## Docker Images

Published to GitHub Container Registry on every merge to `main`:

| Image | Description |
|-------|-------------|
| `ghcr.io/aria-fx/aria-gateway-api:latest` | Catalog API |
| `ghcr.io/aria-fx/aria-gateway-ui:latest` | Web Catalog UI |

Images are built for `linux/amd64` and `linux/arm64`.

---

## Environment Variables

### API (`api/`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | API server port |
| `API_BASE_URL` | `http://localhost:3001` | Public base URL (used in manifests) |
| `CORS_ORIGIN` | `*` | CORS allowed origins |
| `NODE_ENV` | `development` | Environment mode |
| `OCI_REGISTRY` | `ghcr.io/aria-fx/aria-assets` | OCI registry for `.mcpb` packages |

### UI (`ui/`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `/catalog` | Catalog API base URL |

---

## Contributing

This project follows the [ARIA framework specification](https://github.com/aria-fx/aria). OASF record structure, governance overlay format, and lifecycle states are defined in the ARIA reference architecture.

---

## License

MIT
