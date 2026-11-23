import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";

export interface Quote {
  symbol: string;
  name: string | null;
  price: number;
  currency: string | null;
  change: number | null;
  changePercent: number | null;
  previousClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  exchange: string | null;
  marketTime: string | null;
}

/** Fetch the latest market price for a symbol from Yahoo Finance's public chart endpoint (no API key). */
export async function getQuote(rawSymbol: string): Promise<Quote> {
  const symbol = rawSymbol.trim().toUpperCase();
  const url = `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?interval=1d&range=1d`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stocks-mcp/1.0)", Accept: "application/json" },
    // Cache at Cloudflare's edge briefly to stay well under upstream rate limits.
    cf: { cacheTtl: 15, cacheEverything: true },
  });

  const body = (await res.json().catch(() => null)) as any;
  const err = body?.chart?.error;
  if (err) throw new Error(err.description ?? `No data for symbol "${symbol}"`);
  if (!res.ok) throw new Error(`Upstream quote service returned HTTP ${res.status}`);

  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") {
    throw new Error(`No price available for symbol "${symbol}"`);
  }

  const price: number = meta.regularMarketPrice;
  const prev: number | null = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const change = prev != null ? price - prev : null;

  return {
    symbol: meta.symbol ?? symbol,
    name: meta.longName ?? meta.shortName ?? null,
    price,
    currency: meta.currency ?? null,
    change: change != null ? round(change) : null,
    changePercent: change != null && prev ? round((change / prev) * 100) : null,
    previousClose: prev,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    volume: meta.regularMarketVolume ?? null,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

function createServer() {
  const server = new McpServer({ name: "Stocks MCP", version: "1.0.0" });

  server.registerTool(
    "get_stock_price",
    {
      description:
        "Get the current market price of a stock, ETF, index or crypto by ticker symbol " +
        "(e.g. AAPL, MSFT, SPY, ^GSPC, BTC-USD, 7203.T). Prices may be delayed up to ~15 minutes depending on exchange.",
      inputSchema: {
        symbol: z.string().min(1).max(20).regex(/^[A-Za-z0-9.\-^=]+$/, "Invalid ticker symbol").describe("Ticker symbol, e.g. AAPL"),
      },
    },
    async ({ symbol }) => {
      try {
        const q = await getQuote(symbol);
        const sign = (q.change ?? 0) >= 0 ? "+" : "";
        const summary =
          `${q.symbol}${q.name ? ` (${q.name})` : ""}: ${q.price} ${q.currency ?? ""}`.trim() +
          (q.change != null ? ` | ${sign}${q.change} (${sign}${q.changePercent}%)` : "") +
          (q.marketTime ? ` | as of ${q.marketTime}` : "");
        return {
          content: [
            { type: "text", text: summary },
            { type: "text", text: JSON.stringify(q, null, 2) },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to get price for "${symbol}": ${(e as Error).message}` }],
        };
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return mcpHandler(request, env, ctx);
    if (url.pathname === "/") {
      return new Response("Stocks MCP server. Connect an MCP client to /mcp\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
