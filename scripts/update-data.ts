#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * @file Themes ETFs static feed updater.
 *
 * Bun-only and zero runtime dependencies. The browser reads the deterministic
 * api/themes tree generated from the official Themes catalog and daily holdings
 * CSV downloads, with Yahoo Finance history and an SEC N-PORT-P fallback.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

export const BRAND = 'themes';
export const BRAND_LABEL = 'Themes ETFs';
export const THEMES_SITE = 'https://themesetfs.com';
export const THEMES_CATALOG_URL = `${THEMES_SITE}/etfs`;
export const THEMES_HOLDINGS_URL = (ticker: string): string =>
  `${THEMES_SITE}/storage/holdings/Holdings-${sanitizeTicker(ticker)}.csv`;
export const THEMES_FUND_URL = (ticker: string): string =>
  `${THEMES_SITE}/etfs/${sanitizeTicker(ticker).toLowerCase()}`;
export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
export const yahooChartUrl = (ticker: string, historyRange = 'max', now = new Date()): string => {
  const years = /^(\d+)y$/i.exec(historyRange.trim());
  const start = new Date(now);
  if (years) start.setUTCFullYear(start.getUTCFullYear() - Number(years[1]));
  const period1 = years ? Math.max(0, Math.floor(start.getTime() / 1000)) : 0;
  const period2 = years ? Math.floor(now.getTime() / 1000) : 9999999999;
  return `${YAHOO_CHART_URL}/${sanitizeTicker(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit&includeAdjustedClose=true`;
};
export const yahooChartProvenanceUrl = (ticker: string): string =>
  `${YAHOO_CHART_URL}/${sanitizeTicker(ticker)}`;
