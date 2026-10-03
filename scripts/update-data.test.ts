/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTROL_NAMES, HttpError, PROXY_PREFIX, PROXY_SLEEP_MS, RETURNS_BASIS,
  calculateReturn, createProxyGate, createRequestGate, deriveReturns, emptyMetrics, fetchOfficialText, fetchWithRetry,
  formatDividendFrequency, inferDistributionFrequency, installSystemCa, isCertError, isFlatHistory, main, parseAumRange,
  parseCsv, parseNportXml, parseRange, parseThemesCatalog, parseThemesCatalogMarkdown, parseThemesHoldingsCsv,
  parseYahooChart, performanceFields, proxyEligible, readConfig, resetIssuerState, resolveControls, retainedLabel,
  rotateFromCursor, runtimeControls, samePublishedContent, skeletonEntry, stableStringify, stripProxyPreamble,
  trailingDividendYield, withPerformanceFields, yahooChartUrl,
} from './update-data.ts';

// ---------------------------------------------------------------------------
// Shared setup: clean environment, pinned TZ, restored fetch / cwd / exit code / console / clock
// ---------------------------------------------------------------------------
const scriptsDir = new URL('.', import.meta.url).pathname;
const file = JSON.parse(readFileSync(path.join(scriptsDir, 'update-data.config.json'), 'utf8')) as Record<string, string>;
const realFetch = globalThis.fetch;
const realCwd = process.cwd();
const realExitCode = process.exitCode;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;
const savedEnv = { ...process.env };
const tempDirs: string[] = [];
const isControlVar = (key: string): boolean =>
  (CONTROL_NAMES as readonly string[]).includes(key) || key.startsWith('THEMES_') || ['HISTORICAL_PAGE_SIZE', 'NODE_USE_SYSTEM_CA', 'ETF_UPDATER_SYSTEM_CA', 'GITHUB_STEP_SUMMARY'].includes(key);

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (isControlVar(key)) delete process.env[key];
  process.env.TZ = 'UTC';
});
afterEach(() => {
  process.chdir(realCwd);
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Date.now = realNow;
  process.exitCode = realExitCode ?? 0;
  Object.assign(console, realConsole);
  resetIssuerState();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake clock: Date.now and setTimeout advance together, so paced waits are exact and instant. */
function fakeClock(): { waits: number[]; now: () => number } {
  let clock = 1_800_000_000_000;
  const waits: number[] = [];
  Date.now = () => clock;
  globalThis.setTimeout = ((callback: () => void, ms = 0) => { waits.push(ms); clock += ms; return realSetTimeout(callback, 0); }) as unknown as typeof setTimeout;
  return { waits, now: () => clock };
}

// ---------------------------------------------------------------------------
// Small inline samples (no fixture files)
// ---------------------------------------------------------------------------
const catalogHtml = `<script>window.productsData = [
  { ticker: 'BOTT', externalLink: false, fund: "Humanoid Robotics ETF", category: "Thematic", nav: '42.61', price: '42.62', expense: '0.35',
    product_url: 'https://themesetfs.com/etfs/bott', product_factsheet: 'https://themesetfs.com/documents/BOTT.pdf' },
  { ticker: 'OUTSIDE', externalLink: true, fund: "External product", category: "Other", nav: '1.00', price: '1.00', expense: '0.00', product_url: 'https://example.invalid/etfs/outside' }
];</script>`;
const catalogMarkdown = `Title: Our ETFs

URL Source: https://themesetfs.com/etfs

Markdown Content:
| Ticker | Fund Name | Category | NAV | Market Price* | Expense Ratio | Factsheet | Prospectus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [AALG](https://leverageshares.com/us/etfs/x/)[AALG](https://leverageshares.com/us/etfs/x/) | [2x Long AAL](https://leverageshares.com/us/etfs/x/) | Leveraged | $1.00 | $1.00 | 1.15% | [](https://leverageshares.com/f.pdf) | [](https://leverageshares.com/p.pdf) |
| [BOTT](https://themesetfs.com/etfs/bott)[BOTT](https://themesetfs.com/etfs/bott) | [Humanoid Robotics ETF](https://themesetfs.com/etfs/bott) | Thematic | $41.76 | $42.05 | 0.35% | [](https://themesetfs.com/documents/BOTT.pdf) | [](https://themesetfs.com/documents/BOTT-P.pdf) |
`;
const holdingsFixture = `id,date,account,stock_ticker,cusip,security_name,shares,price,market_value,weightings,net_assets,shares_outstanding,creation_units,money_market_flag,country_code,country_full,sector\n1,2026-09-29,BOTT,"002747 C2",BFCCQJ9,"Estun, Automation Co Ltd",263600.000000,28.450000,1117198.74,1.70,65732424.000000,1580000,158.0000,0,CH,China,Industrials\n2,2026-09-29,BOTT,"056080 KS",6421876,"Yujin Robot Co Ltd",385585.000000,11810.000000,3336698.19,5.08,65732424.000000,1580000,158.0000,1,SK,Korea,"Consumer Cyclicals"\n`;
const NOW = new Date('2026-10-02T00:00:00Z');
const daily = (days: number, step = 0.01): Array<{ date: string; close: number; adjClose: number; volume: number }> =>
  Array.from({ length: days }, (_, i) => {
    const date = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const price = Math.round((100 + (days - i) * step) * 100) / 100;
    return { date, close: price, adjClose: price, volume: 1000 };
  });

// ===========================================================================
describe('controls', () => {
  test('precedence: file < advanced < nonblank input < env; blank input inherits, advanced and explicit-empty env clear', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'BOTT' }, { CONCURRENCY: 3, TICKERS: 'CLOD' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
    expect([c.CONCURRENCY, c.TICKERS]).toEqual(['5', 'CLOD']);
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ TICKERS: 'BOTT' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'BOTT' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  });

  test('strict validation: bad ranges, HISTORY_RANGE, MAX_RETRIES < 1, unknown keys, non-scalars, CR/LF/NUL', () => {
    for (const value of [
      { UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\rfoo' }, { SEC_UA: 'x\0bad' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 },
      { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' },
      { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['BOTT'] }, { TICKERS: {} }, null, [],
    ]) {
      expect(() => resolveControls(value)).toThrow();
      if (value && !Array.isArray(value)) expect(() => resolveControls({}, value)).toThrow();
    }
    expect(() => resolveControls({}, {}, { TICKERS: 'a\nb' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow();
  });

  test('config file: keys equal CONTROL_NAMES, values are strings, the scheduled path and runtime resolution equal the defaults', async () => {
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    const config = readConfig(resolveControls(file));
    expect([config.tickers.size, config.maxFetches, config.requestSleepMs, config.concurrency, config.maxRetries, config.historyRange]).toEqual([0, 0, 1000, 2, 3, 'max']);
    expect([config.holdingsPageSize, config.historyPageSize, config.edgarFallback, config.skipYahoo, config.skipThemes]).toEqual([250, 1000, true, false, false]);
    expect((await runtimeControls({ TICKERS: 'BOTT', UNRELATED: 'x' })).TICKERS).toBe('BOTT');
    expect((await runtimeControls({})).CONCURRENCY).toBe('2');
  });

  test('ticker lists, AUM presets and ranges, return filters and HISTORY_RANGE casing', () => {
    expect([parseAumRange('micro'), parseAumRange('10M:2B')]).toEqual([{ min: 10e6, max: 300e6 }, { min: 10e6, max: 2e9 }]);
    expect([parseRange('0:0.35', 'TER'), parseRange(':', 'TER')]).toEqual([{ min: 0, max: 0.35 }, undefined]);
    const config = readConfig({ TICKERS: 'bott, clod AUMI', MAX_FETCHES: '3', REQUEST_SLEEP: '1', CONCURRENCY: '2', DIVIDEND_YIELD: '0:5', TOTAL_RETURN_1Y: '-100:100' });
    expect([...config.tickers]).toEqual(['BOTT', 'CLOD', 'AUMI']);
    expect([config.maxFetches, config.dividendYieldRange, config.totalReturnRanges['1Y']]).toEqual([3, { min: 0, max: 5 }, { min: -100, max: 100 }]);
    expect(readConfig(resolveControls({ HISTORY_RANGE: '5Y' })).historyRange).toBe('5y');
  });

  test('the MAX_FETCHES cursor wraps inside the filtered set and survives a stale cursor', () => {
    const set = ['A', 'B', 'C', 'D'].map((ticker) => ({ ticker }));
    const order = (cursor: string | null) => rotateFromCursor(set, cursor).map((f) => f.ticker);
    expect([order(null), order('B'), order('D'), order('BB'), order('Z')]).toEqual([
      ['A', 'B', 'C', 'D'], ['C', 'D', 'A', 'B'], ['A', 'B', 'C', 'D'], ['C', 'D', 'A', 'B'], ['A', 'B', 'C', 'D'],
    ]);
    expect(rotateFromCursor([], 'A')).toEqual([]);
  });

  test('USE_SYSTEM_CA: auto by default, case-insensitive, restart only on certificate errors', async () => {
    expect(resolveControls(file).USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'TRUE', 'False']) expect(resolveControls(file, {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    const certError = () => Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
    expect(isCertError(certError())).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: certError() }))).toBe(true);
    expect([isCertError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), isCertError(new HttpError(403))]).toEqual([false, false]);

    console.error = () => {};
    let calls = 0;
    const reexec = (): never => { calls += 1; throw new Error('reexec'); };
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(realFetch);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    expect(calls).toBe(1);
    globalThis.fetch = (async () => { throw certError(); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid/')).rejects.toThrow('reexec');
    expect(calls).toBe(2);
    globalThis.fetch = (async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid/')).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(2);
  });

  test('--help lists every control independent of the cwd and the SEC contact default is the daggerok one', async () => {
    const child = Bun.spawn([process.execPath, path.join(scriptsDir, 'update-data.ts'), '--help'], {
      cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    const help = await new Response(child.stdout).text();
    await child.exited;
    for (const name of CONTROL_NAMES) expect(help).toContain(name);
    expect(help).toContain('HISTORY_RANGE: max or Ny');
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig({}).secUserAgent).toBe(file.SEC_UA);
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
  });
});

// ===========================================================================
describe('parsing', () => {
  test('catalog: first-party products keep official values, an absent embedded catalog is empty', () => {
    expect(parseThemesCatalog(catalogHtml)).toEqual([{
      ticker: 'BOTT', name: 'Humanoid Robotics ETF', category: 'Thematic', navValue: 42.61, closePriceValue: 42.62, terValue: 0.35,
      fundPage: 'https://themesetfs.com/etfs/bott', factsheet: 'https://themesetfs.com/documents/BOTT.pdf', prospectus: undefined,
    }]);
    expect(parseThemesCatalog('<html><body>no catalog</body></html>')).toEqual([]);
  });

  test('proxied markdown catalog keeps first-party rows only', () => {
    expect(parseThemesCatalogMarkdown(stripProxyPreamble(catalogMarkdown))).toEqual([{
      ticker: 'BOTT', name: 'Humanoid Robotics ETF', category: 'Thematic', navValue: 41.76, closePriceValue: 42.05, terValue: 0.35,
      fundPage: 'https://themesetfs.com/etfs/bott', factsheet: 'https://themesetfs.com/documents/BOTT.pdf', prospectus: 'https://themesetfs.com/documents/BOTT-P.pdf',
    }]);
    expect(parseThemesCatalogMarkdown('no table here')).toEqual([]);
  });

  test('holdings CSV: quoted commas and CR/LF, official fields map to the shared sheet, header-only data is empty', () => {
    expect(parseCsv('a,b\r\n"one, two","say ""hi"""\r\n')).toEqual([['a', 'b'], ['one, two', 'say "hi"']]);
    const parsed = parseThemesHoldingsCsv(holdingsFixture);
    expect([parsed.asOf, parsed.netAssets, parsed.sharesOutstanding, parsed.rows.length]).toEqual(['2026-09-29', 65_732_424, 1_580_000, 2]);
    expect(parsed.rows[0]).toEqual({
      Name: 'Estun, Automation Co Ltd', Ticker: '002747 C2', Identifier: 'BFCCQJ9', Weight: '1.70%', 'Market Value': '$1117198.74', 'Shares Held': '263,600', 'Asset Category': 'Industrials',
    });
    expect(parsed.rows[1]['Asset Category']).toBe('Money Market');
    expect(parseThemesHoldingsCsv('date,security_name\n')).toEqual({ asOf: null, netAssets: null, sharesOutstanding: null, rows: [] });
  });

  test('Yahoo chart: adjusted closes are rounded, zero volume is kept, a zero dividend is dropped', () => {
    const parsed = parseYahooChart({ chart: { result: [{
      timestamp: [1_704_067_200, 1_704_153_600],
      indicators: { quote: [{ close: [100.004, 110.005], volume: [0, 1234] }], adjclose: [{ adjclose: [100.004, 109.995] }] },
      events: { dividends: { '1704067200': { amount: 0.25 }, '1704153600': { amount: 0 } } },
      meta: { fullExchangeName: 'NYSEArca' },
    }] } });
    expect(parsed.exchange).toBe('NYSEArca');
    expect(parsed.history).toEqual([
      { date: '2024-01-02', close: 110.01, adjClose: 110, volume: 1234 },
      { date: '2024-01-01', close: 100, adjClose: 100, volume: 0 },
    ]);
    expect(parsed.dividends).toEqual([{ date: '2024-01-01', amount: 0.25 }]);
  });

  test('N-PORT fallback: a literal holding is read from the filing', () => {
    const parsed = parseNportXml('<edgarSubmission><seriesName>Themes Humanoid Robotics ETF</seriesName><repPdDate>2026-06-30</repPdDate><totNetAssets>1000000</totNetAssets><invstOrSec><name>Example Robotics Inc</name><ticker>ROBO</ticker><cusip>123456789</cusip><balance>500</balance><valUSD>25000</valUSD><pctVal>2.5</pctVal><assetCat>Common Stock</assetCat></invstOrSec></edgarSubmission>');
    expect([parsed.seriesName, parsed.asOf, parsed.netAssets]).toEqual(['Themes Humanoid Robotics ETF', '2026-06-30', 1_000_000]);
    expect(parsed.rows[0]).toEqual({
      Name: 'Example Robotics Inc', Ticker: 'ROBO', Identifier: '123456789', Weight: '2.50%', 'Market Value': '$25000.00', 'Shares Held': '500', 'Asset Category': 'Common Stock',
    });
  });
});

// ===========================================================================
describe('metrics', () => {
  test('returns are zero, negative or positive without coercing missing prices', () => {
    const history = [
      { date: '2025-01-03', close: 110, adjClose: 110, volume: 1 }, { date: '2025-01-02', close: 100, adjClose: 100, volume: 1 },
      { date: '2024-12-31', close: 100, adjClose: 100, volume: 1 }, { date: '2024-01-02', close: 120, adjClose: 120, volume: 1 },
    ];
    expect([calculateReturn(history, new Date('2025-01-02T00:00:00Z')), calculateReturn(history, new Date('2024-01-02T00:00:00Z'))]).toEqual([10, -8.33]);
    const returns = deriveReturns(history, new Date('2025-01-03T00:00:00Z'));
    expect([returns.ytd, returns.yr1]).toEqual([10, -8.33]);
  });

  test('a young fund never falls back to since-inception: unreachable horizons are null, reachable ones are filled', () => {
    const keys = ['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'cagr3', 'cagr5', 'cagr10'];
    const young = deriveReturns(daily(200), NOW);
    for (const key of keys) expect(young[key]).toBeNull();
    const four = deriveReturns(daily(365 * 4 + 5), NOW);
    expect([four.yr1, four.yr3, four.cagr3].map((value) => value !== null)).toEqual([true, true, true]);
    expect([four.yr5, four.yr10, four.cagr10]).toEqual([null, null, null]);
    const long = deriveReturns(daily(365 * 11), NOW);
    for (const key of keys) expect(long[key]).not.toBeNull();
    expect(long.yr10).not.toBe(long.yr5);
    const oneYear = deriveReturns(daily(366), NOW);
    expect([oneYear.yr1 !== null, oneYear.yr3, oneYear.yr5, oneYear.yr10]).toEqual([true, null, null, null]);
    const short = daily(40);
    expect(calculateReturn(short, new Date(NOW.getTime() - 43 * 86_400_000))).not.toBeNull();
    expect(calculateReturn(short, new Date(NOW.getTime() - 60 * 86_400_000))).toBeNull();
  });

  test('flat placeholder history gives null returns and a null yield, no dividends give null (never 0)', () => {
    const flat = Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-${String(28 - i).padStart(2, '0')}`, close: 38.34, adjClose: 38.34, volume: 0 }));
    expect([isFlatHistory(flat), isFlatHistory(daily(5))]).toEqual([true, false]);
    for (const value of Object.values(deriveReturns(flat, NOW))) expect(value).toBeNull();
    expect([trailingDividendYield([], 20, NOW), trailingDividendYield([{ date: '2020-01-01', amount: 1 }], 20, NOW), trailingDividendYield([{ date: '2026-09-01', amount: 1 }], 20, NOW)]).toEqual([null, null, 5]);
  });

  test('derived returns do not depend on the machine time zone', () => {
    process.env.TZ = 'UTC';
    const expected = JSON.stringify(deriveReturns(daily(400), NOW));
    for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      expect(JSON.stringify(deriveReturns(daily(400), NOW))).toBe(expected);
    }
  });

  test('returnsBasis is never empty and ends the metrics with performanceAsOf; every row shares one key set', () => {
    expect(performanceFields('2026-09-30')).toEqual({ returnsBasis: RETURNS_BASIS, performanceAsOf: '2026-09-30' });
    for (const bad of [null, undefined, '', 'Sep 30, 2026', '2026-9-30', 5]) expect(performanceFields(bad).performanceAsOf).toBeNull();
    expect(RETURNS_BASIS.trim().length).toBeGreaterThan(3);
    const metrics = withPerformanceFields({ ytd: 1, returnsBasis: 'old', performanceAsOf: 'x', secYield: null }, '2026-09-30');
    expect(Object.keys(metrics)).toEqual(['ytd', 'secYield', 'returnsBasis', 'performanceAsOf']);
    expect(Object.keys(withPerformanceFields(undefined, null))).toEqual(['returnsBasis', 'performanceAsOf']);
    const row = skeletonEntry({ ticker: 'DRGN', name: 'Dragon', category: 'Thematic', navValue: 20, closePriceValue: 20.1, terValue: 0.5, fundPage: 'https://themesetfs.com/etfs/drgn' }) as any;
    expect(row.dataFile).toBeNull();
    expect(Object.keys(row.metrics).sort()).toEqual(Object.keys(emptyMetrics()).sort());
    for (const key of ['distributionYield', 'dividendYield', 'yield12M', 'secYieldText', 'returnsBasis', 'performanceAsOf']) expect(key in row.metrics).toBe(true);
    expect(row.metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(Object.values(row.metrics).filter((value) => value === 0)).toEqual([]);
  });

  test('distribution frequency: None fallback, explicit Unknown kept, quarterly cadence inferred', () => {
    for (const empty of [null, undefined, '', '  ', '—', '--']) expect(formatDividendFrequency(empty)).toBe('00 - None');
    expect([formatDividendFrequency('Unknown'), formatDividendFrequency('Monthly'), formatDividendFrequency('Quarterly')]).toEqual(['00 - Unknown', '01 - Monthly', '04 - Quarterly']);
    expect(inferDistributionFrequency([{ date: '2025-01-15', amount: 0.1 }, { date: '2025-04-15', amount: 0.1 }, { date: '2025-07-15', amount: 0.1 }], new Date('2025-09-01T00:00:00Z'))).toBe('04 - Quarterly');
  });
});

// ===========================================================================
// Sandbox: main() runs inside a per-test temp dir (cwd) against a mocked fetch
// ===========================================================================
type Row = { t: string; days: number; flat?: boolean; nav?: string };
const htmlCatalog = (rows: Row[]): string => `<script>window.productsData = [\n${rows.map((r) => `{\n ticker: '${r.t}',\n externalLink: false,\n fund: "${r.t} ETF",\n category: "Thematic",\n nav: '${r.nav ?? '20.00'}',\n price: '20.10',\n expense: '0.35',\n product_url: 'https://themesetfs.com/etfs/${r.t.toLowerCase()}'\n}`).join(',\n')}\n];</script>`;
const holdingsCsv = 'date,stock_ticker,cusip,security_name,shares,market_value,weightings,net_assets,shares_outstanding,sector\n2026-10-01,AAA,111,Alpha,10,500,50,1000,100,Tech\n';
const chartJson = (days: number, flat = false): string => {
  const last = Math.floor(Date.now() / 86_400_000) * 86_400;
  const timestamp = Array.from({ length: days }, (_, i) => last - (days - 1 - i) * 86_400);
  const close = timestamp.map((_, i) => (flat ? 38.34 : 20 + i * 0.01));
  const events = Object.fromEntries(timestamp.filter((_, i) => i % 30 === 0 && !flat).map((t) => [String(t), { amount: 0.1 }]));
  return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote: [{ close, volume: close.map(() => (flat ? 0 : 5)) }], adjclose: [{ adjclose: close }] }, events: { dividends: events }, meta: { fullExchangeName: 'NYSEArca' } }] } });
};
const blocked = (): Response => new Response('Access Denied', { status: 403 });
/** Healthy provider: catalog, one CSV per fund (NOHOLD has none) and a Yahoo chart per fund. */
const feed = (rows: Row[], extra?: (url: string) => Response | null) => (url: string): Response => {
  const extraResponse = extra?.(url);
  if (extraResponse) return extraResponse;
  if (url === 'https://themesetfs.com/etfs') return new Response(htmlCatalog(rows));
  const csvMatch = /Holdings-(\w+)\.csv/.exec(url);
  if (csvMatch) return rows.some((r) => r.t === csvMatch[1]) && csvMatch[1] !== 'NOHOLD' ? new Response(holdingsCsv) : new Response('gone', { status: 404 });
  const chartMatch = /chart\/(\w+)\?/.exec(url);
  const row = rows.find((r) => r.t === chartMatch?.[1]);
  return row && row.days > 0 ? new Response(chartJson(row.days, row.flat)) : new Response('{}', { status: 404 });
};

function repo(seed: (api: string) => void = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'themes-test-'));
  tempDirs.push(root);
  const api = path.join(root, 'api/themes');
  mkdirSync(api, { recursive: true });
  seed(api);
  const calls: Array<{ url: string; at: number }> = [];
  const logs: string[] = [];
  const read = (rel: string): string => readFileSync(path.join(api, rel), 'utf8');
  const json = (rel: string) => JSON.parse(read(rel));
  const run = async (handler: (url: string) => Response, env: Record<string, string> = {}): Promise<unknown> => {
    globalThis.fetch = (async (input: RequestInfo | URL) => { const url = String(input); calls.push({ url, at: Date.now() }); return handler(url); }) as typeof fetch;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    console.warn = console.error = () => {};
    // proxy pacing waits 3.2 s between starts; skip the real wait unless the test runs its own fake clock
    if (Date.now === realNow) globalThis.setTimeout = ((callback: () => void, ms?: number) => realSetTimeout(callback, ms && ms >= 1000 ? 0 : ms)) as unknown as typeof setTimeout;
    process.chdir(root);
    resetIssuerState();
    try {
      await main({ REQUEST_SLEEP: '0', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', USE_SYSTEM_CA: 'false', ...env });
      return null;
    } catch (error) {
      return error;
    } finally {
      process.chdir(realCwd);
      Object.assign(console, realConsole);
      if (Date.now === realNow) globalThis.setTimeout = realSetTimeout;
    }
  };
  const files = (): string[] => (readdirSync(api, { recursive: true }) as string[]).filter((f) => statSync(path.join(api, f)).isFile()).sort();
  const backdate = (): void => { for (const f of files()) utimesSync(path.join(api, f), 1_000_000_000, 1_000_000_000); };
  const touched = (): string[] => files().filter((f) => statSync(path.join(api, f)).mtimeMs !== 1_000_000_000_000);
  return { root, api, calls, logs, read, json, run, files, backdate, touched, tickers: (): string[] => json('index.json').funds.map((f: any) => f.ticker) };
}
const live = { SKIP_YAHOO: 'false' };
const seedPublished = (api: string, withHistory = false) => {
  mkdirSync(path.join(api, 'funds/BOTT'), { recursive: true });
  const holdings = { pages: ['001.json'], pageSize: 250, totalRows: 31, asOfDate: '09/30/2026', asOf: '2026-09-30' };
  const history = { pages: ['001.json'], pageSize: 1000, totalRows: 3, asOfDate: 'Sep 29, 2026', asOf: '2026-09-29' };
  writeFileSync(path.join(api, 'funds/BOTT/meta.json'), JSON.stringify({ ticker: 'BOTT', navValue: 40, aumValue: 123, holdings, ...(withHistory ? { history } : {}), source: { holdingsSource: 'official Themes ETFs daily holdings CSV' } }));
  const funds: unknown[] = [{ ticker: 'BOTT', name: 'Humanoid Robotics ETF', category: 'Thematic', navValue: 40, terValue: 0.35, fundPage: 'https://themesetfs.com/etfs/bott', holdings: 31, history: withHistory ? 3 : 0 }];
  if (withHistory) {
    mkdirSync(path.join(api, 'funds/CLOD'), { recursive: true });
    writeFileSync(path.join(api, 'funds/CLOD/meta.json'), JSON.stringify({ ticker: 'CLOD', metrics: { ytd: 1 } }));
    funds.push({ ticker: 'CLOD', name: 'Cloud', category: 'Thematic', metrics: { ytd: 1 }, holdings: 1, history: 1 });
  }
  writeFileSync(path.join(api, 'index.json'), JSON.stringify({ generatedAt: '2026-09-30T00:00:00Z', funds }));
};

describe('pipeline', () => {
  test('young, flat and long funds publish honest nulls; every row has the same metrics keys; a catalog-only fund has dataFile null', async () => {
    const box = repo();
    const error = await box.run(feed([{ t: 'FLT', days: 5, flat: true }, { t: 'NOHOLD', days: 0 }, { t: 'OLD', days: 4300 }, { t: 'YNG', days: 200 }]), live);
    expect(error).toBeNull();
    const by = Object.fromEntries(box.json('index.json').funds.map((f: any) => [f.ticker, f]));
    for (const key of ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'dividendYield', 'yield12M']) expect(by.FLT.metrics[key]).toBeNull();
    for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y']) expect(by.YNG.metrics[key]).toBeNull();
    expect(by.YNG.metrics.dividendYield).not.toBeNull();
    for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr10y']) expect(by.OLD.metrics[key]).not.toBeNull();
    expect(by.OLD.metrics.tr10y).not.toBe(by.OLD.metrics.tr5y);
    expect([by.NOHOLD.dataFile, by.OLD.dataFile]).toEqual([null, './funds/OLD/meta.json']);
    const keys = Object.keys(emptyMetrics()).sort();
    for (const row of Object.values(by) as any[]) {
      expect(Object.keys(row.metrics).sort()).toEqual(keys);
      expect(row.metrics.returnsBasis).toBeTruthy();
    }
    expect(box.logs.join('\n')).not.toContain('gmail.com');
  });

  test('a one-ticker run keeps every other row and file', async () => {
    const rows = ['AAA', 'BBB', 'CCC'].map((t) => ({ t, days: 400 }));
    const box = repo();
    await box.run(feed(rows), live);
    const others = () => JSON.stringify(['BBB', 'CCC'].map((t) => box.read(`funds/${t}/meta.json`)));
    const before = others();
    expect(await box.run(feed(rows), { ...live, TICKERS: 'AAA' })).toBeNull();
    expect(box.tickers()).toEqual(['AAA', 'BBB', 'CCC']);
    expect(others()).toBe(before);
    expect(await box.run(() => blocked(), { TICKERS: 'AAA' })).toBeNull();
    expect(box.tickers()).toEqual(['AAA', 'BBB', 'CCC']);
  });

  test('a rerun with identical upstream data writes nothing', async () => {
    const rows = [{ t: 'OLD', days: 400 }];
    const box = repo();
    await box.run(feed(rows), live);
    box.backdate();
    const before = box.files().map((f) => box.read(f));
    expect(await box.run(feed(rows), live)).toBeNull();
    expect(box.touched()).toEqual([]);
    expect(box.files().map((f) => box.read(f))).toEqual(before);
  });

  test('direct 403 on the catalog and the CSV falls back to the proxy, which is paced, and publishes fresh data', async () => {
    const clock = fakeClock();
    const box = repo();
    const csv = 'date,stock_ticker,cusip,security_name,shares,market_value,weightings,net_assets,shares_outstanding,sector\n2026-10-01,AAA,111,Alpha Corp,10,500,50,1000,100,Tech\n2026-10-01,BBB,222,Beta Corp,10,500,50,1000,100,Tech\n';
    const error = await box.run((url) => {
      if (url === `${PROXY_PREFIX}https://themesetfs.com/etfs`) return new Response(catalogMarkdown);
      if (url === `${PROXY_PREFIX}https://themesetfs.com/storage/holdings/Holdings-BOTT.csv`) return new Response(`Title: x\n\nMarkdown Content:\n${csv}`);
      return blocked();
    }, { TICKERS: 'BOTT' });
    expect(error).toBeNull();
    const proxied = box.calls.filter((call) => call.url.startsWith(PROXY_PREFIX));
    expect(proxied).toHaveLength(2);
    expect(proxied[1].at - proxied[0].at).toBeGreaterThanOrEqual(PROXY_SLEEP_MS);
    expect(clock.waits).toContain(PROXY_SLEEP_MS);
    expect(box.calls.filter((call) => !call.url.startsWith(PROXY_PREFIX))).toHaveLength(2);
    const meta = box.json('funds/BOTT/meta.json');
    expect([meta.holdings.totalRows, meta.navValue, meta.source.retained]).toEqual([2, 41.76, undefined]);
    expect(meta.source.holdingsSource).toContain('via read-only rendering proxy');
  });

  test('official source completely unavailable keeps the published fund, labeled as retained', async () => {
    const box = repo((api) => seedPublished(api));
    expect(await box.run(() => blocked(), { TICKERS: 'BOTT' })).toBeNull();
    const meta = box.json('funds/BOTT/meta.json');
    expect([meta.holdings.totalRows, meta.aumValue, meta.source.retained.holdings]).toEqual([31, 123, true]);
    expect(meta.source.holdingsSource).toContain('retained');
    expect(box.json('index.json').funds[0].ticker).toBe('BOTT');
    expect(meta.metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(meta.metrics.performanceAsOf).toBeNull();
    expect(box.json('index.json').funds[0].metrics).toEqual(meta.metrics);
    expect(box.touched().length).toBeGreaterThan(0);
  });

  test('retained history keeps the last Yahoo close date as performanceAsOf, other published rows stay', async () => {
    const box = repo((api) => seedPublished(api, true));
    expect(await box.run(() => blocked(), { TICKERS: 'BOTT' })).toBeNull();
    expect(box.json('funds/BOTT/meta.json').metrics.performanceAsOf).toBe('2026-09-29');
    const funds = box.json('index.json').funds;
    expect([funds[0].metrics.performanceAsOf, funds[1].metrics.ytd, funds[1].metrics.returnsBasis, funds[1].metrics.performanceAsOf]).toEqual(['2026-09-29', 1, RETURNS_BASIS, null]);
  });

  test('a fund that fails the data filter is left untouched: files and index row stay byte-identical', async () => {
    const box = repo();
    await box.run(feed([{ t: 'OLD', days: 400 }]), { ...live, TICKERS: 'OLD' });
    const before = [box.read('funds/OLD/meta.json'), box.read('index.json')];
    expect(await box.run(feed([{ t: 'OLD', days: 400, nav: '25.00' }]), { ...live, TICKERS: 'OLD', TOTAL_RETURN_1Y: '900:1000' })).toBeNull();
    expect([box.read('funds/OLD/meta.json'), box.read('index.json')]).toEqual(before);
  });

  test('the MAX_FETCHES cursor wraps and a TICKERS run leaves the cursor alone', async () => {
    const rows = ['AAA', 'BBB', 'CCC'].map((t) => ({ t, days: 400 }));
    const box = repo();
    const cursor = (): string | null => { try { return box.json('update-state.json').cursor; } catch { return null; } };
    await box.run(feed(rows), { ...live, MAX_FETCHES: '2' });
    expect(cursor()).toBe('BBB');
    await box.run(feed(rows), { ...live, MAX_FETCHES: '2' });
    expect(cursor()).toBe('AAA');
    await box.run(feed(rows), { ...live, MAX_FETCHES: '2', TICKERS: 'CCC' });
    expect(cursor()).toBe('AAA');
    await box.run(feed(rows), { ...live, MAX_FETCHES: '0', TICKERS: 'CCC' });
    expect(cursor()).toBe('AAA');
  });

  test('every selected fund failing is an error; nothing reachable and nothing published fails loudly', async () => {
    expect(String(await repo().run(feed([{ t: 'NOHOLD', days: 0 }]), live))).toContain('every selected fund failed');
    expect(String(await repo().run(() => blocked(), { TICKERS: 'BOTT' }))).toContain('nothing published to retain');
    const noMeta = repo((api) => writeFileSync(path.join(api, 'index.json'), JSON.stringify({ funds: [{ ticker: 'BOTT', name: 'B', category: 'Thematic', fundPage: 'https://themesetfs.com/etfs/bott' }] })));
    expect(String(await noMeta.run(() => blocked(), { TICKERS: 'BOTT' }))).toContain('nothing could be refreshed');
  });

  test('a fund dropped from the official catalog leaves the feed, a much smaller catalog is not trusted', async () => {
    const rows = [{ t: 'AAA', days: 400 }, { t: 'BBB', days: 400 }, { t: 'CCC', days: 400 }];
    const box = repo();
    await box.run(feed(rows), live);
    await box.run(feed(rows.slice(0, 1)), live);
    expect(box.tickers()).toEqual(['AAA', 'BBB', 'CCC']);
    await box.run(feed(rows.slice(0, 2)), live);
    expect(box.tickers()).toEqual(['AAA', 'BBB']);
    expect(existsSync(path.join(box.api, 'funds/CCC'))).toBe(false);
  });

  test('N-PORT freshness: an older filing never replaces published holdings, a newer one does', async () => {
    const filing = (asOf: string) => (url: string): Response | null => {
      if (/Holdings-BOTT\.csv/.test(url)) return new Response('gone', { status: 404 });
      if (url.includes('data.sec.gov/submissions')) return new Response(JSON.stringify({ filings: { recent: { form: ['NPORT-P'], accessionNumber: ['0001-26-000001'], primaryDocument: ['primary_doc.xml'] } } }));
      if (url.includes('/Archives/edgar/')) return new Response(`<edgarSubmission><seriesName>BOTT ETF</seriesName><repPdDate>${asOf}</repPdDate><totNetAssets>1000</totNetAssets><invstOrSec><name>Nport Corp</name><ticker>NPC</ticker><cusip>999</cusip><balance>1</balance><valUSD>5</valUSD><pctVal>5</pctVal><assetCat>EC</assetCat></invstOrSec></edgarSubmission>`);
      return null;
    };
    const rows = [{ t: 'BOTT', days: 0 }];
    const older = repo((api) => seedPublished(api));
    expect(await older.run(feed(rows, filing('2026-06-30')), { TICKERS: 'BOTT', EDGAR_FALLBACK: 'true' })).toBeNull();
    expect([older.json('funds/BOTT/meta.json').holdings.totalRows, older.json('funds/BOTT/meta.json').source.holdingsSource]).toEqual([31, expect.stringContaining('retained')]);
    const newer = repo((api) => seedPublished(api));
    expect(await newer.run(feed(rows, filing('2026-12-31')), { TICKERS: 'BOTT', EDGAR_FALLBACK: 'true' })).toBeNull();
    expect(newer.json('funds/BOTT/meta.json').holdings.totalRows).toBe(1);
    expect(newer.json('funds/BOTT/meta.json').source.holdingsSource).toContain('N-PORT');
  });

  test('index comparison ignores run timestamps and key order', () => {
    const first = { generatedAt: '2026-09-29T00:00:00Z', nested: { catalogReadAt: 'a', beta: 2, alpha: 1 } };
    expect(samePublishedContent(first, { generatedAt: '2026-09-30T00:00:00Z', nested: { catalogReadAt: 'b', alpha: 1, beta: 2 } })).toBe(true);
    expect(samePublishedContent(first, { generatedAt: '2026-09-30T00:00:00Z', nested: { alpha: 1, beta: 3 } })).toBe(false);
    expect(stableStringify({ z: 1, a: { b: 2, a: 1 } })).toBe('{\n  "a": {\n    "a": 1,\n    "b": 2\n  },\n  "z": 1\n}\n');
  });
});

// ===========================================================================
describe('network', () => {
  const quiet = { maxRetries: 1, requestSleepMs: 0, verbose: false, fetchTimeoutMs: 40 };

  test('the timeout covers headers and body: a stalled request or body is retried, then fails', async () => {
    globalThis.setTimeout = ((callback: () => void, ms?: number) => realSetTimeout(callback, ms && ms >= 250 ? 0 : ms)) as unknown as typeof setTimeout;
    let calls = 0;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof fetch;
    await expect(fetchWithRetry('https://x.test/a', {}, quiet)).rejects.toBeDefined();
    expect(calls).toBe(2);
    calls = 0;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      const body = new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)); } });
      return Promise.resolve(new Response(body));
    }) as typeof fetch;
    await expect(fetchWithRetry('https://x.test/b', {}, quiet, undefined, (response) => response.text())).rejects.toBeDefined();
    expect(calls).toBe(2);
  });

  test('retries are bounded by MAX_RETRIES and a 404 is not retried', async () => {
    globalThis.setTimeout = ((callback: () => void) => realSetTimeout(callback, 0)) as unknown as typeof setTimeout;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('x', { status: 503 }); }) as unknown as typeof fetch;
    await expect(fetchWithRetry('https://x.test/c', {}, { ...quiet, maxRetries: 2 })).rejects.toBeDefined();
    expect(calls).toBe(3);
    calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('x', { status: 404 }); }) as unknown as typeof fetch;
    await expect(fetchWithRetry('https://x.test/d', {}, { ...quiet, maxRetries: 2 })).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test('the proxy never receives the SEC contact and is tried only for 403, 429 and 5xx', async () => {
    const seen: Array<{ url: string; ua: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), ua: String((init?.headers as Record<string, string>)['User-Agent']) });
      return String(url).startsWith(PROXY_PREFIX) ? new Response('Markdown Content:\nok') : new Response('no', { status: 403 });
    }) as typeof fetch;
    resetIssuerState();
    const config = { ...readConfig({}), maxRetries: 1, requestSleepMs: 0, secUserAgent: 'daggerok ETF feed daggerok@gmail.com' };
    const result = await fetchOfficialText('https://themesetfs.com/etfs', config, async () => {}, async () => {}, () => true);
    expect(result.via).toBe('proxy');
    expect(seen.filter((call) => call.url.startsWith(PROXY_PREFIX))).toHaveLength(1);
    for (const call of seen) expect(call.ua).not.toContain('@');
    for (const status of [403, 429, 500, 503]) expect(proxyEligible(new HttpError(status))).toBe(true);
    for (const status of [400, 404]) expect(proxyEligible(new HttpError(status))).toBe(false);
    expect(retainedLabel('official CSV')).toBe(retainedLabel(retainedLabel('official CSV')));
  });

  test('request lanes pace independently, the proxy gate serializes every start', async () => {
    const clock = fakeClock();
    const gate = createRequestGate(2, 20);
    await Promise.all([gate(), gate(), gate()]);
    expect(clock.waits).toEqual([20]);
    clock.waits.length = 0;
    expect(PROXY_SLEEP_MS).toBe(3200);
    const proxyGate = createProxyGate(PROXY_SLEEP_MS);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(async () => { await proxyGate(); starts.push(clock.now()); }));
    expect(clock.waits).toEqual([PROXY_SLEEP_MS, PROXY_SLEEP_MS]);
    expect(starts.length).toBe(3);
  });

  test('workers really run in parallel: in-flight peak is 1 at CONCURRENCY=1 and N at N', async () => {
    const rows = ['AAA', 'BBB', 'CCC', 'DDD'].map((t) => ({ t, days: 30 }));
    const peakFor = async (concurrency: number): Promise<number> => {
      let inFlight = 0, peak = 0;
      const box = repo();
      globalThis.fetch = realFetch;
      const handler = feed(rows);
      const slow = async (url: string): Promise<Response> => {
        if (!/Holdings-/.test(url)) return handler(url);
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => realSetTimeout(resolve, 60));
        inFlight -= 1;
        return handler(url);
      };
      process.chdir(box.root);
      globalThis.fetch = (async (input: RequestInfo | URL) => slow(String(input))) as typeof fetch;
      console.log = console.warn = console.error = () => {};
      try { resetIssuerState(); await main({ REQUEST_SLEEP: '0', EDGAR_FALLBACK: 'false', MAX_RETRIES: '1', SKIP_YAHOO: 'true', USE_SYSTEM_CA: 'false', CONCURRENCY: String(concurrency) }); }
      finally { process.chdir(realCwd); Object.assign(console, realConsole); }
      return peak;
    };
    expect(await peakFor(1)).toBe(1);
    expect(await peakFor(4)).toBe(4);
  });

  test('HISTORY_RANGE reaches the Yahoo request as explicit period1/period2', async () => {
    const now = new Date('2026-06-15T00:00:00Z');
    expect(yahooChartUrl('bott', 'max', now)).toContain('period1=0&period2=9999999999');
    const url = yahooChartUrl('BOTT', '3y', now);
    expect(url).toContain(`period1=${Math.floor(new Date('2023-06-15T00:00:00Z').getTime() / 1000)}`);
    expect(url).toContain(`period2=${Math.floor(now.getTime() / 1000)}`);
    const box = repo();
    await box.run(feed([{ t: 'AAA', days: 30 }]), { ...live, HISTORY_RANGE: '5y' });
    const request = new URL(box.calls.find((call) => /chart\/AAA/.test(call.url))!.url);
    const [period1, period2] = [Number(request.searchParams.get('period1')), Number(request.searchParams.get('period2'))];
    expect(period1).toBeGreaterThan(0);
    expect(Math.round((period2 - period1) / 86_400 / 365.25)).toBe(5);
  });
});
