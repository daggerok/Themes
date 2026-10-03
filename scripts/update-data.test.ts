/// <reference types="bun" />

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTROL_NAMES,
  HttpError,
  PROXY_PREFIX,
  PROXY_SLEEP_MS,
  createProxyGate,
  main,
  parseThemesCatalogMarkdown,
  proxyEligible,
  resetIssuerState,
  retainedLabel,
  stripProxyPreamble,
  calculateReturn,
  createRequestGate,
  installSystemCa,
  isCertError,
  deriveReturns,
  formatDividendFrequency,
  inferDistributionFrequency,
  parseAumRange,
  parseCsv,
  parseNportXml,
  parseRange,
  parseThemesCatalog,
  parseThemesHoldingsCsv,
  parseYahooChart,
  readConfig,
  resolveControls,
  runtimeControls,
  yahooChartUrl,
  samePublishedContent,
  stableStringify,
  RETURNS_BASIS,
  performanceFields,
  withPerformanceFields,
  emptyMetrics,
  fetchOfficialText,
  fetchWithRetry,
  isFlatHistory,
  rotateFromCursor,
  skeletonEntry,
  trailingDividendYield,
} from './update-data.ts';

describe('Themes catalog parser', () => {
  const catalogFixture = `
    <script>
      window.productsData = [
        {
          ticker: 'BOTT',
          externalLink: false,
          fund: "Humanoid Robotics ETF",
          category: "Thematic",
          nav: '42.61',
          price: '42.62',
          expense: '0.35',
          product_url: 'https://themesetfs.com/etfs/bott',
          product_factsheet: 'https://themesetfs.com/documents/BOTT.pdf'
        },
        {
          ticker: 'OUTSIDE',
          externalLink: true,
          fund: "External product",
          category: "Other",
          nav: '1.00',
          price: '1.00',
          expense: '0.00',
          product_url: 'https://example.invalid/etfs/outside'
        }
      ];
    </script>`;

  test('selects first-party products and keeps official catalog values', () => {
    const funds = parseThemesCatalog(catalogFixture);
    expect(funds).toEqual([{
      ticker: 'BOTT',
      name: 'Humanoid Robotics ETF',
      category: 'Thematic',
      navValue: 42.61,
      closePriceValue: 42.62,
      terValue: 0.35,
      fundPage: 'https://themesetfs.com/etfs/bott',
      factsheet: 'https://themesetfs.com/documents/BOTT.pdf',
      prospectus: undefined,
    }]);
  });

  test('returns an empty list when the embedded catalog is absent', () => {
    expect(parseThemesCatalog('<html><body>no catalog</body></html>')).toEqual([]);
  });
});

describe('CSV and official holdings parsing', () => {
  const holdingsFixture = `id,date,account,stock_ticker,cusip,security_name,shares,price,market_value,weightings,net_assets,shares_outstanding,creation_units,money_market_flag,country_code,country_full,sector\n1,2026-09-29,BOTT,"002747 C2",BFCCQJ9,"Estun, Automation Co Ltd",263600.000000,28.450000,1117198.74,1.70,65732424.000000,1580000,158.0000,0,CH,China,Industrials\n2,2026-09-29,BOTT,"056080 KS",6421876,"Yujin Robot Co Ltd",385585.000000,11810.000000,3336698.19,5.08,65732424.000000,1580000,158.0000,1,SK,Korea,"Consumer Cyclicals"\n`;

  test('handles quoted commas, CR/LF cells, and escaped CSV values', () => {
    expect(parseCsv('a,b\r\n"one, two","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['one, two', 'say "hi"'],
    ]);
  });

  test('maps official Themes CSV fields into the shared holdings sheet schema', () => {
    const parsed = parseThemesHoldingsCsv(holdingsFixture);
    expect(parsed.asOf).toBe('2026-09-29');
    expect(parsed.netAssets).toBe(65_732_424);
    expect(parsed.sharesOutstanding).toBe(1_580_000);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      Name: 'Estun, Automation Co Ltd',
      Ticker: '002747 C2',
      Identifier: 'BFCCQJ9',
      Weight: '1.70%',
      'Market Value': '$1117198.74',
      'Shares Held': '263,600',
      'Asset Category': 'Industrials',
    });
    expect(parsed.rows[1]['Asset Category']).toBe('Money Market');
  });

  test('returns a safe empty result for header-only data', () => {
    expect(parseThemesHoldingsCsv('date,security_name\n')).toEqual({
      asOf: null,
      netAssets: null,
      sharesOutstanding: null,
      rows: [],
    });
  });
});

describe('Yahoo parser and derived metrics', () => {
  const chartFixture = {
    chart: {
      result: [{
        timestamp: [1_704_067_200, 1_704_153_600],
        indicators: {
          quote: [{ close: [100.004, 110.005], volume: [0, 1234] }],
          adjclose: [{ adjclose: [100.004, 109.995] }],
        },
        events: { dividends: { '1704067200': { amount: 0.25 }, '1704153600': { amount: 0 } } },
        meta: { fullExchangeName: 'NYSEArca' },
      }],
    },
  };

  test('rounds adjusted close values and preserves zero volume', () => {
    const parsed = parseYahooChart(chartFixture);
    expect(parsed.exchange).toBe('NYSEArca');
    expect(parsed.history).toEqual([
      { date: '2024-01-02', close: 110.01, adjClose: 110, volume: 1234 },
      { date: '2024-01-01', close: 100, adjClose: 100, volume: 0 },
    ]);
    expect(parsed.dividends).toEqual([{ date: '2024-01-01', amount: 0.25 }]);
  });

  test('calculates zero, negative, and positive returns without coercing missing prices', () => {
    const history = [
      { date: '2025-01-03', close: 110, adjClose: 110, volume: 1 },
      { date: '2025-01-02', close: 100, adjClose: 100, volume: 1 },
      { date: '2024-12-31', close: 100, adjClose: 100, volume: 1 },
      { date: '2024-01-02', close: 120, adjClose: 120, volume: 1 },
    ];
    expect(calculateReturn(history, new Date('2025-01-02T00:00:00Z'))).toBe(10);
    expect(calculateReturn(history, new Date('2024-01-02T00:00:00Z'))).toBe(-8.33);
    const returns = deriveReturns(history, new Date('2025-01-03T00:00:00Z'));
    expect(returns.ytd).toBe(10);
    expect(returns.yr1).toBe(-8.33);
  });
});

