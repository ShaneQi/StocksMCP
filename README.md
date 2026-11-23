# StocksMCP

A remote [MCP](https://modelcontextprotocol.io) server on **Cloudflare Workers (free plan)** that returns the current market price for a ticker symbol.

- **Tool:** `get_stock_price({ symbol })`. Works for stocks, ETFs, indices and crypto (`AAPL`, `SPY`, `^GSPC`, `BTC-USD`, `7203.T`, …)
- **Data:** Yahoo Finance's public chart endpoint. No API key needed. Quotes may be delayed up to about 15 minutes, depending on the exchange.
- **Transport:** Streamable HTTP at `/mcp`, built with the stateless `createMcpHandler` from the Cloudflare `agents` package. It needs no Durable Objects, KV or other paid features.
- Responses are edge-cached for 15s to stay gentle on the upstream.

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
stay off, so the Worker is only reachable through a custom domain: add one in the
dashboard (Workers → `stocks-mcp` → Settings → Domains & Routes) and the server is
at `https://<your-domain>/mcp`.

To deploy by hand: `npx wrangler login && npm run deploy`.

## Connect a client

Claude Code:

```sh
claude mcp add --transport http stocks https://<your-domain>/mcp
```

Claude.ai / Desktop: **Settings → Connectors → Add custom connector**, then paste the `/mcp` URL.

## Example result

```
AAPL (Apple Inc.): 349.92 USD | +7.36 (+2.1485%) | as of 2026-11-23T19:23:24.000Z
```

The tool also returns a JSON block with the symbol, name, price, currency, change, change percent, previous close, day high and low, volume, exchange and market time.

> The endpoint is public with no auth. Anyone with the URL can use it, within the free plan's 100k requests/day.