export const THEMES_ETF_TRUST_CIK = '0001976322';
export const THEMES_ETF_TRUST = 'Themes ETF Trust';
export const edgarFilingsUrl = (cik = THEMES_ETF_TRUST_CIK): string =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=NPORT-P&dateb=&owner=include&count=40`;

const API_ROOT = path.join('api', BRAND);
/** Soft internal deadline: stop taking new funds, still write the index (the workflow limit is 30 minutes). */
export const SOFT_DEADLINE_MS = 25 * 60_000;
const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] as const;
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
const HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'] as const;
const VOLATILE_KEYS = new Set(['generatedAt', 'catalogReadAt', 'updatedAt', 'savedAt']);

export type Range = { min: number; max: number };
export type CatalogFund = {
  ticker: string;
  name: string;
  category: string;
  navValue: number | null;
  closePriceValue: number | null;
  terValue: number | null;
  fundPage: string;
  factsheet?: string;
  prospectus?: string;
};
export type ParsedHoldings = {
  asOf: string | null;
  netAssets: number | null;
  sharesOutstanding: number | null;
  rows: Array<Record<(typeof HOLDINGS_HEADERS)[number], string>>;
};
// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type YahooHistoryRow = { date: string; close: number | null; adjClose: number | null; volume: number | null; adjCloseRaw?: number | null };
export type YahooDistribution = { date: string; amount: number };
export type ParsedYahooChart = {
  history: YahooHistoryRow[];
  dividends: YahooDistribution[];
  exchange: string | null;
  /** Yahoo's first trade date (ISO): the listing date, the fund's start for the age rule; null when Yahoo gives none. */
  firstTradeDate: string | null;
};
export type UpdaterConfig = {
  maxFetches: number;
  requestSleepMs: number;
  concurrency: number;
  maxRetries: number;
  tickers: Set<string>;
  category: string;
  aumRange?: Range;
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: Record<string, Range | undefined>;
  totalReturnRanges: Record<string, Range | undefined>;
  holdingsPageSize: number;
  historyPageSize: number;
  historyRange: string;
  edgarFallback: boolean;
  skipYahoo: boolean;
  skipThemes: boolean;
  secUserAgent: string;
  verbose: boolean;
  /** Per-request timeout covering headers and body; not a user control. */
  fetchTimeoutMs: number;
};

export const FETCH_TIMEOUT_MS = 45_000;
const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

const DEFAULTS = {
  MAX_FETCHES: '0',
  REQUEST_SLEEP: '1',
  CONCURRENCY: '2',
  MAX_RETRIES: '3',
  TICKERS: '',
  CATEGORY: '',
  AUM: ':',
  TER: ':',
  DIVIDEND_YIELD: ':',
  SEC_YIELD: ':',
  PERFORMANCE_YTD: ':',
  PERFORMANCE_1Y: ':',
  PERFORMANCE_3Y: ':',
  PERFORMANCE_5Y: ':',
  PERFORMANCE_10Y: ':',
  TOTAL_RETURN_YTD: ':',
  TOTAL_RETURN_1Y: ':',
  TOTAL_RETURN_3Y: ':',
  TOTAL_RETURN_5Y: ':',
  TOTAL_RETURN_10Y: ':',
  HOLDINGS_PAGE_SIZE: '250',
  HISTORY_PAGE_SIZE: '1000',
  HISTORY_RANGE: 'max',
  EDGAR_FALLBACK: 'true',
  SKIP_YAHOO: 'false',
  SKIP_THEMES: 'false',
  SEC_UA: SEC_UA_DEFAULT,
  VERBOSE: 'false',
  USE_SYSTEM_CA: 'auto',
} as const;

const rangePeriods = ['YTD', '1Y', '3Y', '5Y', '10Y'] as const;

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

/** Per-fund VERBOSE detail, tagged once. */
function note(message: string): void { outputNote(`[ note     ] ${outputClean(message)}`); }

/** The `[ config ]` block: the parsed config under the canonical environment names (SEC_UA is redacted). */
function printUpdaterConfig(config: UpdaterConfig): void {
  const range = (value?: Range) => ({ source: value ? `${value.min}:${value.max}` : ':' });
  const periods = (ranges: Partial<Record<string, Range>>) => Object.fromEntries(rangePeriods.map((period) => [period, range(ranges[period])]));
  outputPrintConfig(BRAND_LABEL, {
    maxFetches: config.maxFetches, requestSleepSeconds: config.requestSleepMs / 1000, concurrency: config.concurrency,
    maxRetries: config.maxRetries, tickers: config.tickers, categories: config.category,
    aumRange: range(config.aumRange), terRange: range(config.terRange), dividendYieldRange: range(config.dividendYieldRange),
    secYieldRange: range(config.secYieldRange), performanceRanges: periods(config.performanceRanges), totalReturnRanges: periods(config.totalReturnRanges),
    holdingsPageSize: config.holdingsPageSize, historyPageSize: config.historyPageSize, historyRange: config.historyRange,
    edgarFallback: config.edgarFallback, skipYahoo: config.skipYahoo, skipThemes: config.skipThemes, SEC_UA: config.secUserAgent,
  });
}

export function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
}

export function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&reg;|&#174;/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function numberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text || /^(?:--|—|n\/?a|null)$/i.test(text)) return null;
  const wrappedNegative = /^\(.*\)$/.test(text);
  const normalized = text.replace(/[,$%\s]/g, '').replace(/[()]/g, '');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return wrappedNegative ? -Math.abs(value) : value;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatPercent(value: number | null, digits = 2): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

function formatMoney(value: number | null, digits = 2): string {
  return value === null ? '—' : `$${value.toFixed(digits)}`;
}

function formatAum(value: number | null): string {
  if (value === null) return '—';
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatShares(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) { row.push(value); value = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
      continue;
    }
    value += char;
  }
  row.push(value);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

export function parseThemesCatalog(html: string): CatalogFund[] {
  // the page names window.productsData in an Alpine x-data attribute first; its templates (product.product_url : ...) would
  // shadow the first fund's fields, so the catalog starts at the assignment
  const assignment = /window\.productsData\s*=\s*\[/.exec(html);
  if (!assignment) return [];
  const start = assignment.index;
  const end = html.indexOf('</script>', start);
  const source = html.slice(start, end < 0 ? undefined : end);
  const pieces = source.split(/\n\s*},\s*/g);
  const results: CatalogFund[] = [];
  const readField = (piece: string, name: string): string => {
    const match = piece.match(new RegExp(`${name}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|([^,\\n}]+))`, 'i'));
    return cleanText(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
  };
  for (const piece of pieces) {
    const ticker = sanitizeTicker(readField(piece, 'ticker'));
    const external = /^true$/i.test(readField(piece, 'externalLink'));
    const fundPage = readField(piece, 'product_url');
    if (!ticker || external || !fundPage.startsWith(THEMES_SITE)) continue;
    const name = readField(piece, 'fund') || ticker;
    const category = readField(piece, 'category') || 'Other';
    const navValue = numberOrNull(readField(piece, 'nav'));
    const closePriceValue = numberOrNull(readField(piece, 'price'));
    const terValue = numberOrNull(readField(piece, 'expense'));
    results.push({
      ticker,
      name,
      category,
      navValue,
      closePriceValue,
      terValue,
      fundPage,
      factsheet: readField(piece, 'product_factsheet') || undefined,
      prospectus: readField(piece, 'product_prospectus') || undefined,
    });
  }
  return [...new Map(results.map((fund) => [fund.ticker, fund])).values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Strips the r.jina.ai preamble ("Title:", "URL Source:", "Markdown Content:"). */
export function stripProxyPreamble(text: string): string {
  const source = String(text ?? '');
  const marker = /^Markdown Content:\s*\n/m.exec(source);
  return marker ? source.slice(marker.index + marker[0].length) : source;
}

/** Parses the catalog table of the r.jina.ai markdown rendering of themesetfs.com/etfs (first-party rows only). */
export function parseThemesCatalogMarkdown(markdown: string): CatalogFund[] {
  const link = (cell: string): { text: string; url: string } | null => {
    const match = /\[([^\]]*)\]\((https?:[^)\s]+)\)/.exec(cell);
    return match ? { text: cleanText(match[1]), url: match[2] } : null;
  };
  const results: CatalogFund[] = [];
  for (const line of String(markdown ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/\s\|\s/).map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const tickerLink = link(cells[0]);
    const nameLink = link(cells[1]);
    if (!tickerLink || !tickerLink.url.startsWith(`${THEMES_SITE}/etfs/`)) continue;
    const ticker = sanitizeTicker(tickerLink.text);
    if (!ticker) continue;
    results.push({
      ticker,
      name: nameLink?.text || ticker,
      category: cleanText(cells[2]) || 'Other',
      navValue: numberOrNull(cells[3]),
      closePriceValue: numberOrNull(cells[4]),
      terValue: numberOrNull(cells[5]),
      fundPage: tickerLink.url,
      factsheet: (cells[6] && link(cells[6])?.url) || undefined,
      prospectus: (cells[7] && link(cells[7])?.url) || undefined,
    });
  }
  return [...new Map(results.map((fund) => [fund.ticker, fund])).values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function parseThemesHoldingsCsv(text: string): ParsedHoldings {
  const csv = parseCsv(text);
  if (csv.length < 2) return { asOf: null, netAssets: null, sharesOutstanding: null, rows: [] };
  const headers = csv[0].map((header) => header.trim().toLowerCase());
  const at = (cells: string[], header: string): string => cells[headers.indexOf(header)] ?? '';
  const rows: Array<Record<(typeof HOLDINGS_HEADERS)[number], string>> = [];
  let asOf: string | null = null;
  let netAssets: number | null = null;
  let sharesOutstanding: number | null = null;
  for (const cells of csv.slice(1)) {
    const name = cleanText(at(cells, 'security_name'));
    if (!name) continue;
    const date = cleanText(at(cells, 'date'));
    const shares = numberOrNull(at(cells, 'shares'));
    const marketValue = numberOrNull(at(cells, 'market_value'));
    const weight = numberOrNull(at(cells, 'weightings'));
    const moneyMarket = /^(?:1|true|yes)$/i.test(cleanText(at(cells, 'money_market_flag')));
    const sector = cleanText(at(cells, 'sector'));
    if (!asOf) asOf = calendarIso(date);
    if (netAssets === null) netAssets = numberOrNull(at(cells, 'net_assets'));
    if (sharesOutstanding === null) sharesOutstanding = numberOrNull(at(cells, 'shares_outstanding'));
    rows.push({
      Name: name,
      Ticker: cleanText(at(cells, 'stock_ticker')) || '—',
      Identifier: cleanText(at(cells, 'cusip')) || '—',
      Weight: formatPercent(weight),
      'Market Value': formatMoney(marketValue),
      'Shares Held': formatShares(shares),
      'Asset Category': moneyMarket ? 'Money Market' : (sector || '—'),
    });
  }
  if (netAssets === null && rows.length) {
    const sum = csv.slice(1).reduce((total, cells) => total + (numberOrNull(at(cells, 'market_value')) ?? 0), 0);
    netAssets = sum || null;
  }
  return { asOf, netAssets, sharesOutstanding, rows };
}

export function parseYahooChart(json: unknown): ParsedYahooChart {
  const data = json as { chart?: { result?: Array<Record<string, any>> } };
  const result = data?.chart?.result?.[0];
  if (!result) return { history: [], dividends: [], exchange: null, firstTradeDate: null };
  const timestamps: unknown[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjusted: unknown[] = Array.isArray(result.indicators?.adjclose?.[0]?.adjclose) ? result.indicators.adjclose[0].adjclose : [];
  const history: YahooHistoryRow[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const unix = Number(timestamps[index]);
    if (!Number.isFinite(unix)) continue;
    const date = new Date(unix * 1000).toISOString().slice(0, 10);
    const close = round(numberOrNull(quote.close?.[index]));
    const adjCloseRaw = numberOrNull(adjusted[index] ?? quote.close?.[index]);
    const adjClose = round(adjCloseRaw);
    const volume = numberOrNull(quote.volume?.[index]);
    if (close === null && adjClose === null) continue;
    history.push({ date, close, adjClose, volume: volume === null ? null : Math.trunc(volume), adjCloseRaw });
  }
  const dividends: YahooDistribution[] = Object.entries(result.events?.dividends ?? {})
    .map(([timestamp, event]) => {
      const record = event as { amount?: unknown; date?: unknown };
      const unix = Number(record.date ?? timestamp);
      const date = new Date(unix * 1000).toISOString().slice(0, 10);
      const amount = round(numberOrNull(record.amount)) ?? 0;
      return { date, amount };
    })
    .filter((item) => item.amount !== 0 && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    history: history.sort((a, b) => b.date.localeCompare(a.date)),
    dividends,
    exchange: cleanText(result.meta?.fullExchangeName ?? result.meta?.exchangeName) || null,
    firstTradeDate: Number(result.meta?.firstTradeDate) > 0 ? new Date(Number(result.meta.firstTradeDate) * 1000).toISOString().slice(0, 10) : null,
  };
}

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;
export function keepPublishedAdjClose(history: YahooHistoryRow[], published: Array<Record<string, unknown>>): YahooHistoryRow[] {
  const prior = new Map(published.map((row) => [String(row.Date ?? ''), numberOrNull(row['Adj Close'])]));
  return history.map((row) => {
    const priorAdj = prior.get(row.date) ?? null;
    const raw = row.adjCloseRaw ?? row.adjClose;
    if (priorAdj === null || row.adjClose === null || raw === null || row.adjClose === priorAdj) return row;
    return Math.abs(raw - priorAdj) <= 0.005 + ADJ_CLOSE_NOISE ? { ...row, adjClose: priorAdj } : row;
  });
}

/**
 * The Themes holdings sheet of an N-PORT filing (shared nport-reader block): HOLDINGS_HEADERS, the position's own identifier,
 * tickers from nportTickers (U.S. equities only); a missing number stays empty (never 0), a missing text is '—'.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): ParsedHoldings {
  return {
    asOf: filing.repPdDate || null,
    netAssets: filing.netAssets,
    sharesOutstanding: null,
    rows: filing.positions.map((position, index) => ({
      Name: position.name || '—',
      Ticker: tickers[index] || '—',
      Identifier: nportIdentifier(position) || '—',
      Weight: nportCell(position.weight),
      'Market Value': nportCell(position.value, 2),
      'Shares Held': nportCell(position.balance),
      'Asset Category': position.assetCat || '—',
    })),
  };
}

/**
 * Q25: a HISTORY_RANGE window keeps the older published history and distributions (shared windowed-chart block). Joined days
 * keep their published Close and Volume cells, so a windowed rerun writes nothing; null = the window does not join the
 * published history, the caller then keeps history, distributions and returns as published.
 */
export function joinHistoryWindow(yahoo: ParsedYahooChart, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<Record<string, unknown>>): ParsedYahooChart | null {
  const fresh = yahoo.history.filter((row) => row.close !== null && row.adjClose !== null).sort((a, b) => a.date.localeCompare(b.date));
  if (!fresh.length) return yahoo;
  const epoch = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 1000;
  const merged = mergeWindowedChart(
    {
      days: fresh.map((row) => ({ date: row.date, close: row.close ?? 0, adjClose: row.adjClose ?? 0, volume: row.volume ?? 0, adjCloseRaw: row.adjCloseRaw ?? row.adjClose ?? 0 })),
      dividends: yahoo.dividends.map((dividend) => ({ epoch: epoch(dividend.date), amount: dividend.amount })),
    },
    published,
    publishedDistributions.map((row) => [row['Ex-Date'], row.Amount]),
  );
  if (!merged) return null;
  const firstFresh = fresh[0].date;
  const volumes = new Map(published.map((row) => [calendarIso(row.Date) ?? '', numberOrNull(row.Volume)] as [string, number | null]));
  const older: YahooHistoryRow[] = merged.days.filter((day) => day.date < firstFresh).map((day) => ({ date: day.date, close: day.close, adjClose: day.adjClose, volume: volumes.has(day.date) ? volumes.get(day.date) ?? null : day.volume, adjCloseRaw: day.adjCloseRaw ?? day.adjClose }));
  const history = yahoo.history.concat(older).sort((a, b) => b.date.localeCompare(a.date));
  const dividends = merged.dividends.map((dividend) => ({ date: new Date(dividend.epoch * 1000).toISOString().slice(0, 10), amount: dividend.amount })).sort((a, b) => b.date.localeCompare(a.date));
  return { ...yahoo, history, dividends };
}

export function formatDividendFrequency(value: unknown): string {
  const text = cleanText(value).toLowerCase();
  if (!text || /^(?:-|—|--|none|null|n\/a)$/.test(text)) return '00 - None';
  if (text === 'unknown') return '00 - Unknown';
  if (text.includes('month')) return '01 - Monthly';
  if (text.includes('quarter')) return '04 - Quarterly';
  if (text.includes('semi') || text.includes('half')) return '06 - Semi-annually';
  if (text.includes('annual') || text.includes('year')) return '12 - Annually';
  return '00 - Unknown';
}

export function inferDistributionFrequency(dividends: YahooDistribution[], now = new Date()): string {
  const actual = dividends.filter((entry) => entry.amount !== 0 && new Date(entry.date).getTime() <= now.getTime());
  if (actual.length < 2) return '00 - None';
  const ascending = [...actual].sort((a, b) => a.date.localeCompare(b.date));
  const gaps: number[] = [];
  for (let index = 1; index < ascending.length; index += 1) {
    const days = (new Date(ascending[index].date).getTime() - new Date(ascending[index - 1].date).getTime()) / 86_400_000;
    if (days > 0) gaps.push(days);
  }
  if (!gaps.length) return '00 - None';
  const average = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  if (average <= 45) return '01 - Monthly';
  if (average <= 120) return '04 - Quarterly';
  if (average <= 220) return '06 - Semi-annually';
  return '12 - Annually';
}

/** The oldest row may sit a few days after the window start (weekend, holiday, first trading day), never further. */
export const HISTORY_START_TOLERANCE_DAYS = 5;

/** A placeholder history (every adjusted close identical) carries no return information. */
export function isFlatHistory(history: YahooHistoryRow[]): boolean {
  const closes = history.map((row) => row.adjClose).filter((value): value is number => value !== null && Number.isFinite(value));
  return closes.length >= 2 && closes.every((value) => value === closes[0]);
}

/**
 * Return from the close on or before `from` to the latest close. Null when the
 * history does not reach back to `from` (fund younger than the window, or a
 * shortened HISTORY_RANGE) or when the history is a flat placeholder: a
 * since-inception number is never published as a 3Y/5Y/10Y return.
 */
export function calculateReturn(history: YahooHistoryRow[], from: Date): number | null {
  const usable = history.filter((row) => row.adjClose !== null && Number.isFinite(row.adjClose));
  if (usable.length < 2 || isFlatHistory(usable)) return null;
  const latest = usable[0];
  const target = from.getTime();
  const dayOf = (row: YahooHistoryRow): number => new Date(`${row.date}T00:00:00Z`).getTime();
  let earlier = usable.find((row) => dayOf(row) <= target);
  if (!earlier) {
    const oldest = usable[usable.length - 1];
    if (dayOf(oldest) - target > HISTORY_START_TOLERANCE_DAYS * 86_400_000) return null;
    earlier = oldest;
  }
  if (earlier === latest || !latest.adjClose || !earlier.adjClose) return null;
  return round(((latest.adjClose / earlier.adjClose) - 1) * 100);
}

export function deriveReturns(history: YahooHistoryRow[], now = new Date()): Record<string, number | null> {
  const ytdStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const yearsAgo = (years: number) => new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  const ytd = calculateReturn(history, ytdStart);
  const yr1 = calculateReturn(history, yearsAgo(1));
  const yr3 = calculateReturn(history, yearsAgo(3));
  const yr5 = calculateReturn(history, yearsAgo(5));
  const yr10 = calculateReturn(history, yearsAgo(10));
  const annualized = (value: number | null, years: number): number | null => value === null ? null : round((Math.pow(1 + value / 100, 1 / years) - 1) * 100);
  return { ytd, yr1, yr3, yr5, yr10, cagr3: annualized(yr3, 3), cagr5: annualized(yr5, 5), cagr10: annualized(yr10, 10) };
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(?:1|true|yes|on)$/i.test(value);
}

function positiveInt(value: string | undefined, fallback: number, minimum = 0): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function parseAmount(raw: string): number | null {
  const text = raw.trim().replace(/[$,\s]/g, '');
  const match = text.match(/^(-?[\d.]+)([kmbt])?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const multiplier = ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 } as Record<string, number>)[(match[2] ?? '').toLowerCase()] ?? 1;
  return number * multiplier;
}

export function parseRange(raw: string | undefined, label: string): Range | undefined {
  const source = (raw ?? '').trim();
  if (!source || source === ':') return undefined;
  const pieces = source.split(':');
  if (pieces.length !== 2) throw new Error(`${label} must use min:max syntax`);
  const [minimum, maximum] = pieces.map((part) => Number(part.trim()));
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) throw new Error(`${label} requires finite numeric bounds`);
  if (minimum > maximum) throw new Error(`${label} minimum cannot exceed maximum`);
  return { min: minimum, max: maximum };
}

export function parseAumRange(raw: string | undefined): Range | undefined {
  const source = (raw ?? '').trim().toLowerCase();
  if (!source || source === ':') return undefined;
  const presets: Record<string, Range> = {
    nano: { min: 0, max: 10e6 },
    micro: { min: 10e6, max: 300e6 },
    small: { min: 300e6, max: 2e9 },
    mid: { min: 2e9, max: 10e9 },
    large: { min: 10e9, max: Number.MAX_VALUE },
  };
  if (presets[source]) return presets[source];
  const pieces = source.split(':');
  if (pieces.length !== 2) throw new Error('AUM must use min:max syntax or an AUM preset');
  const minimum = pieces[0] ? parseAmount(pieces[0]) : 0;
  const maximum = pieces[1] ? parseAmount(pieces[1]) : Number.MAX_VALUE;
  if (minimum === null || maximum === null || minimum > maximum) throw new Error('AUM requires valid min:max bounds');
  return { min: minimum, max: maximum };
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  const value = (name: keyof typeof DEFAULTS): string => {
    const candidate = env[name];
    return candidate === undefined || candidate.trim() === '' ? DEFAULTS[name] : candidate.trim();
  };
  const tickers = new Set(value('TICKERS').split(/[\s,]+/).map(sanitizeTicker).filter(Boolean));
  const performanceRanges: Record<string, Range | undefined> = {};
  const totalReturnRanges: Record<string, Range | undefined> = {};
  for (const period of rangePeriods) {
    performanceRanges[period] = parseRange(value(`PERFORMANCE_${period}`), `PERFORMANCE_${period}`);
    totalReturnRanges[period] = parseRange(value(`TOTAL_RETURN_${period}`), `TOTAL_RETURN_${period}`);
  }
  return {
    maxFetches: positiveInt(value('MAX_FETCHES'), 0, 0),
    requestSleepMs: Math.max(0, Number(value('REQUEST_SLEEP')) || 0) * 1000,
    concurrency: positiveInt(value('CONCURRENCY'), 2, 1),
    maxRetries: positiveInt(value('MAX_RETRIES'), 3, 1),
    tickers,
    category: value('CATEGORY').toLowerCase(),
    aumRange: parseAumRange(value('AUM')),
    terRange: parseRange(value('TER'), 'TER'),
    dividendYieldRange: parseRange(value('DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(value('SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges,
    totalReturnRanges,
    holdingsPageSize: positiveInt(value('HOLDINGS_PAGE_SIZE'), 250, 1),
    historyPageSize: positiveInt(value('HISTORY_PAGE_SIZE'), 1000, 1),
    historyRange: value('HISTORY_RANGE').toLowerCase(),
    edgarFallback: bool(value('EDGAR_FALLBACK'), true),
    skipYahoo: bool(value('SKIP_YAHOO'), false),
    skipThemes: bool(value('SKIP_THEMES'), false),
    secUserAgent: value('SEC_UA'),
    verbose: bool(value('VERBOSE'), false),
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
  };
}

// File defaults and explicit overrides: allowlisted scalar controls only, so GitHub Actions
// can resolve them without interpolating user input into bash. Precedence: config file <
// advanced JSON < nonblank named inputs < environment.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_THEMES', 'SEC_UA', 'VERBOSE', 'USE_SYSTEM_CA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
// Environment aliases of every control: THEMES_<NAME> plus the legacy HISTORICAL_PAGE_SIZE. They sit in the
// environment layer; the plain name wins when both are set, and an explicitly empty alias counts as set.
export const ENV_ALIASES: Record<string, string[]> = { HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'] };
export const envNames = (key: string): string[] => [key, `THEMES_${key}`, ...(ENV_ALIASES[key] ?? [])];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = envNames(key).map((name) => env[name]).find((candidate) => candidate !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key];
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['SKIP_YAHOO', 'SKIP_THEMES', 'EDGAR_FALLBACK', 'VERBOSE']) {
    if (result[key] && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key])) throw new Error(`${key}: expected boolean`);
  }
  if (result.HISTORY_RANGE && !/^(max|[1-9]\d*y)$/i.test(result.HISTORY_RANGE)) throw new Error('HISTORY_RANGE: expected max or Ny');
  if (result.USE_SYSTEM_CA && !/^(auto|true|false)$/i.test(result.USE_SYSTEM_CA)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

/** Resolves file defaults plus environment overrides; a missing config file is an error. */
export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file: unknown = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8'));
  return resolveControls(file, {}, {}, env);
}

function inRange(value: number | null | undefined, range?: Range): boolean {
  return !range || (value !== null && value !== undefined && Number.isFinite(value) && value >= range.min && value <= range.max);
}

function catalogPassesFilters(fund: CatalogFund, config: UpdaterConfig): boolean {
  return (!config.category || fund.category.toLowerCase().includes(config.category))
    && inRange(fund.terValue, config.terRange);
}

function hasDeferredFilters(config: UpdaterConfig): boolean {
  return Boolean(config.aumRange || config.dividendYieldRange || config.secYieldRange || Object.values(config.performanceRanges).some(Boolean) || Object.values(config.totalReturnRanges).some(Boolean));
}

function fundPassesDeferredFilters(entry: Record<string, any>, config: UpdaterConfig): boolean {
  const metrics = entry.metrics ?? {};
  const returns = entry.returns?.monthEnd ?? {};
  const values: Record<string, number | null | undefined> = {
    YTD: metrics.ytd,
    '1Y': metrics.tr1y,
    '3Y': metrics.tr3y,
    '5Y': metrics.tr5y,
    '10Y': metrics.tr10y,
  };
  if (!inRange(entry.aumValue, config.aumRange) || !inRange(metrics.dividendYield, config.dividendYieldRange) || !inRange(metrics.secYield, config.secYieldRange)) return false;
  for (const period of rangePeriods) {
    if (!inRange(values[period], config.totalReturnRanges[period])) return false;
    if (!inRange(returns[{ YTD: 'ytd', '1Y': 'yr1', '3Y': 'yr3', '5Y': 'yr5', '10Y': 'yr10' }[period]], config.performanceRanges[period])) return false;
  }
  return true;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Each worker receives a reservation in one of the independently paced lanes. */
export function createRequestGate(concurrency: number, requestSleepMs: number): () => Promise<void> {
  const nextStarts = new Array(Math.max(1, concurrency)).fill(0) as number[];
  return async (): Promise<void> => {
    let lane = 0;
    for (let index = 1; index < nextStarts.length; index += 1) if (nextStarts[index] < nextStarts[lane]) lane = index;
    const now = Date.now();
    const scheduled = Math.max(now, nextStarts[lane]);
    nextStarts[lane] = scheduled + requestSleepMs;
    const wait = scheduled - now;
    if (wait > 0) await sleep(wait);
  };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message = `HTTP ${status}`) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function fetchWithRetry<T = Response>(
  url: string,
  options: RequestInit,
  config: Pick<UpdaterConfig, 'maxRetries' | 'requestSleepMs' | 'verbose'> & { fetchTimeoutMs?: number },
  gate?: () => Promise<void>,
  consume?: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  const timeoutMs = config.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      if (gate) await gate();
      // the signal stays armed while `consume` reads the body, so a stalled body times out too
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return consume ? await consume(response) : response as T;
      lastError = new HttpError(response.status);
      if (![408, 425, 429].includes(response.status) && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && ![408, 425, 429].includes(error.status) && error.status < 500) throw error;
    }
    if (attempt < config.maxRetries) {
      note(`retry ${attempt + 1}/${config.maxRetries}: ${url}`);
      await sleep(Math.max(250, config.requestSleepMs) * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

const GENERIC_UA = 'Mozilla/5.0 (compatible; ThemesETFs-static-feed/1.0)';

async function fetchText(url: string, config: UpdaterConfig, gate?: () => Promise<void>, headers: HeadersInit = {}): Promise<string> {
  return fetchWithRetry(url, {
    headers: {
      'User-Agent': GENERIC_UA,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      ...headers,
    },
  }, config, gate, (response) => response.text());
}

async function fetchJson(url: string, config: UpdaterConfig, gate?: () => Promise<void>, headers: HeadersInit = {}): Promise<unknown> {
  return fetchWithRetry(url, {
    headers: {
      'User-Agent': GENERIC_UA,
      Accept: 'application/json',
      ...headers,
    },
  }, config, gate, (response) => response.json() as Promise<unknown>);
}

// ---------------------------------------------------------------------------
// Official-site access: direct first, read-only r.jina.ai rendering proxy when
// the issuer WAF blocks this network (themesetfs.com answers GitHub-hosted
// runner IPs with HTTP 403 while working from residential networks)
// ---------------------------------------------------------------------------

export const PROXY_PREFIX = 'https://r.jina.ai/';
export const PROXY_SLEEP_MS = 3200; // r.jina.ai anonymous tier is ~20 requests per minute
const DIRECT_DENIAL_LIMIT = 2;

export const proxyUrl = (url: string): string => `${PROXY_PREFIX}${url}`;

/** One global gate for every worker: proxy request starts are at least minMs apart. */
export function createProxyGate(minMs: number): () => Promise<void> {
  let next = 0;
  return async (): Promise<void> => {
    const now = Date.now();
    const scheduled = Math.max(now, next);
    next = scheduled + minMs;
    if (scheduled > now) await sleep(scheduled - now);
  };
}

const issuerState = { directDenials: 0, proxyRejectsFile: false };

export function resetIssuerState(): void {
  issuerState.directDenials = 0;
  issuerState.proxyRejectsFile = false;
}

/** Statuses (and network errors) after which the proxy is worth trying; 404 and friends are final. */
export function proxyEligible(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 403 || error.status === 429 || error.status >= 500;
  return true;
}

/**
 * One direct request on the caller's lane first; on HTTP 403 / 429 / 5xx, a
 * network error or an unusable body, the same public URL through the proxy
 * (global gate, retried at most once). After two direct 403 answers the direct
 * attempt is skipped for the rest of the run.
 */
export async function fetchOfficialText(
  url: string,
  config: UpdaterConfig,
  gate: () => Promise<void>,
  proxyGate: () => Promise<void>,
  validate: (text: string, via: 'direct' | 'proxy') => boolean,
  headers: HeadersInit = {},
): Promise<{ text: string; via: 'direct' | 'proxy' }> {
  let directError = 'direct request skipped (official site denies this network)';
  if (issuerState.directDenials < DIRECT_DENIAL_LIMIT) {
    try {
      const text = await fetchText(url, config, gate, headers);
      if (validate(text, 'direct')) { issuerState.directDenials = 0; return { text, via: 'direct' }; }
      directError = 'direct response did not contain the expected content';
    } catch (error) {
      if (!proxyEligible(error)) throw error;
      directError = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpError && error.status === 403) {
        issuerState.directDenials += 1;
        if (issuerState.directDenials === DIRECT_DENIAL_LIMIT) note('direct requests are denied from this network; using the read-only rendering proxy for the rest of the run');
      }
    }
  }
  if (issuerState.proxyRejectsFile && /\.csv(?:$|\?)/i.test(url)) throw new Error(`${directError}; proxy skipped (it cannot render CSV downloads)`);
  try {
    const raw = await fetchText(proxyUrl(url), { ...config, maxRetries: Math.min(1, config.maxRetries) }, proxyGate, {
      // generic UA only: the SEC contact is never sent to the third-party proxy
      'User-Agent': GENERIC_UA,
      Accept: 'text/plain,text/markdown;q=0.9,*/*;q=0.8',
    });
    const text = stripProxyPreamble(raw);
    if (validate(text, 'proxy')) return { text, via: 'proxy' };
    throw new Error('proxy response did not contain the expected content');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError && error.status === 422) issuerState.proxyRejectsFile = true;
    throw new Error(`${directError}; proxy: ${message}`);
  }
}

async function fetchThemesCatalog(config: UpdaterConfig, gate: () => Promise<void>, proxyGate: () => Promise<void>): Promise<{ funds: CatalogFund[]; via: 'direct' | 'proxy' }> {
  const parsedByVia = (text: string, via: 'direct' | 'proxy'): CatalogFund[] => via === 'direct' ? parseThemesCatalog(text) : parseThemesCatalogMarkdown(text);
  const fetched = await fetchOfficialText(THEMES_CATALOG_URL, config, gate, proxyGate, (text, via) => parsedByVia(text, via).length > 0);
  return { funds: parsedByVia(fetched.text, fetched.via), via: fetched.via };
}

// ---------------------------------------------------------------------------
// SEC EDGAR Form N-PORT-P fallback: the shared nport-reader block at the end of this file finds, reads and checks the filing
// ---------------------------------------------------------------------------

export const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (main and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUserAgent || SEC_UA_DEFAULT };
}

/** SEC's fund ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: UpdaterConfig, gate: () => Promise<void>): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = fetchJson(SEC_FUND_TICKERS_URL, config, gate, secHeaders(config)).then((payload) => parseSecFundTickers(payload));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(config: UpdaterConfig, gate: () => Promise<void>): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = fetchJson(SEC_COMPANY_TICKERS_URL, config, gate, secHeaders(config)).then((payload) => parseSecCompanyNames(payload));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/**
 * The fund's own newest N-PORT-P filing as a holdings sheet, read only when its report period is strictly newer than the
 * published holdings (`publishedAsOf` ISO, the date of whatever sheet is published: the issuer's daily CSV or an earlier
 * N-PORT). Identity by the series id of SEC's fund ticker table, by the fund name only when the table has no entry; the
 * registrant falls back to the Themes ETF Trust. Returns the sheet or why there is none.
 */
async function readThemesNport(fund: CatalogFund, publishedAsOf: string | null, publishedRows: number, config: UpdaterConfig, gate: () => Promise<void>): Promise<{ holdings: ParsedHoldings; url: string; accession: string } | { problem: string }> {
  const ref = (await loadFundTickerTable(config, gate).catch(() => null))?.get(fund.ticker) ?? null;
  const read = await readNportHoldings(
    { ticker: fund.ticker, cik: ref?.cik ?? THEMES_ETF_TRUST_CIK, seriesId: ref?.seriesId ?? null, name: ref ? null : fund.name },
    { asOf: publishedAsOf, rows: publishedRows },
    (url) => fetchText(url, config, gate, secHeaders(config)),
    { cache: secState.reader },
  );
  if ('problem' in read) return read;
  const names = await loadCompanyNames(config, gate).catch(() => null);
  return { holdings: nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, names)), url: read.url, accession: read.candidate.accession };
}

function pages<T>(rows: T[], pageSize: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += pageSize) output.push(rows.slice(index, index + pageSize));
  return output;
}

export function pageFileName(index: number): string {
  return `${String(index).padStart(3, '0')}.json`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).filter((key) => !VOLATILE_KEYS.has(key)).sort().map((key) => [key, comparable(record[key])]));
  }
  return value;
}

export function samePublishedContent(previous: unknown, candidate: unknown): boolean {
  return JSON.stringify(comparable(previous)) === JSON.stringify(comparable(candidate));
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
}

export async function writeJsonIfChanged(file: string, value: unknown): Promise<'written' | 'unchanged'> {
  const previous = await readJson<unknown>(file);
  if (previous !== null && samePublishedContent(previous, value)) return 'unchanged';
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, stableStringify(value), 'utf8');
  await rename(temporary, file);
  return 'written';
}

async function prunePages(dir: string, count: number): Promise<void> {
  if (!existsSync(dir)) return;
  const files = await readdir(dir).catch(() => []);
  await Promise.all(files.filter((file) => /^\d{3}\.json$/.test(file) && Number(file.slice(0, 3)) > count).map((file) => rm(path.join(dir, file))));
}

type PagedSheet = { manifest: { pages: string[]; pageSize: number; totalRows: number }; write: () => Promise<void>; prune: () => Promise<void> };

/** Plans a paged sheet in memory: `write` stores the pages, `prune` removes stale ones (call only after the new meta.json is written). */
function planPagedSheet<T extends Record<string, unknown>>(ticker: string, sheet: 'holdings' | 'history', headers: readonly string[], rows: T[], pageSize: number): PagedSheet {
  const chunks = pages(rows, pageSize);
  const dir = path.join(API_ROOT, 'funds', ticker, sheet);
  return {
    manifest: { pages: chunks.map((_, index) => `./${sheet}/${pageFileName(index + 1)}`), pageSize, totalRows: rows.length },
    write: async () => {
      await mkdir(dir, { recursive: true });
      for (let index = 0; index < chunks.length; index += 1) {
        await writeJsonIfChanged(path.join(dir, pageFileName(index + 1)), {
          ticker,
          page: index + 1,
          pageSize,
          totalRows: rows.length,
          headers,
          rows: chunks[index],
        });
      }
    },
    prune: () => prunePages(dir, chunks.length),
  };
}

function isoDisplayDate(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

function dividendsWorksheet(dividends: YahooDistribution[]): { frequency: string; paymentsPerYear: number | null; headers: string[]; rows: Array<Record<string, string>> } {
  const frequency = inferDistributionFrequency(dividends);
  const paymentsPerYear = frequency.startsWith('01') ? 12 : frequency.startsWith('04') ? 4 : frequency.startsWith('06') ? 2 : frequency.startsWith('12') ? 1 : null;
  return {
    frequency,
    paymentsPerYear,
    headers: ['Ex-Date', 'Amount'],
    rows: dividends.map((dividend) => ({ 'Ex-Date': dividend.date, Amount: `$${dividend.amount.toFixed(4)}` })),
  };
}

export function trailingDividendYield(dividends: YahooDistribution[], nav: number | null, now = new Date()): number | null {
  if (!nav || nav <= 0) return null;
  const twelveMonthsAgo = now.getTime() - 366 * 86_400_000;
  const amount = dividends.filter((item) => new Date(`${item.date}T00:00:00Z`).getTime() >= twelveMonthsAgo).reduce((sum, item) => sum + item.amount, 0);
  // no distribution event in the last 12 months is "unknown", not a published 0.00% yield
  return amount > 0 ? round((amount / nav) * 100) : null;
}

/** Labels data kept from an earlier publication; idempotent across repeated retained runs. */
export function retainedLabel(previous: unknown): string {
  const base = String(previous ?? '').replace(/\s*\(retained[^)]*\)\s*$/, '').trim() || 'previously published data';
  return `${base} (retained: official source unavailable in the latest run)`;
}

function existingManifest(meta: any, key: 'holdings' | 'history'): Record<string, unknown> | null {
  const value = meta?.[key];
  return value && typeof value === 'object' && Array.isArray(value.pages) ? value : null;
}

/** Rows of a previously published paged sheet; a missing or unreadable page contributes nothing. */
async function publishedRows(fundDir: string, manifest: Record<string, unknown> | null): Promise<Array<Record<string, unknown>>> {
  const files = Array.isArray(manifest?.pages) ? (manifest.pages as unknown[]).map(String) : [];
  const chunks = await Promise.all(files.map((page) => readJson<{ rows?: unknown }>(path.join(fundDir, page))));
  return chunks.flatMap((chunk) => (Array.isArray(chunk?.rows) ? (chunk.rows as Array<Record<string, unknown>>) : []));
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export const RETURNS_BASIS = 'derived from Yahoo Finance adjusted market-price closes (estimate, not official Themes ETFs NAV total returns)';

/** Mandatory metrics tail: returnsBasis, then performanceAsOf (last Yahoo close date the returns are computed to, not the NAV date; null when unknown). */
export function performanceFields(asOf: unknown): { returnsBasis: string; performanceAsOf: string | null } {
  const date = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null;
  return { returnsBasis: RETURNS_BASIS, performanceAsOf: date };
}

/** Rewrites metrics so returnsBasis and performanceAsOf are always present and last. */
export function withPerformanceFields(metrics: Record<string, unknown> | null | undefined, asOf: unknown): Record<string, unknown> {
  const { returnsBasis: _basis, performanceAsOf: _asOf, ...rest } = metrics ?? {};
  return { ...rest, ...performanceFields(asOf) };
}

function buildCatalogEntry(meta: Record<string, any>): Record<string, unknown> {
  return {
    ticker: meta.ticker,
    name: meta.name,
    category: meta.category,
    fundPage: meta.fundPage,
    dataFile: meta.dataFile,
    ter: meta.ter,
    terValue: meta.terValue,
    nav: meta.nav?.display ?? meta.nav,
    navValue: meta.navValue,
    aum: meta.aum?.display ?? meta.aum,
    aumValue: meta.aumValue,
    asOfDate: meta.asOfDate,
    inceptionDate: meta.inceptionDate ?? null,
    exchange: meta.exchange ?? null,
    closePrice: meta.closePrice,
    closePriceValue: meta.closePriceValue,
    distributions: {
      frequency: meta.distributions?.frequency ?? '00 - None',
      paymentsPerYear: meta.distributions?.paymentsPerYear ?? null,
      exDate: meta.distributions?.rows?.[0]?.['Ex-Date'] ?? null,
      dividend: meta.distributions?.rows?.[0]?.Amount ?? null,
    },
    returns: meta.returns,
    metrics: meta.metrics,
    distributionFrequency: meta.distributionFrequency,
    providerCategory: meta.providerCategory,
    holdings: meta.holdings?.totalRows ?? 0,
    history: meta.history?.totalRows ?? 0,
    navKind: meta.navKind,
  };
}

export type DividendYieldBasis = 'computed-trailing-12m';

/** Themes publishes no yield: every non-null dividendYield is the updater's trailing-12-month sum over catalog NAV; null yield -> null basis. */
export function dividendYieldBasisFor(dividendYield: unknown): DividendYieldBasis | null {
  return typeof dividendYield === 'number' && Number.isFinite(dividendYield) ? 'computed-trailing-12m' : null;
}

/** Full metrics key set with every value unavailable (null, never 0). */
export function emptyMetrics(asOf: unknown = null): Record<string, unknown> {
  return {
    ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null,
    cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null,
    dividendYield: null, dividendYieldText: '—',
    distributionYield: null, distributionYieldText: '—',
    yield12M: null, yield12MText: '—',
    dividendYieldBasis: null,
    secYield: null, secYieldText: '—',
    ...performanceFields(asOf),
  };
}

/** Catalog-only row for a fund that has no funds/<T>/meta.json: dataFile is null and all metrics are unavailable. */
export function skeletonEntry(fund: CatalogFund): Record<string, unknown> {
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: null,
    ter: fund.terValue === null ? '—' : `${fund.terValue.toFixed(2)}%`,
    terValue: fund.terValue,
    nav: formatMoney(fund.navValue),
    navValue: fund.navValue,
    aum: '—',
    aumValue: null,
    closePrice: formatMoney(fund.closePriceValue),
    closePriceValue: fund.closePriceValue,
    distributions: { frequency: '00 - None', paymentsPerYear: null, exDate: null, dividend: null },
    metrics: emptyMetrics(),
    holdings: 0,
    history: 0,
  };
}

type PreparedFund = { entry: Record<string, unknown>; reason?: string; commit: () => Promise<void> };

/**
 * Computes a fund completely in memory (all sources fetched, nothing written).
 * `commit` then writes pages first, meta.json next and prunes stale pages last,
 * so a fund is either fully updated or left exactly as published before.
 */
async function prepareFund(fund: CatalogFund, config: UpdaterConfig, gate: () => Promise<void>, proxyGate: () => Promise<void>): Promise<PreparedFund> {
  const fundDir = path.join(API_ROOT, 'funds', fund.ticker);
  const prior = await readJson<Record<string, any>>(path.join(fundDir, 'meta.json'));
  let holdings: ParsedHoldings | null = null;
  let holdingsSource = '';
  let fallbackReason = '';

  if (!config.skipThemes) {
    try {
      const csv = await fetchOfficialText(THEMES_HOLDINGS_URL(fund.ticker), config, gate, proxyGate, (text) => parseThemesHoldingsCsv(text).rows.length > 0, { Accept: 'text/csv,*/*;q=0.8' });
      holdings = parseThemesHoldingsCsv(csv.text);
      holdingsSource = `official Themes ETFs daily holdings CSV${csv.via === 'proxy' ? ' (via read-only rendering proxy)' : ''}`;
    } catch (error) {
      fallbackReason = `official holdings unavailable: ${error instanceof Error ? error.message : String(error)}`;
      note(`${fund.ticker}: ${fallbackReason}`);
    }
  }

  let holdingsUrl = THEMES_HOLDINGS_URL(fund.ticker);
  if (!holdings && config.edgarFallback) {
    try {
      // the fund's own newest filing, only when strictly newer than the published sheet (an issuer CSV is usually newer)
      const publishedAsOf = calendarIso(prior?.holdings?.asOf) ?? calendarIso(prior?.holdings?.asOfDate);
      const read = await readThemesNport(fund, publishedAsOf, asNumber(prior?.holdings?.totalRows) ?? 0, config, gate);
      if ('problem' in read) note(read.problem);
      else {
        holdings = read.holdings;
        holdingsUrl = read.url;
        holdingsSource = `SEC EDGAR Form N-PORT-P (${THEMES_ETF_TRUST}, accession ${read.accession}, report period ${read.holdings.asOf ?? 'n/a'})`;
      }
    } catch (error) {
      note(`${fund.ticker}: SEC fallback unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Fresh holdings (official CSV, direct or via the proxy, or N-PORT) that look broken (no weight column, non-numeric
  // weights, a bad weight sum, half the rows gone) never replace the published ones: the fund fails before anything is written.
  const priorHoldings = existingManifest(prior, 'holdings');
  const publishedWeights = holdings && priorHoldings ? holdingsWeightCount(HOLDINGS_HEADERS, await publishedRows(fundDir, priorHoldings)) : null;
  const holdingsProblem = holdings ? holdingsGuard(HOLDINGS_HEADERS, holdings.rows, asNumber(prior?.holdings?.totalRows), HOLDINGS_GUARD_RELAX[fund.ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights) : null;
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${prior ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

  let yahoo: ParsedYahooChart | null = null;
  if (!config.skipYahoo) {
    try {
      const parsed = parseYahooChart(await fetchJson(yahooChartUrl(fund.ticker, config.historyRange), config, gate));
      if (!parsed.history.length) throw new Error('chart response contained no price rows');
      yahoo = parsed;
    }
    catch (error) { note(`${fund.ticker}: Yahoo history unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const retainedHoldings = !holdings && Boolean(priorHoldings);
  const retainedSource = (previous: unknown): string => fallbackReason ? retainedLabel(previous) : (String(previous ?? '') || 'previously published data');
  if (retainedHoldings) note(`${fund.ticker}: keeping previously published holdings (${fallbackReason || 'no refresh attempted'})`);
  const priorHistory = existingManifest(prior, 'history');
  if (yahoo && priorHistory) {
    const published = await publishedRows(fundDir, priorHistory);
    // A HISTORY_RANGE window never shrinks the published history (and with it 3y, 5y, 10y and the distributions)
    const joined = /^\d+y$/.test(config.historyRange) ? joinHistoryWindow(yahoo, published, Array.isArray(prior?.distributions?.rows) ? prior.distributions.rows : []) : yahoo;
    if (!joined) note(`${fund.ticker}: Yahoo window (${config.historyRange}) does not join the published history; kept the published history and returns`);
    yahoo = joined ? { ...joined, history: keepPublishedAdjClose(joined.history, published) } : null;
  }
  if (!holdings && !priorHoldings) throw new Error(fallbackReason || 'no current or previously published holdings data');

  const sheets: PagedSheet[] = [];
  let holdingsManifest = priorHoldings;
  if (holdings) {
    const sheet = planPagedSheet(fund.ticker, 'holdings', HOLDINGS_HEADERS, holdings.rows, config.holdingsPageSize);
    sheets.push(sheet);
    holdingsManifest = {
      ...sheet.manifest,
      asOfDate: isoDisplayDate(holdings.asOf),
      asOf: holdings.asOf,
      source: holdingsUrl,
      sourceKind: holdingsSource,
    };
  }

  let historyManifest = priorHistory;
  if (yahoo) {
    const rows = yahoo.history.map((row) => ({
      Date: row.date,
      Close: row.close === null ? '—' : row.close.toFixed(2),
      'Adj Close': row.adjClose === null ? '—' : row.adjClose.toFixed(2),
      Volume: row.volume === null ? '—' : String(row.volume),
    }));
    const sheet = planPagedSheet(fund.ticker, 'history', HISTORY_HEADERS, rows, config.historyPageSize);
    sheets.push(sheet);
    historyManifest = {
      ...sheet.manifest,
      asOfDate: isoDisplayDate(yahoo.history[0]?.date ?? null),
      asOf: yahoo.history[0]?.date ?? null,
      source: yahooChartProvenanceUrl(fund.ticker),
      sourceKind: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
    };
  }

  const netAssets = holdings?.netAssets ?? asNumber(prior?.aumValue) ?? asNumber(prior?.totalNetAssets);
  const sharesOutstanding = holdings?.sharesOutstanding ?? asNumber(prior?.sharesOutstanding?.value) ?? asNumber(prior?.sharesOutstanding);
  // the returns block travels as one unit: fresh from Yahoo, or entirely the previous publication (cagr included)
  const unruled: Record<string, number | null | undefined> = yahoo ? deriveReturns(yahoo.history) : {
    ...(prior?.returns?.monthEnd ?? {}),
    cagr3: asNumber(prior?.metrics?.cagr3y),
    cagr5: asNumber(prior?.metrics?.cagr5y),
    cagr10: asNumber(prior?.metrics?.cagr10y),
  };
  // the shared "younger than one year" rule on the final returns: no horizon the fund is too young for, counted from Yahoo's
  // first trade date (the listing) to the last close; a retained block was ruled when it was computed
  const returns = withoutYoungReturns(unruled, yahoo?.firstTradeDate ?? null, yahoo?.history[0]?.date ?? null, { yr1: 1, yr3: 3, yr5: 5, yr10: 10, cagr3: 3, cagr5: 5, cagr10: 10 });
  const dividendData = yahoo ? dividendsWorksheet(yahoo.dividends) : (prior?.distributions ?? { frequency: '00 - None', paymentsPerYear: null, headers: ['Ex-Date', 'Amount'], rows: [] });
  const dividendYield = yahoo ? trailingDividendYield(yahoo.dividends, fund.navValue ?? asNumber(prior?.navValue)) : asNumber(prior?.metrics?.dividendYield);
  const navValue = fund.navValue ?? asNumber(prior?.navValue);
  // a retained run keeps the dates of the published holdings: the display dates never move to the Yahoo date and back (BOTT)
  const retainedAsOf = retainedHoldings ? calendarIso(prior?.holdings?.asOf) : null;
  const asOf = holdings?.asOf ?? retainedAsOf ?? (historyManifest?.asOf as string | undefined) ?? prior?.asOf ?? null;
  const ter = fund.terValue ?? asNumber(prior?.terValue);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const meta: Record<string, any> = {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: `./funds/${fund.ticker}/meta.json`,
    ter: ter === null ? '—' : `${ter.toFixed(2)}%`,
    terValue: ter,
    nav: { display: formatMoney(navValue), value: navValue, asOfDate: isoDisplayDate(asOf), kind: 'official Themes ETFs catalog NAV' },
    navValue,
    aum: { display: formatAum(netAssets), value: netAssets, asOfDate: isoDisplayDate(holdings?.asOf ?? (prior?.holdings?.asOf ?? null)), source: holdingsSource || retainedSource(prior?.aum?.source) },
    aumValue: netAssets,
    asOfDate: isoDisplayDate(asOf),
    exchange: yahoo?.exchange ?? prior?.exchange ?? null,
    closePrice: formatMoney(fund.closePriceValue ?? asNumber(prior?.closePriceValue)),
    closePriceValue: fund.closePriceValue ?? asNumber(prior?.closePriceValue),
    totalNetAssets: netAssets,
    sharesOutstanding: { display: formatShares(sharesOutstanding), value: sharesOutstanding, asOfDate: holdings ? isoDisplayDate(holdings.asOf) : (retainedHoldings ? prior?.sharesOutstanding?.asOfDate ?? null : null) },
    distributions: dividendData,
    returns: {
      monthEnd: {
        asOfDate: historyManifest?.asOfDate ?? prior?.returns?.monthEnd?.asOfDate ?? null,
        ytd: returns.ytd ?? null,
        yr1: returns.yr1 ?? null,
        yr3: returns.yr3 ?? null,
        yr5: returns.yr5 ?? null,
        yr10: returns.yr10 ?? null,
        sinceInception: null,
        sinceInceptionCumulative: null,
      },
      quarterEnd: prior?.returns?.quarterEnd ?? { asOfDate: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null, sinceInceptionCumulative: null },
    },
    metrics: {
      ytd: returns.ytd ?? null,
      tr1y: returns.yr1 ?? null,
      tr3y: returns.yr3 ?? null,
      tr5y: returns.yr5 ?? null,
      tr10y: returns.yr10 ?? null,
      cagr3y: returns.cagr3 ?? null,
      cagr5y: returns.cagr5 ?? null,
      cagr10y: returns.cagr10 ?? null,
      siAnn: null,
      dividendYield,
      dividendYieldText: formatPercent(dividendYield),
      distributionYield: dividendYield,
      distributionYieldText: formatPercent(dividendYield),
      yield12M: dividendYield,
      yield12MText: formatPercent(dividendYield),
      dividendYieldBasis: dividendYieldBasisFor(dividendYield),
      secYield: null,
      secYieldText: '—',
      ...performanceFields(historyManifest?.asOf),
    },
    distributionFrequency: dividendData.frequency,
    providerCategory: fund.category,
    holdings: holdingsManifest ?? { pages: [], pageSize: config.holdingsPageSize, totalRows: 0, asOfDate: null },
    history: historyManifest ?? { pages: [], pageSize: config.historyPageSize, totalRows: 0, asOfDate: null },
    navKind: 'official Themes ETFs catalog NAV',
    source: {
      provider: 'Themes Management Company LLC (Themes ETFs)',
      site: THEMES_SITE,
      catalog: THEMES_CATALOG_URL,
      fundPage: fund.fundPage,
      holdingsDownload: THEMES_HOLDINGS_URL(fund.ticker),
      holdingsSource: holdingsSource || retainedSource(prior?.source?.holdingsSource),
      ...(retainedHoldings && fallbackReason ? { retained: { holdings: true, reason: fallbackReason || 'official source not refreshed' } } : {}),
      historySource: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
      historyUrl: yahooChartProvenanceUrl(fund.ticker),
      nportDoc: edgarFilingsUrl(),
      registrant: `${THEMES_ETF_TRUST}, CIK ${THEMES_ETF_TRUST_CIK}`,
      factsheet: fund.factsheet ?? null,
      prospectus: fund.prospectus ?? null,
    },
    generatedAt: now,
  };
  const commit = async (): Promise<void> => {
    for (const sheet of sheets) await sheet.write();
    await writeJsonIfChanged(path.join(fundDir, 'meta.json'), meta);
    for (const sheet of sheets) await sheet.prune();
  };
  return { entry: buildCatalogEntry(meta), reason: fallbackReason || undefined, commit };
}

/** Starts after the cursor inside the filtered (ticker-sorted) set and wraps around, so the batch is never empty while funds match. */
export function rotateFromCursor<T extends { ticker: string }>(filtered: T[], cursor: string | null): T[] {
  if (!cursor || !filtered.length) return filtered;
  const start = filtered.findIndex((fund) => fund.ticker > cursor);
  return start <= 0 ? filtered : [...filtered.slice(start), ...filtered.slice(0, start)];
}

async function readCursor(): Promise<string | null> {
  const state = await readJson<{ cursor?: unknown }>(path.join(API_ROOT, 'update-state.json'));
  return state?.cursor ? sanitizeTicker(state.cursor) : null;
}

function usage(): string {
  return `Usage: bun scripts/update-data.ts\n\nThe updater reads scripts/update-data.config.json (file defaults) and the environment controls documented in README.md; explicit environment values win.\nEvery control also reads THEMES_<NAME> from the environment (the plain name wins when both are set); HISTORICAL_PAGE_SIZE is an alias of HISTORY_PAGE_SIZE.\nControls: ${CONTROL_NAMES.join(', ')}\nUse TICKERS="BOTT,CLOD,AUMI" for an isolated update; use MAX_FETCHES=N for a cursor-based bounded batch.\nMAX_RETRIES: integer >= 1 (retries after the first request). HISTORY_RANGE: max or Ny, limits the Yahoo history request window.\nUSE_SYSTEM_CA: auto (default) restarts once with Bun's --use-system-ca on an untrusted-certificate error, true always uses the system CA store, false never restarts.\nSEC_UA: User-Agent for SEC requests (default is the daggerok feed descriptor).\nCONCURRENCY / REQUEST_SLEEP: direct requests use one paced lane per worker; themesetfs.com 403/429/5xx falls back to the r.jina.ai proxy (global gate, >= 3.2s between starts), and unavailable sources keep the previously published data.`;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (process.argv.slice(2).some((argument) => argument === '-h' || argument === '--help')) { console.log(usage()); return; }
  const controls = await runtimeControls(env);
  const config = readConfig(controls);
  installSystemCa((controls.USE_SYSTEM_CA ?? 'auto').toLowerCase());
  if (controls.VERBOSE !== undefined || config.verbose) process.env.VERBOSE = String(config.verbose);
  printUpdaterConfig(config);
  resetIssuerState();
  resetSecState();
  const gate = createRequestGate(config.concurrency, config.requestSleepMs);
  const proxyGate = createProxyGate(Math.max(PROXY_SLEEP_MS, config.requestSleepMs));
  const indexFile = path.join(API_ROOT, 'index.json');
  const previousIndex = await readJson<{ generatedAt?: string; funds?: Array<Record<string, unknown>> }>(indexFile);
  const previousEntries = new Map((previousIndex?.funds ?? []).map((entry) => [sanitizeTicker(entry.ticker), entry]));
  const publishedCatalog = (): CatalogFund[] => (previousIndex?.funds ?? []).map((entry) => ({
    ticker: sanitizeTicker(entry.ticker), name: cleanText(entry.name), category: cleanText(entry.category),
    navValue: asNumber(entry.navValue), closePriceValue: asNumber(entry.closePriceValue), terValue: asNumber(entry.terValue),
    fundPage: cleanText(entry.fundPage) || THEMES_FUND_URL(sanitizeTicker(entry.ticker)),
  })).filter((fund) => fund.ticker);
  let catalog: CatalogFund[];
  let catalogLabel = 'official Themes ETFs catalog';
  if (config.skipThemes) {
    catalog = publishedCatalog();
  } else {
    try {
      const fetched = await fetchThemesCatalog(config, gate, proxyGate);
      catalog = fetched.funds;
      if (fetched.via === 'proxy') catalogLabel = 'official Themes ETFs catalog via read-only rendering proxy';
    } catch (error) {
      catalog = publishedCatalog();
      if (!catalog.length) throw new Error(`official catalog unavailable and nothing published to retain: ${error instanceof Error ? error.message : String(error)}`);
      catalogLabel = 'previously published catalog (retained: official catalog unavailable)';
      console.warn(`[ catalog  ] official catalog unavailable (${outputClean(error instanceof Error ? error.message : String(error))}); keeping the previously published catalog and fund data`);
    }
  }
  console.log(`[ catalog  ] ${catalog.length} ${BRAND_LABEL} (${catalogLabel})`);

  // The live catalog (null when only the published feed is known): a catalog-only row it no longer lists is dropped, never retried
  const live = catalogLabel.startsWith('official') && !config.skipThemes ? catalog.map((fund) => fund.ticker) : null;
  // Q27: a TICKERS entry outside the live catalog and the published funds (a closed fund stays selectable) stops the run before any fund request
  assertKnownTickers(config.tickers.size ? Array.from(config.tickers) : null, knownTickers(live, Array.from(previousEntries.values())), 'the Themes ETFs catalog or published feed');

  // closed funds leave the queue before any per-fund request and before the MAX_FETCHES budget is spent
  const filtered = withoutClosedFunds(catalog.filter((fund) => catalogPassesFilters(fund, config) && (!config.tickers.size || config.tickers.has(fund.ticker))), (fund) => fund.ticker, CLOSED_FUNDS);
  let candidates = filtered;
  if (!config.tickers.size && config.maxFetches > 0) candidates = rotateFromCursor(filtered, await readCursor());
  if (config.maxFetches > 0) candidates = candidates.slice(0, config.maxFetches);
  outputPrintFilter(candidates.length, catalog.length, hasDeferredFilters(config));

  const startedAt = Date.now();
  let deadlineHit = false;
  const reporter = outputCreateReporter(API_ROOT, candidates.length);
  const queue = candidates.slice();
  const updates = new Map<string, Record<string, unknown>>();
  const stats = { skipped: 0, failed: 0 };
  const workerCount = Math.max(1, Math.min(config.concurrency, Math.max(1, queue.length)));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) { if (queue.length) deadlineHit = true; queue.length = 0; }
      const fund = queue.shift();
      if (!fund) return;
      const before = await reporter.before(fund.ticker);
      try {
        const result = await prepareFund(fund, config, gate, proxyGate);
        if (!fundPassesDeferredFilters(result.entry as Record<string, any>, config)) {
          // nothing was written: the fund stays exactly as published (files and index row agree)
          stats.skipped += 1;
          await reporter.result(fund.ticker, before, 'skipped', 'data filter');
          continue;
        }
        await result.commit();
        updates.set(fund.ticker, result.entry);
        await reporter.result(fund.ticker, before, undefined, result.reason);
      } catch (error) {
        stats.failed += 1;
        await reporter.result(fund.ticker, before, 'failed', error instanceof Error ? error.message : String(error));
      }
    }
  });
  await Promise.all(workers);

  const allEntries = new Map<string, Record<string, unknown>>(withoutStalePlaceholders(Array.from(previousEntries.values()), live).map((entry) => [sanitizeTicker(entry.ticker), entry] as [string, Record<string, unknown>]));
  const catalogTickers = new Set(catalog.map((fund) => fund.ticker));
  const officialCatalog = !config.skipThemes && catalogLabel.startsWith('official');
  // a closed fund keeps its row and files when the live catalog no longer lists it
  const gone = Array.from(previousEntries.keys()).filter((ticker) => !catalogTickers.has(ticker) && !closedFund(CLOSED_FUNDS, ticker));
  // a fresh official catalog is authoritative, unless it looks truncated (fewer than half of the published funds)
  const dropped = officialCatalog && gone.length > 0 && catalog.length * 2 >= previousEntries.size ? gone : [];
  if (officialCatalog && gone.length && !dropped.length) console.warn(`[ catalog  ] ${gone.length} published fund(s) missing from a much smaller official catalog; keeping them: ${gone.join(', ')}`);
  for (const ticker of dropped) {
    allEntries.delete(ticker);
    await rm(path.join(API_ROOT, 'funds', ticker), { recursive: true, force: true });
  }
  if (dropped.length) console.log(`[ catalog  ] DROPPED FUNDS (no longer in the official catalog): ${dropped.join(', ')}`);
  for (const fund of catalog) if (!allEntries.has(fund.ticker)) allEntries.set(fund.ticker, skeletonEntry(fund));
  for (const [ticker, entry] of allEntries) {
    if (updates.has(ticker)) continue;
    const stored = await readJson<Record<string, any>>(path.join(API_ROOT, 'funds', ticker, 'meta.json'));
    // a catalog-only row (dataFile null) is never published state: while the fund has no meta.json it is rebuilt from the live catalog
    const listed = entry.dataFile === null && !stored ? catalog.find((fund) => fund.ticker === ticker) : undefined;
    if (listed) { allEntries.set(ticker, skeletonEntry(listed)); continue; }
    const merged: Record<string, unknown> = { ...emptyMetrics(), ...((entry.metrics as Record<string, unknown> | undefined) ?? {}) };
    merged.dividendYieldBasis = dividendYieldBasisFor(merged.dividendYield);
    const metrics = withPerformanceFields(merged, stored?.history?.asOf);
    // a row without a published meta.json has no data file (the hub tolerates null) and no returns to show
    allEntries.set(ticker, stored ? { ...entry, metrics } : { ...entry, dataFile: null, metrics: emptyMetrics() });
  }
  for (const [ticker, entry] of updates) allEntries.set(ticker, entry);
  const funds = markClosedFunds(Array.from(allEntries.values()).sort((left, right) => String(left.ticker).localeCompare(String(right.ticker))), CLOSED_FUNDS);
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, entry) => sum + Number(entry.holdings ?? 0), 0),
    history: funds.reduce((sum, entry) => sum + Number(entry.history ?? 0), 0),
  };
  const index = {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      provider: 'Themes Management Company LLC (Themes ETFs)',
      market: 'us',
      site: THEMES_SITE,
      catalog: THEMES_CATALOG_URL,
      catalogNote: 'Server-rendered catalog exposing window.productsData.',
      fundPages: `${THEMES_SITE}/etfs/<ticker>`,
      holdings: `${THEMES_SITE}/storage/holdings/Holdings-<TICKER>.csv`,
      holdingsNote: 'Official daily full-holdings CSV linked from each Themes ETF page.',
      history: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
      distributions: 'Yahoo Finance chart dividend events',
      nportRegistrant: `SEC EDGAR Form N-PORT-P, ${THEMES_ETF_TRUST}, CIK ${THEMES_ETF_TRUST_CIK} (holdings fallback only)`,
    },
    counts,
    funds,
  };
  // the stamp moves only when content moved (writeJsonIfChanged ignores volatile keys)
  await writeJsonIfChanged(indexFile, index);
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(Array.from(previousEntries.values()), funds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8').catch(() => {});

  const stateFile = path.join(API_ROOT, 'update-state.json');
  // a TICKERS run never reads, writes or deletes the cursor
  if (!config.tickers.size) {
    if (config.maxFetches > 0 && candidates.length) {
      await writeJsonIfChanged(stateFile, { cursor: candidates[candidates.length - 1].ticker, savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    } else if (config.maxFetches === 0 && existsSync(stateFile)) {
      await rm(stateFile);
    }
  }
  if (deadlineHit) console.warn(`[ deadline ] soft deadline of ${SOFT_DEADLINE_MS / 60_000} minutes reached; remaining funds were left for the next run`);

  console.log(reporter.summary(startedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  if (stats.failed > 0 && stats.failed === candidates.length) {
    throw new Error(`nothing could be refreshed (every selected fund failed) and no published fallback exists: ${candidates.map((fund) => fund.ticker).join(', ')}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[ fatal    ] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, and never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker)
 * traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