describe('returns never fall back to since-inception numbers', () => {
  const NOW = new Date('2026-10-02T00:00:00Z');
  const daily = (days: number, step = 0.01): Array<{ date: string; close: number; adjClose: number; volume: number }> =>
    Array.from({ length: days }, (_, i) => {
      const date = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      const price = Math.round((100 + (days - i) * step) * 100) / 100;
      return { date, close: price, adjClose: price, volume: 1000 };
    });

  test('a 200-day fund has 1Y/3Y/5Y/10Y and CAGR as null, not since-inception values', () => {
    const returns = deriveReturns(daily(200), NOW);
    for (const key of ['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'cagr3', 'cagr5', 'cagr10']) expect(returns[key]).toBeNull();
  });

  test('a 4-year history fills 1Y and 3Y but leaves 5Y and 10Y null; a long history fills all', () => {
    const four = deriveReturns(daily(365 * 4 + 5), NOW);
    expect(four.yr1).not.toBeNull();
    expect(four.yr3).not.toBeNull();
    expect(four.cagr3).not.toBeNull();
    expect(four.yr5).toBeNull();
    expect(four.yr10).toBeNull();
    expect(four.cagr10).toBeNull();
    const long = deriveReturns(daily(365 * 11), NOW);
    for (const key of ['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'cagr3', 'cagr5', 'cagr10']) expect(long[key]).not.toBeNull();
    expect(long.yr10).not.toBe(long.yr5);
  });

  test('the oldest row may start a few days after the window, not weeks', () => {
    const history = daily(40);
    expect(calculateReturn(history, new Date(NOW.getTime() - 43 * 86_400_000))).not.toBeNull();
    expect(calculateReturn(history, new Date(NOW.getTime() - 60 * 86_400_000))).toBeNull();
  });

  test('flat placeholder history gives null returns and a null yield', () => {
    const flat = Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-${String(28 - i).padStart(2, '0')}`, close: 38.34, adjClose: 38.34, volume: 0 }));
    expect(isFlatHistory(flat)).toBe(true);
    const returns = deriveReturns(flat, NOW);
    for (const value of Object.values(returns)) expect(value).toBeNull();
    expect(isFlatHistory(daily(5))).toBe(false);
    expect(trailingDividendYield([], 20, NOW)).toBeNull();
    expect(trailingDividendYield([{ date: '2020-01-01', amount: 1 }], 20, NOW)).toBeNull();
    expect(trailingDividendYield([{ date: '2026-09-01', amount: 1 }], 20, NOW)).toBe(5);
  });

  test('HISTORY_RANGE=1y leaves 3Y/5Y/10Y null instead of repeating the 1Y return', () => {
    const returns = deriveReturns(daily(366), NOW);
    expect(returns.yr1).not.toBeNull();
    expect(returns.yr3).toBeNull();
    expect(returns.yr5).toBeNull();
    expect(returns.yr10).toBeNull();
  });
});

describe('skeleton rows and cursor', () => {
  test('a catalog-only row has dataFile null and the full metrics key set', () => {
    const row = skeletonEntry({ ticker: 'DRGN', name: 'Dragon', category: 'Thematic', navValue: 20, closePriceValue: 20.1, terValue: 0.5, fundPage: 'https://themesetfs.com/etfs/drgn' }) as any;
    expect(row.dataFile).toBeNull();
    expect(Object.keys(row.metrics).sort()).toEqual(Object.keys(emptyMetrics()).sort());
    for (const key of ['distributionYield', 'distributionYieldText', 'dividendYield', 'dividendYieldText', 'yield12M', 'yield12MText', 'secYieldText', 'returnsBasis', 'performanceAsOf']) expect(key in row.metrics).toBe(true);
    expect(row.metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(Object.values(row.metrics).filter((value) => value === 0)).toEqual([]);
  });

  test('the cursor wraps inside the filtered set and survives a stale cursor', () => {
    const set = ['A', 'B', 'C', 'D'].map((ticker) => ({ ticker }));
    expect(rotateFromCursor(set, null).map((f) => f.ticker)).toEqual(['A', 'B', 'C', 'D']);
    expect(rotateFromCursor(set, 'B').map((f) => f.ticker)).toEqual(['C', 'D', 'A', 'B']);
    expect(rotateFromCursor(set, 'D').map((f) => f.ticker)).toEqual(['A', 'B', 'C', 'D']);
    expect(rotateFromCursor(set, 'BB').map((f) => f.ticker)).toEqual(['C', 'D', 'A', 'B']);
    expect(rotateFromCursor(set, 'Z').map((f) => f.ticker)).toEqual(['A', 'B', 'C', 'D']);
    expect(rotateFromCursor([], 'A')).toEqual([]);
  });
});

describe('fetch timeout and proxy identity', () => {
  const quiet = { maxRetries: 1, requestSleepMs: 0, verbose: false, fetchTimeoutMs: 40 };

  test('a request that never answers times out and is retried, body stalls included', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_url: any, init?: RequestInit) => {
      calls += 1;
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof fetch;
    try {
      await expect(fetchWithRetry('https://x.test/a', {}, quiet)).rejects.toBeDefined();
      expect(calls).toBe(2);
      calls = 0;
      globalThis.fetch = ((_url: any, init?: RequestInit) => {
        calls += 1;
        const body = new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)); } });
        return Promise.resolve(new Response(body));
      }) as typeof fetch;
      await expect(fetchWithRetry('https://x.test/b', {}, quiet, undefined, (response) => response.text())).rejects.toBeDefined();
      expect(calls).toBe(2);
    } finally { globalThis.fetch = realFetch; }
  }, 10_000);

  test('the proxy never receives the SEC contact', async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; ua: string }> = [];
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      seen.push({ url: String(url), ua: String((init?.headers as Record<string, string>)['User-Agent']) });
      return String(url).startsWith(PROXY_PREFIX) ? new Response('Markdown Content:\nok') : new Response('no', { status: 403 });
    }) as typeof fetch;
    resetIssuerState();
    try {
      const config = { ...readConfig({}), maxRetries: 1, requestSleepMs: 0, secUserAgent: 'daggerok ETF feed daggerok@gmail.com' };
      const result = await fetchOfficialText('https://themesetfs.com/etfs', config, async () => {}, async () => {}, () => true);
      expect(result.via).toBe('proxy');
      const proxied = seen.filter((call) => call.url.startsWith(PROXY_PREFIX));
      expect(proxied.length).toBe(1);
      for (const call of seen) expect(call.ua).not.toContain('@');
    } finally { globalThis.fetch = realFetch; resetIssuerState(); }
  });
});

describe('metrics returnsBasis and performanceAsOf (STANDARD 9a)', () => {
  test('performanceFields gives a non-empty basis and an ISO date or null', () => {
    expect(performanceFields('2026-09-30')).toEqual({ returnsBasis: RETURNS_BASIS, performanceAsOf: '2026-09-30' });
    for (const bad of [null, undefined, '', 'Sep 30, 2026', '2026-9-30', 5]) expect(performanceFields(bad).performanceAsOf).toBeNull();
    expect(RETURNS_BASIS.trim().length).toBeGreaterThan(3);
    expect(RETURNS_BASIS).not.toMatch(/^-$|<[^>]*>/);
  });

  test('withPerformanceFields keeps the two fields last and replaces stale values', () => {
    const metrics = withPerformanceFields({ ytd: 1, returnsBasis: 'old', performanceAsOf: 'x', secYield: null }, '2026-09-30');
    expect(Object.keys(metrics)).toEqual(['ytd', 'secYield', 'returnsBasis', 'performanceAsOf']);
    expect(metrics.performanceAsOf).toBe('2026-09-30');
    expect(Object.keys(withPerformanceFields(undefined, null))).toEqual(['returnsBasis', 'performanceAsOf']);
  });
});

describe('distribution frequency display rule', () => {
  test('uses the requested None fallback and preserves explicit Unknown', () => {
    expect(formatDividendFrequency(null)).toBe('00 - None');
    expect(formatDividendFrequency(undefined)).toBe('00 - None');
    expect(formatDividendFrequency('')).toBe('00 - None');
    expect(formatDividendFrequency('  ')).toBe('00 - None');
    expect(formatDividendFrequency('—')).toBe('00 - None');
    expect(formatDividendFrequency('--')).toBe('00 - None');
    expect(formatDividendFrequency('Unknown')).toBe('00 - Unknown');
  });

  test('formats known frequency labels and infers a quarterly cadence', () => {
    expect(formatDividendFrequency('Monthly')).toBe('01 - Monthly');
    expect(formatDividendFrequency('Quarterly')).toBe('04 - Quarterly');
    expect(inferDistributionFrequency([
      { date: '2025-01-15', amount: 0.1 },
      { date: '2025-04-15', amount: 0.1 },
      { date: '2025-07-15', amount: 0.1 },
    ], new Date('2025-09-01T00:00:00Z'))).toBe('04 - Quarterly');
  });
});

describe('SEC N-PORT fallback parser', () => {
  test('extracts a literal N-PORT holding without an HTTP request', () => {
    const parsed = parseNportXml(`<edgarSubmission><seriesName>Themes Humanoid Robotics ETF</seriesName><repPdDate>2026-06-30</repPdDate><totNetAssets>1000000</totNetAssets><invstOrSec><name>Example Robotics Inc</name><ticker>ROBO</ticker><cusip>123456789</cusip><balance>500</balance><valUSD>25000</valUSD><pctVal>2.5</pctVal><assetCat>Common Stock</assetCat></invstOrSec></edgarSubmission>`);
    expect(parsed.seriesName).toBe('Themes Humanoid Robotics ETF');
    expect(parsed.asOf).toBe('2026-06-30');
    expect(parsed.netAssets).toBe(1_000_000);
    expect(parsed.rows[0]).toEqual({
      Name: 'Example Robotics Inc',
      Ticker: 'ROBO',
      Identifier: '123456789',
      Weight: '2.50%',
      'Market Value': '$25000.00',
      'Shares Held': '500',
      'Asset Category': 'Common Stock',
    });
  });
});

describe('configuration and deterministic publication', () => {
  test('parses AUM presets and strict numeric ranges', () => {
    expect(parseAumRange('micro')).toEqual({ min: 10e6, max: 300e6 });
    expect(parseAumRange('10M:2B')).toEqual({ min: 10e6, max: 2e9 });
    expect(parseRange('0:0.35', 'TER')).toEqual({ min: 0, max: 0.35 });
    expect(parseRange(':', 'TER')).toBeUndefined();
  });

  test('reads ticker and data-dependent controls from an isolated environment', () => {
    const config = readConfig({
      TICKERS: 'bott, clod AUMI',
      MAX_FETCHES: '3',
      REQUEST_SLEEP: '1',
      CONCURRENCY: '2',
      DIVIDEND_YIELD: '0:5',
      TOTAL_RETURN_1Y: '-100:100',
    });
    expect([...config.tickers]).toEqual(['BOTT', 'CLOD', 'AUMI']);
    expect(config.maxFetches).toBe(3);
    expect(config.dividendYieldRange).toEqual({ min: 0, max: 5 });
    expect(config.totalReturnRanges['1Y']).toEqual({ min: -100, max: 100 });
  });

  test('sorts publication keys and ignores only timestamp churn for idempotency', () => {
    const first = { generatedAt: '2026-09-29T00:00:00Z', nested: { catalogReadAt: 'a', beta: 2, alpha: 1 } };
    const sameDataLater = { generatedAt: '2026-09-30T00:00:00Z', nested: { catalogReadAt: 'b', alpha: 1, beta: 2 } };
    const changed = { generatedAt: '2026-09-30T00:00:00Z', nested: { alpha: 1, beta: 3 } };
    expect(samePublishedContent(first, sameDataLater)).toBe(true);
    expect(samePublishedContent(first, changed)).toBe(false);
    expect(stableStringify({ z: 1, a: { b: 2, a: 1 } })).toBe('{\n  "a": {\n    "a": 1,\n    "b": 2\n  },\n  "z": 1\n}\n');
  });
});

describe('independent paced request lanes', () => {
  test('reserves a later start only after all available lanes are occupied', async () => {
    const gate = createRequestGate(2, 20);
    const began = Date.now();
    await Promise.all([gate(), gate(), gate()]);
    expect(Date.now() - began).toBeGreaterThanOrEqual(15);
  });
});

describe('403 -> read-only proxy and retained data', () => {
  const catalogMarkdown = `Title: Our ETFs

URL Source: https://themesetfs.com/etfs

Markdown Content:
| Ticker | Fund Name | Category | NAV | Market Price* | Expense Ratio | Factsheet | Prospectus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [AALG](https://leverageshares.com/us/etfs/x/)[AALG](https://leverageshares.com/us/etfs/x/) | [2x Long AAL](https://leverageshares.com/us/etfs/x/) | Leveraged | $1.00 | $1.00 | 1.15% | [](https://leverageshares.com/f.pdf) | [](https://leverageshares.com/p.pdf) |
| [BOTT](https://themesetfs.com/etfs/bott)[BOTT](https://themesetfs.com/etfs/bott) | [Humanoid Robotics ETF](https://themesetfs.com/etfs/bott) | Thematic | $41.76 | $42.05 | 0.35% | [](https://themesetfs.com/documents/BOTT.pdf) | [](https://themesetfs.com/documents/BOTT-P.pdf) |
`;
  const csv = 'date,stock_ticker,cusip,security_name,shares,market_value,weightings,net_assets,shares_outstanding,sector\n2026-10-01,AAA,111,Alpha Corp,10,500,50,1000,100,Tech\n2026-10-01,BBB,222,Beta Corp,10,500,50,1000,100,Tech\n';

  test('parses the proxied markdown catalog table and keeps first-party rows only', () => {
    const funds = parseThemesCatalogMarkdown(stripProxyPreamble(catalogMarkdown));
    expect(funds).toEqual([{
      ticker: 'BOTT', name: 'Humanoid Robotics ETF', category: 'Thematic', navValue: 41.76, closePriceValue: 42.05, terValue: 0.35,
      fundPage: 'https://themesetfs.com/etfs/bott', factsheet: 'https://themesetfs.com/documents/BOTT.pdf', prospectus: 'https://themesetfs.com/documents/BOTT-P.pdf',
    }]);
    expect(parseThemesCatalogMarkdown('no table here')).toEqual([]);
  });

  test('proxy gate serializes starts; eligibility covers 403 / 429 / 5xx only', async () => {
    expect(PROXY_SLEEP_MS).toBe(3200);
    const gate = createProxyGate(40);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(async () => { await gate(); starts.push(Date.now()); }));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(35);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(35);
    for (const status of [403, 429, 500, 503]) expect(proxyEligible(new HttpError(status))).toBe(true);
    for (const status of [400, 404]) expect(proxyEligible(new HttpError(status))).toBe(false);
    expect(retainedLabel('official CSV')).toBe(retainedLabel(retainedLabel('official CSV')));
  });

  async function inTempRepo(seed: (apiRoot: string) => void, handler: (url: string) => Response, env: Record<string, string>): Promise<{ calls: Array<{ url: string; at: number }>; root: string; error: unknown }> {
    const root = mkdtempSync(path.join(tmpdir(), 'themes-403-'));
    const cwd = process.cwd();
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; at: number }> = [];
    let error: unknown = null;
    mkdirSync(path.join(root, 'api/themes'), { recursive: true });
    seed(path.join(root, 'api/themes'));
    globalThis.fetch = (async (input: RequestInfo | URL) => { const url = String(input); calls.push({ url, at: Date.now() }); return handler(url); }) as typeof fetch;
    const log = console.log; const warn = console.warn; const err = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try {
      process.chdir(root);
      resetIssuerState();
      await main({ REQUEST_SLEEP: '0', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', ...env });
    } catch (caught) { error = caught; }
    finally { process.chdir(cwd); globalThis.fetch = realFetch; console.log = log; console.warn = warn; console.error = err; }
    return { calls, root, error };
  }
  const blocked = (): Response => new Response('Access Denied', { status: 403 });
  const readJsonFile = (root: string, rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

  test('direct 403 on the catalog and the CSV falls back to the proxy and publishes fresh data', async () => {
    const result = await inTempRepo(() => {}, (url) => {
      if (url === `${PROXY_PREFIX}https://themesetfs.com/etfs`) return new Response(catalogMarkdown);
      if (url === `${PROXY_PREFIX}https://themesetfs.com/storage/holdings/Holdings-BOTT.csv`) return new Response(`Title: x\n\nMarkdown Content:\n${csv}`);
      return blocked();
    }, { TICKERS: 'BOTT' });
    try {
      expect(result.error).toBeNull();
      const proxied = result.calls.filter((call) => call.url.startsWith(PROXY_PREFIX));
      expect(proxied.length).toBe(2);
      expect(proxied[1].at - proxied[0].at).toBeGreaterThanOrEqual(PROXY_SLEEP_MS - 50);
      expect(result.calls.filter((call) => !call.url.startsWith(PROXY_PREFIX)).length).toBe(2);
      const meta = readJsonFile(result.root, 'api/themes/funds/BOTT/meta.json');
      expect(meta.holdings.totalRows).toBe(2);
      expect(meta.source.holdingsSource).toContain('via read-only rendering proxy');
      expect(meta.navValue).toBe(41.76);
      expect(meta.source.retained).toBeUndefined();
    } finally { rmSync(result.root, { recursive: true, force: true }); }
  }, 30_000);

  test('official source completely unavailable keeps the published fund data, labeled as retained', async () => {
    const seed = (api: string) => {
      mkdirSync(path.join(api, 'funds/BOTT'), { recursive: true });
      const holdings = { pages: ['001.json'], pageSize: 250, totalRows: 31, asOfDate: '09/30/2026', asOf: '2026-09-30' };
      writeFileSync(path.join(api, 'funds/BOTT/meta.json'), JSON.stringify({ ticker: 'BOTT', navValue: 40, aumValue: 123, holdings, source: { holdingsSource: 'official Themes ETFs daily holdings CSV' } }));
      writeFileSync(path.join(api, 'index.json'), JSON.stringify({ generatedAt: '2026-09-30T00:00:00Z', funds: [{ ticker: 'BOTT', name: 'Humanoid Robotics ETF', category: 'Thematic', navValue: 40, terValue: 0.35, fundPage: 'https://themesetfs.com/etfs/bott', holdings: 31, history: 0 }] }));
    };
    const result = await inTempRepo(seed, () => blocked(), { TICKERS: 'BOTT' });
    try {
      expect(result.error).toBeNull();
      const meta = readJsonFile(result.root, 'api/themes/funds/BOTT/meta.json');
      expect(meta.holdings.totalRows).toBe(31);
      expect(meta.aumValue).toBe(123);
      expect(meta.source.holdingsSource).toContain('retained');
      expect(meta.source.retained.holdings).toBe(true);
      expect(readJsonFile(result.root, 'api/themes/index.json').funds[0].ticker).toBe('BOTT');
      expect(meta.metrics.returnsBasis).toBe(RETURNS_BASIS);
      expect(meta.metrics.performanceAsOf).toBeNull();
      expect(readJsonFile(result.root, 'api/themes/index.json').funds[0].metrics).toEqual(meta.metrics);
    } finally { rmSync(result.root, { recursive: true, force: true }); }
  }, 30_000);

  test('retained history keeps the last Yahoo close date as performanceAsOf', async () => {
    const seed = (api: string) => {
      mkdirSync(path.join(api, 'funds/BOTT'), { recursive: true });
      const holdings = { pages: ['001.json'], pageSize: 250, totalRows: 31, asOfDate: '09/30/2026', asOf: '2026-09-30' };
      const history = { pages: ['001.json'], pageSize: 1000, totalRows: 3, asOfDate: 'Sep 29, 2026', asOf: '2026-09-29' };
      writeFileSync(path.join(api, 'funds/BOTT/meta.json'), JSON.stringify({ ticker: 'BOTT', navValue: 40, aumValue: 123, holdings, history, source: { holdingsSource: 'official Themes ETFs daily holdings CSV' } }));
      mkdirSync(path.join(api, 'funds/CLOD'), { recursive: true });
      writeFileSync(path.join(api, 'funds/CLOD/meta.json'), JSON.stringify({ ticker: 'CLOD', metrics: { ytd: 1 } }));
      writeFileSync(path.join(api, 'index.json'), JSON.stringify({ generatedAt: '2026-09-30T00:00:00Z', funds: [
        { ticker: 'BOTT', name: 'Humanoid Robotics ETF', category: 'Thematic', navValue: 40, terValue: 0.35, fundPage: 'https://themesetfs.com/etfs/bott', holdings: 31, history: 3 },
        { ticker: 'CLOD', name: 'Cloud', category: 'Thematic', metrics: { ytd: 1 }, holdings: 1, history: 1 },
      ] }));
    };
    const result = await inTempRepo(seed, () => blocked(), { TICKERS: 'BOTT' });
    try {
      expect(result.error).toBeNull();
      const meta = readJsonFile(result.root, 'api/themes/funds/BOTT/meta.json');
      expect(meta.metrics.performanceAsOf).toBe('2026-09-29');
      const funds = readJsonFile(result.root, 'api/themes/index.json').funds;
      expect(funds[0].metrics.performanceAsOf).toBe('2026-09-29');
      expect(funds[1].metrics.ytd).toBe(1);
      expect(funds[1].metrics.returnsBasis).toBe(RETURNS_BASIS);
      expect(funds[1].metrics.performanceAsOf).toBeNull();
    } finally { rmSync(result.root, { recursive: true, force: true }); }
  }, 30_000);

  const htmlCatalog = (rows: Array<{ t: string; nav?: string }>): string => `<script>window.productsData = [\n${rows.map((r) => `{\n ticker: '${r.t}',\n externalLink: false,\n fund: "${r.t} ETF",\n category: "Thematic",\n nav: '${r.nav ?? '20.00'}',\n price: '20.10',\n expense: '0.35',\n product_url: 'https://themesetfs.com/etfs/${r.t.toLowerCase()}'\n}`).join(',\n')}\n];</script>`;
  const holdingsCsv = 'date,stock_ticker,cusip,security_name,shares,market_value,weightings,net_assets,shares_outstanding,sector\n2026-10-01,AAA,111,Alpha,10,500,50,1000,100,Tech\n';
  const chartJson = (days: number, flat = false): string => {
    const last = Math.floor(Date.now() / 86_400_000) * 86_400;
    const timestamp = Array.from({ length: days }, (_, i) => last - (days - 1 - i) * 86_400);
    const close = timestamp.map((_, i) => flat ? 38.34 : 20 + i * 0.01);
    const events = Object.fromEntries(timestamp.filter((_, i) => i % 30 === 0 && !flat).map((t) => [String(t), { amount: 0.1 }]));
    return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote: [{ close, volume: close.map(() => (flat ? 0 : 5)) }], adjclose: [{ adjclose: close }] }, events: { dividends: events }, meta: { fullExchangeName: 'NYSEArca' } }] } });
  };
  const feed = (rows: Array<{ t: string; days: number; flat?: boolean; nav?: string }>, extra?: (url: string) => Response | null) => (url: string): Response => {
    const extraResponse = extra?.(url); if (extraResponse) return extraResponse;
    if (url === 'https://themesetfs.com/etfs') return new Response(htmlCatalog(rows));
    const csvMatch = /Holdings-(\w+)\.csv/.exec(url);
    if (csvMatch) return rows.find((r) => r.t === csvMatch[1] && r.days >= 0) && csvMatch[1] !== 'NOHOLD' ? new Response(holdingsCsv) : new Response('gone', { status: 404 });
    const chartMatch = /chart\/(\w+)\?/.exec(url);
    const row = rows.find((r) => r.t === chartMatch?.[1]);
    return row && row.days > 0 ? new Response(chartJson(row.days, row.flat)) : new Response('{}', { status: 404 });
  };
  const live = { SKIP_YAHOO: 'false' };

  test('young and flat funds publish null long-horizon returns, long funds keep them; a catalog-only fund has no dataFile', async () => {
    const rows = [{ t: 'FLT', days: 5, flat: true }, { t: 'NOHOLD', days: 0 }, { t: 'OLD', days: 4300 }, { t: 'YNG', days: 200 }];
    const result = await inTempRepo(() => {}, feed(rows), live);
    try {
      expect(result.error).toBeNull();
      const funds = readJsonFile(result.root, 'api/themes/index.json').funds;
      const by = Object.fromEntries(funds.map((f: any) => [f.ticker, f]));
      for (const key of ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'dividendYield', 'yield12M']) {
        expect(by.FLT.metrics[key]).toBeNull();
      }
      for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y']) expect(by.YNG.metrics[key]).toBeNull();
      expect(by.YNG.metrics.dividendYield).not.toBeNull();
      for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr10y']) expect(by.OLD.metrics[key]).not.toBeNull();
      expect(by.OLD.metrics.tr10y).not.toBe(by.OLD.metrics.tr5y);
      expect(by.NOHOLD.dataFile).toBeNull();
      expect(Object.keys(by.NOHOLD.metrics).sort()).toEqual(Object.keys(emptyMetrics()).sort());
      expect(by.OLD.dataFile).toBe('./funds/OLD/meta.json');
    } finally { rmSync(result.root, { recursive: true, force: true }); }
  }, 30_000);

  test('a rerun with identical upstream data writes nothing, and a new fund is announced', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'themes-rerun-'));
    const summary = path.join(root, 'summary.md');
    const seedRows = [{ t: 'OLD', days: 400 }];
    const first = await inTempRepo(() => {}, feed(seedRows), live);
    try {
      const mtimes = (dir: string): Record<string, number> => Object.fromEntries(
        (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json')).map((f) => [f, statSync(path.join(dir, f)).mtimeMs]));
      const before = mtimes(path.join(first.root, 'api/themes'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const cwd = process.cwd();
      const realFetch = globalThis.fetch; const log = console.log; const lines: string[] = [];
      globalThis.fetch = (async (input: any) => feed(seedRows)(String(input))) as typeof fetch;
      console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
      process.env.GITHUB_STEP_SUMMARY = summary;
      try {
        process.chdir(first.root);
        await main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', ...live });
        expect(Object.entries(mtimes(path.join(first.root, 'api/themes'))).filter(([f, t]) => before[f] !== t)).toEqual([]);
        expect(lines.join('\n')).not.toContain('NEW FUNDS');
        const grown = [...seedRows, { t: 'NEWB', days: 400 }];
        globalThis.fetch = (async (input: any) => feed(grown)(String(input))) as typeof fetch;
        await main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', ...live });
        expect(lines.join('\n')).toContain('NEW FUNDS: NEWB');
        expect(readFileSync(summary, 'utf8')).toContain('NEW FUNDS: NEWB');
      } finally { delete process.env.GITHUB_STEP_SUMMARY; process.chdir(cwd); globalThis.fetch = realFetch; console.log = log; }
    } finally { rmSync(first.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a fund that fails the data filter is left untouched: files and index row stay consistent', async () => {
    const rows = [{ t: 'OLD', days: 400 }];
    const seeded = await inTempRepo(() => {}, feed(rows), { ...live, TICKERS: 'OLD' });
    try {
      const metaBefore = readFileSync(path.join(seeded.root, 'api/themes/funds/OLD/meta.json'), 'utf8');
      const indexBefore = readFileSync(path.join(seeded.root, 'api/themes/index.json'), 'utf8');
      const cwd = process.cwd(); const realFetch = globalThis.fetch; const log = console.log;
      globalThis.fetch = (async (input: any) => feed([{ t: 'OLD', days: 400, nav: '25.00' }])(String(input))) as typeof fetch;
      console.log = () => {};
      try {
        process.chdir(seeded.root);
        await main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', ...live, TICKERS: 'OLD', TOTAL_RETURN_1Y: '900:1000' });
      } finally { process.chdir(cwd); globalThis.fetch = realFetch; console.log = log; }
      expect(readFileSync(path.join(seeded.root, 'api/themes/funds/OLD/meta.json'), 'utf8')).toBe(metaBefore);
      expect(readFileSync(path.join(seeded.root, 'api/themes/index.json'), 'utf8')).toBe(indexBefore);
    } finally { rmSync(seeded.root, { recursive: true, force: true }); }
  }, 30_000);

  test('MAX_FETCHES cursor wraps, and a TICKERS run leaves the cursor state alone', async () => {
    const rows = ['AAA', 'BBB', 'CCC'].map((t) => ({ t, days: 400 }));
    const cursorOf = (root: string): string | null => { try { return readJsonFile(root, 'api/themes/update-state.json').cursor; } catch { return null; } };
    const first = await inTempRepo(() => {}, feed(rows), { ...live, MAX_FETCHES: '2' });
    try {
      expect(cursorOf(first.root)).toBe('BBB');
      const cwd = process.cwd(); const realFetch = globalThis.fetch; const log = console.log;
      globalThis.fetch = (async (input: any) => feed(rows)(String(input))) as typeof fetch;
      console.log = () => {};
      try {
        process.chdir(first.root);
        const run = (env: Record<string, string>) => main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', ...live, ...env });
        await run({ MAX_FETCHES: '2' });
        expect(cursorOf(first.root)).toBe('AAA');
        await run({ MAX_FETCHES: '2', TICKERS: 'CCC' });
        expect(cursorOf(first.root)).toBe('AAA');
        await run({ MAX_FETCHES: '0', TICKERS: 'CCC' });
        expect(cursorOf(first.root)).toBe('AAA');
      } finally { process.chdir(cwd); globalThis.fetch = realFetch; console.log = log; }
    } finally { rmSync(first.root, { recursive: true, force: true }); }
  }, 30_000);

  test('every selected fund failing is a non-zero exit', async () => {
    const result = await inTempRepo(() => {}, feed([{ t: 'NOHOLD', days: 0 }]), live);
    try { expect(String(result.error)).toContain('every selected fund failed'); }
    finally { rmSync(result.root, { recursive: true, force: true }); }
  }, 30_000);

  test('a fund dropped from the official catalog leaves the feed; a much smaller catalog is not trusted', async () => {
    const rows = [{ t: 'AAA', days: 400 }, { t: 'BBB', days: 400 }, { t: 'CCC', days: 400 }];
    const first = await inTempRepo(() => {}, feed(rows), live);
    try {
      const cwd = process.cwd(); const realFetch = globalThis.fetch; const log = console.log; const warn = console.warn;
      console.log = () => {}; console.warn = () => {};
      const run = async (visible: typeof rows) => {
        globalThis.fetch = (async (input: any) => feed(visible)(String(input))) as typeof fetch;
        process.chdir(first.root);
        try { await main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', ...live }); } finally { process.chdir(cwd); }
      };
      try {
        await run(rows.slice(0, 1));
        expect(readJsonFile(first.root, 'api/themes/index.json').funds.map((f: any) => f.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
        await run(rows.slice(0, 2));
        expect(readJsonFile(first.root, 'api/themes/index.json').funds.map((f: any) => f.ticker)).toEqual(['AAA', 'BBB']);
        expect(existsSync(path.join(first.root, 'api/themes/funds/CCC'))).toBe(false);
      } finally { globalThis.fetch = realFetch; console.log = log; console.warn = warn; }
    } finally { rmSync(first.root, { recursive: true, force: true }); }
  }, 30_000);

  test('workers really run in parallel: in-flight peak is 1 at CONCURRENCY=1 and N at N', async () => {
    const rows = ['AAA', 'BBB', 'CCC', 'DDD'].map((t) => ({ t, days: 30 }));
    const peakFor = async (concurrency: number): Promise<number> => {
      let inFlight = 0; let peak = 0;
      const root = mkdtempSync(path.join(tmpdir(), 'themes-peak-'));
      mkdirSync(path.join(root, 'api/themes'), { recursive: true });
      const cwd = process.cwd(); const realFetch = globalThis.fetch; const log = console.log;
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        if (!/Holdings-/.test(url)) return feed(rows)(url);
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 60));
        inFlight -= 1;
        return feed(rows)(url);
      }) as typeof fetch;
      console.log = () => {};
      try { process.chdir(root); resetIssuerState(); await main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', SKIP_YAHOO: 'true', CONCURRENCY: String(concurrency) }); }
      finally { process.chdir(cwd); globalThis.fetch = realFetch; console.log = log; rmSync(root, { recursive: true, force: true }); }
      return peak;
    };
    expect(await peakFor(1)).toBe(1);
    expect(await peakFor(4)).toBe(4);
  }, 30_000);

  test('fails loudly when nothing is reachable and nothing was published', async () => {
    const result = await inTempRepo(() => {}, () => blocked(), { TICKERS: 'BOTT' });
    try { expect(String(result.error)).toContain('nothing published to retain'); }
    finally { rmSync(result.root, { recursive: true, force: true }); }
    const noMeta = await inTempRepo((api) => {
      writeFileSync(path.join(api, 'index.json'), JSON.stringify({ funds: [{ ticker: 'BOTT', name: 'B', category: 'Thematic', fundPage: 'https://themesetfs.com/etfs/bott' }] }));
    }, () => blocked(), { TICKERS: 'BOTT' });
    try { expect(String(noMeta.error)).toContain('nothing could be refreshed'); }
    finally { rmSync(noMeta.root, { recursive: true, force: true }); }
  }, 30_000);
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));

test('precedence: file < advanced < nonblank input < env, blank input inherits', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'BOTT' }, { CONCURRENCY: 3, TICKERS: 'CLOD' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
  expect(c.CONCURRENCY).toBe('5');
  expect(c.TICKERS).toBe('CLOD');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  // advanced may deliberately blank a control; a blank named input cannot
  expect(resolveControls({ TICKERS: 'BOTT' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  expect(readConfig(resolveControls({ MAX_RETRIES: 2 })).maxRetries).toBe(2);
  // an explicitly set empty env var wins and clears the control
  expect(resolveControls({ TICKERS: 'BOTT' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
});

test('scheduled path (empty inputs and advanced) equals config defaults', () => {
  const defaults = file();
  const scheduled = resolveControls(defaults, JSON.parse('{}'), {}, {});
  expect(scheduled).toEqual(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])));
});

test('resolver rejects invalid JSON shapes, unknown keys, non-scalars and newlines', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['BOTT'] }, { TICKERS: {} }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: 'a\nb' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => JSON.parse('{not json')).toThrow();
});

test('provider defaults and runtime resolution', async () => {
  const config = readConfig(resolveControls(file()));
  expect(config.tickers.size).toBe(0);
  expect(config.maxFetches).toBe(0);
  expect(config.requestSleepMs).toBe(1000);
  expect(config.concurrency).toBe(2);
  expect(config.maxRetries).toBe(3);
  expect(config.holdingsPageSize).toBe(250);
  expect(config.historyPageSize).toBe(1000);
  expect(config.historyRange).toBe('max');
  expect(config.edgarFallback).toBe(true);
  expect(config.skipYahoo).toBe(false);
  expect(config.skipThemes).toBe(false);
  expect(config.secUserAgent).toBe('daggerok ETF feed daggerok@gmail.com');
  const runtime = await runtimeControls({ TICKERS: 'BOTT', UNRELATED: 'x' });
  expect(runtime.TICKERS).toBe('BOTT');
  expect(runtime.CONCURRENCY).toBe('2');
});

test('config keys, CONTROL_NAMES, README rows and --help stay in sync', () => {
  const keys = Object.keys(file());
  expect(keys.sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file())) expect(typeof value).toBe('string');
  const doc = read('README.md');
  // README lists the five tenors of PERFORMANCE_* / TOTAL_RETURN_* on one row
  for (const name of CONTROL_NAMES) expect(doc).toContain('`' + name + '`');
  expect(doc).toContain('scripts/update-data.config.json');
  const source = read('scripts/update-data.ts');
  expect(source).toContain('${CONTROL_NAMES.join(');
  expect(source).toContain('HISTORY_RANGE: max or Ny');
});

