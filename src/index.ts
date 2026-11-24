import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { type AccessEnv, accessConfig, accessToken, verifyAccessJwt } from "./access";

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

export interface ClosePrice {
  symbol: string;
  name: string | null;
  requestedDate: string;
  /** The trading day the close is from: the requested date, or the last trading day before it. */
  date: string;
  close: number;
  /** Close adjusted for splits and dividends. */
  adjClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  currency: string | null;
  exchange: string | null;
  timezone: string | null;
  /** False while that day's regular session is still open (the "close" is then the latest price). */
  final: boolean;
}

const DAY = 86400;

/** YYYY-MM-DD of a Unix time in the exchange's time zone. */
function localDate(unix: number, timeZone: string | null, gmtoffset: number): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(unix * 1000),
      );
    } catch {
      // Unknown zone name: fall back to the fixed offset below.
    }
  }
  return new Date((unix + gmtoffset) * 1000).toISOString().slice(0, 10);
}

/**
 * Fetch the daily close for a symbol on a date (YYYY-MM-DD, exchange-local) from Yahoo Finance.
 * If the market was closed that day, returns the last trading day before it.
 */
export async function getClosePrice(rawSymbol: string, date: string): Promise<ClosePrice> {
  const symbol = rawSymbol.trim().toUpperCase();
  const target = Date.parse(`${date}T00:00:00Z`) / 1000;
  // A window wide enough to cover long market closures before the date, and time-zone slack after it.
  const period1 = target - 14 * DAY;
  const period2 = target + 2 * DAY;
  const url =
    `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}&includeAdjustedClose=true`;

  const now = Date.now() / 1000;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stocks-mcp/1.0)", Accept: "application/json" },
    // Past closes don't change, so cache them for a day; recent ones only briefly.
    cf: { cacheTtl: period2 < now - DAY ? 86400 : 15, cacheEverything: true },
    signal: AbortSignal.timeout(10_000),
  });

  const body = (await res.json().catch(() => null)) as any;
  const err = body?.chart?.error;
  if (err) throw new Error(err.description ?? `No data for symbol "${symbol}"`);
  if (!res.ok) throw new Error(`Upstream quote service returned HTTP ${res.status}`);

  const result = body?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) throw new Error(`No data for symbol "${symbol}"`);

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const tz: string | null = meta.exchangeTimezoneName ?? null;
  const offset: number = meta.gmtoffset ?? 0;

  // Last bar on or before the requested date that has a close.
  let i = -1;
  for (let k = 0; k < timestamps.length; k++) {
    if (localDate(timestamps[k], tz, offset) <= date && typeof quote.close?.[k] === "number") i = k;
  }
  if (i < 0) {
    if (typeof meta.firstTradeDate === "number" && meta.firstTradeDate > target + DAY) {
      const first = localDate(meta.firstTradeDate, tz, offset);
      throw new Error(`"${meta.symbol ?? symbol}" only has data from ${first}`);
    }
    throw new Error(`No close price for "${meta.symbol ?? symbol}" on or in the two weeks before ${date}`);
  }

  const barDate = localDate(timestamps[i], tz, offset);
  const sessionEnd: number | undefined = meta.currentTradingPeriod?.regular?.end;
  const isToday = barDate === localDate(now, tz, offset);
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  return {
    symbol: meta.symbol ?? symbol,
    name: meta.longName ?? meta.shortName ?? null,
    requestedDate: date,
    date: barDate,
    close: quote.close[i],
    adjClose: num(adj[i]),
    open: num(quote.open?.[i]),
    high: num(quote.high?.[i]),
    low: num(quote.low?.[i]),
    volume: num(quote.volume?.[i]),
    currency: meta.currency ?? null,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
    timezone: tz,
    final: !(isToday && (sessionEnd == null || now < sessionEnd)),
  };
}

/** Today's date in UTC+14 (the earliest time zone), so no exchange's "today" is rejected as future. */
const latestToday = () => new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 10);

const isRealDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};

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

  server.registerTool(
    "get_close_price",
    {
      title: "Get close price on a date",
      description:
        "Get the daily closing price of a stock, ETF, index or crypto for a given date (YYYY-MM-DD, in the " +
        "exchange's local time zone). If the market was closed that day (weekend, holiday), returns the close of " +
        "the last trading day before it and says which day that was. Also returns the split- and dividend-adjusted " +
        "close, open, high, low and volume. For today's date while the market is open, the value is the latest " +
        "price, marked final: false.",
      inputSchema: {
        symbol: z.string().min(1).max(20).regex(/^[A-Za-z0-9.\-^=]+$/, "Invalid ticker symbol").describe("Ticker symbol, e.g. AAPL"),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be a date like 2026-11-20.")
          .refine(isRealDate, "date must be a real calendar date like 2026-11-20.")
          .refine((d) => d >= "1970-01-01", "date must be 1970-01-01 or later.")
          .refine((d) => d <= latestToday(), "date must not be in the future.")
          .describe("Trading day, YYYY-MM-DD, e.g. 2026-11-20"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, date }) => {
      const started = Date.now();
      try {
        const c = await getClosePrice(symbol, date);
        const note =
          c.date !== c.requestedDate
            ? ` (no trading on ${c.requestedDate}; last trading day before it)`
            : !c.final
              ? " (session still open: latest price, not the final close)"
              : "";
        const summary =
          `${c.symbol}${c.name ? ` (${c.name})` : ""} close on ${c.date}: ${c.close} ${c.currency ?? ""}`.trim() +
          note;
        console.log(`tool get_close_price: ok (${Date.now() - started} ms)`);
        return {
          content: [
            { type: "text", text: summary },
            { type: "text", text: JSON.stringify(c, null, 2) },
          ],
        };
      } catch (e) {
        console.log(`tool get_close_price: error (${Date.now() - started} ms)`);
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to get close price for "${symbol}" on ${date}: ${(e as Error).message}` },
          ],
        };
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

const unauthorized = () =>
  new Response("Unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" || pathname === "/healthz") return new Response("ok\n");
    if (pathname === "/") return new Response("Stocks MCP server. Use /mcp.\n");
    if (pathname !== "/mcp") return new Response("Not found\n", { status: 404 });

    // Verify the Cloudflare Access JWT (src/access.ts) before serving MCP.
    const config = accessConfig(env);
    if (!config) {
      return new Response(
        "Server is missing its Cloudflare Access settings (CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD).\n",
        { status: 500 },
      );
    }
    const token = accessToken(request);
    if (!token) {
      console.warn("access denied: no Cloudflare Access token");
      return unauthorized();
    }
    try {
      await verifyAccessJwt(token, config);
    } catch (e) {
      console.warn(`access denied: ${e instanceof Error ? e.message : e}`);
      return unauthorized();
    }

    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler<AccessEnv>;
