# StocksMCP

A remote [MCP](https://modelcontextprotocol.io) server on **Cloudflare Workers (free plan)** that returns the current market price, or the closing price on a given date, for a ticker symbol.

- **Tools** (both read-only). They work for stocks, ETFs, indices and crypto (`AAPL`, `SPY`, `^GSPC`, `BTC-USD`, `7203.T`, …):
  - `get_stock_price({ symbol })`: the current price.
  - `get_close_price({ symbol, date })`: the daily close on `date` (`YYYY-MM-DD`, in the exchange's time zone). If the market was closed that day, it returns the last trading day before it and says so. It also returns the split- and dividend-adjusted close, open, high, low and volume. For today while the session is open, the value is the latest price, marked `final: false`.
- **Data:** Yahoo Finance's public chart endpoint. No API key needed. Quotes may be delayed up to about 15 minutes, depending on the exchange.
- **Transport:** Streamable HTTP at `/mcp`, built with the stateless `createMcpHandler` from the Cloudflare `agents` package. It needs no Durable Objects, KV or other paid features.
- Responses are edge-cached for 15s to stay gentle on the upstream. Closes more than a day old are cached for a day.

## Develop

```sh
npm install
npm run dev          # http://localhost:8787/mcp
npx @modelcontextprotocol/inspector   # point at http://localhost:8787/mcp
```

## Deploy

Every push to `main` deploys with `wrangler deploy`
(`.github/workflows/deploy.yml`). It needs the repository secrets
`CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template) and
`CLOUDFLARE_ACCOUNT_ID`. Pushes that only touch Markdown are skipped, and the
workflow can also be run by hand (`workflow_dispatch`).

A deploy only replaces the code: any variables and secrets set in the dashboard
stay (`keep_bindings` in `wrangler.toml`). The `workers.dev` URL and preview URLs
stay off, and the custom domain `stocks-mcp.shaneqi.com` is managed in the
dashboard, so the server is only reachable at `https://stocks-mcp.shaneqi.com/mcp`.
Observability is not set in `wrangler.toml`, so each deploy turns it off.

To deploy by hand: `npx wrangler login && npm run deploy`.

## Configuration

Set these in the Cloudflare dashboard (Workers → `stocks-mcp` → Settings →
Variables and Secrets). `wrangler.toml` keeps them on every deploy
(`keep_bindings`), so a deploy only replaces the code.

| Name | Type | |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | variable | `<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | variable | The Access application's AUD tag (comma-separate several) |

If either is missing, `/mcp` answers `500` instead of opening up.

## Authentication

`stocks-mcp.shaneqi.com` is behind a Cloudflare Access application (the
"Cloudflare account members" policy). Access answers unauthenticated requests
with `401` and points MCP clients at its OAuth sign-in, so clients log in through
Access when they connect.

The Worker also verifies the Access JWT itself on every `/mcp` request
(`src/access.ts`, ported from MoinMoinMCP), from `Cf-Access-Jwt-Assertion` (or
`Authorization: Bearer <jwt>`): RS256 against
`https://<team>/cdn-cgi/access/certs`, issuer, audience, and `exp`/`nbf` with
60 s leeway. A missing or invalid token gets `401`; the reason is only logged,
as `access denied: …`. `/health` and `/healthz` stay open.

For `npm run dev`, put the two variables in `.dev.vars` (git-ignored).

## Connect a client

Claude Code:

```sh
claude mcp add --transport http stocks https://stocks-mcp.shaneqi.com/mcp
```

Claude.ai / Desktop: **Settings → Connectors → Add custom connector**, then paste `https://stocks-mcp.shaneqi.com/mcp`.

## Example result

```
AAPL (Apple Inc.): 349.92 USD | +7.36 (+2.1485%) | as of 2026-11-23T19:23:24.000Z
```

`get_close_price` for a Sunday:

```
AAPL (Apple Inc.) close on 2026-11-20: 342.55999755859375 USD (no trading on 2026-11-22; last trading day before it)
```

Each tool also returns a JSON block. For `get_stock_price` it has the symbol, name, price, currency, change, change percent, previous close, day high and low, volume, exchange and market time.