test('workflow: <= 25 inputs, advanced JSON, fixed output dir, no direct inputs interpolation', () => {
  const yml = read('.github/workflows/update-data.yml');
  const block = yml.slice(yml.indexOf('    inputs:'), yml.indexOf('\npermissions:'));
  const names = [...block.matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBeLessThanOrEqual(25);
  expect(names).toContain('advanced');
  expect(block).toMatch(/advanced:[\s\S]*?default: '\{\}'/);
  const individual = names.filter((name) => name !== 'advanced');
  expect(new Set(individual).size).toBe(individual.length);
  for (const name of individual) expect(CONTROL_NAMES as readonly string[]).toContain(name.toUpperCase());
  expect(yml).toContain("cron: '0 0 * * 0'");
  expect(yml).toContain('toJSON(inputs)');
  expect(yml).not.toMatch(/\$\{\{\s*inputs\./);
  expect(CONTROL_NAMES as readonly string[]).not.toContain('OUTPUT_DIR');
  expect(yml).toContain('git add api/themes\n');
  expect(yml).toContain('git diff --cached --quiet -- api/themes');
  expect(yml.match(/git add /g)?.length).toBe(1);
  expect(yml).toContain('if: ${{ !cancelled() }}');
  expect(yml).toContain('cancel-in-progress: false');
  expect(yml).not.toMatch(/^\s{4}permissions:/m);
  expect(yml).not.toContain('bunx tsc');
});

test('every control stays reachable: individual input or advanced JSON', () => {
  const yml = read('.github/workflows/update-data.yml');
  const individual = new Set([...yml.matchAll(/^      (\w+):$/gm)].map((m) => m[1].toUpperCase()));
  const viaAdvanced = CONTROL_NAMES.filter((name) => !individual.has(name));
  for (const name of viaAdvanced) expect(() => resolveControls(file(), { [name]: file()[name] })).not.toThrow();
  expect(viaAdvanced.sort()).toEqual(['HISTORY_RANGE', 'SEC_UA', 'SEC_YIELD', 'USE_SYSTEM_CA', 'VERBOSE']);
});

test('workflow lets only the protected SEC_UA variable override and writes only api/themes', () => {
  const yml = read('.github/workflows/update-data.yml');
  expect(yml).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
  expect(yml).toContain('timeout-minutes: 30');
  expect(yml).toContain('persist-credentials: false');
  expect(file().SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
});

test('HISTORY_RANGE limits the Yahoo request window', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  expect(yahooChartUrl('bott', 'max', now)).toContain('period1=0&period2=9999999999');
  const url = yahooChartUrl('BOTT', '3y', now);
  expect(url).toContain(`period1=${Math.floor(new Date('2023-06-15T00:00:00Z').getTime() / 1000)}`);
  expect(url).toContain(`period2=${Math.floor(now.getTime() / 1000)}`);
  expect(readConfig(resolveControls({ HISTORY_RANGE: '5Y' })).historyRange).toBe('5y');
});

test('README: section order, Themes-only API paths, no work-log leftovers', () => {
  const readme = read('README.md');
  const headings = [...readme.matchAll(/^#{1,3} .+$/gm)].map((m) => m[0]);
  const order = ['# Themes ETFs', '## Using Bun', '## Updating the static Themes ETFs data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
  expect(headings.filter((h) => order.includes(h))).toEqual(order);
  expect(readme).toContain('`./api/themes`');
  expect(readme).not.toContain('`./api/neos`');
  expect(readme).not.toMatch(/worklog|config-docs|ui-parity|evidence|fixtures/i);
  expect(readme).toContain('Themes ETF Trust **CIK 0001976322**');
  expect(readme).toContain('`returnsBasis`');
  expect(readme).toContain('`performanceAsOf`');
});

describe('system CA support', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const certError = () => Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
  const neverReexec = (): never => { throw new Error('unexpected reexec'); };

  test('USE_SYSTEM_CA resolves auto by default and accepts true/false case-insensitively', () => {
    expect(resolveControls(file()).USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'TRUE', 'False']) expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    expect(() => resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow(/USE_SYSTEM_CA/);
  });

  test('isCertError matches certificate failures, also through cause', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: certError() }))).toBe(true);
    expect(isCertError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isCertError(new HttpError(403))).toBe(false);
  });

  test('installSystemCa leaves fetch alone for false or an already active store', () => {
    installSystemCa('false', neverReexec, false);
    expect(globalThis.fetch).toBe(realFetch);
    installSystemCa('auto', neverReexec, true);
    expect(globalThis.fetch).toBe(realFetch);
  });

  test('mode true restarts immediately', () => {
    let calls = 0;
    const reexec = (): never => { calls += 1; throw new Error('reexec'); };
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    expect(calls).toBe(1);
  });

  test('mode auto restarts once on a cert error, rethrows others and passes responses through', async () => {
    let calls = 0;
    const reexec = (): never => { calls += 1; throw new Error('reexec'); };
    globalThis.fetch = (async () => { throw certError(); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid/')).rejects.toThrow('reexec');
    expect(calls).toBe(1);

    globalThis.fetch = (async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid/')).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(1);

    globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    expect(await (await fetch('https://example.invalid/')).text()).toBe('ok');
    expect(calls).toBe(1);
  });
});
