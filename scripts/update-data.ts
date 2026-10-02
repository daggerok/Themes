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
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] as const;
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
export type YahooHistoryRow = { date: string; close: number | null; adjClose: number | null; volume: number | null };
export type YahooDistribution = { date: string; amount: number };
export type ParsedYahooChart = {
  history: YahooHistoryRow[];
  dividends: YahooDistribution[];
  exchange: string | null;
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
};

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
} as const;

const rangePeriods = ['YTD', '1Y', '3Y', '5Y', '10Y'] as const;

function outputClean(value: unknown): string {
  return String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
}

function outputVerbose(config: Pick<UpdaterConfig, 'verbose'>): boolean {
  return config.verbose;
}

function outputNote(config: Pick<UpdaterConfig, 'verbose'>, message: string): void {
  if (outputVerbose(config)) console.warn(`[ note     ] ${outputClean(message)}`);
}

function outputConfigEntries(config: UpdaterConfig): Array<[string, string]> {
  const ranges = (range?: Range): string => range ? `${range.min}:${range.max}` : ':';
  return [
    ['MAX_FETCHES', String(config.maxFetches)],
    ['REQUEST_SLEEP', String(config.requestSleepMs / 1000)],
    ['CONCURRENCY', String(config.concurrency)],
    ['MAX_RETRIES', String(config.maxRetries)],
    ['TICKERS', [...config.tickers].join(',') || 'all'],
    ['CATEGORY', config.category],
    ['AUM', ranges(config.aumRange)],
    ['TER', ranges(config.terRange)],
    ['DIVIDEND_YIELD', ranges(config.dividendYieldRange)],
    ['SEC_YIELD', ranges(config.secYieldRange)],
    ...rangePeriods.flatMap((period) => [
      [`PERFORMANCE_${period}`, ranges(config.performanceRanges[period])],
      [`TOTAL_RETURN_${period}`, ranges(config.totalReturnRanges[period])],
    ]),
    ['HOLDINGS_PAGE_SIZE', String(config.holdingsPageSize)],
    ['HISTORY_PAGE_SIZE', String(config.historyPageSize)],
    ['HISTORY_RANGE', config.historyRange],
    ['EDGAR_FALLBACK', String(config.edgarFallback)],
    ['SKIP_YAHOO', String(config.skipYahoo)],
    ['SKIP_THEMES', String(config.skipThemes)],
    ['SEC_UA', config.secUserAgent ? '<configured>' : ''],
  ];
}

function outputPrintConfig(config: UpdaterConfig): void {
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  const entries = [...outputConfigEntries(config), ['VERBOSE', String(config.verbose)] as [string, string]]
    .sort(([left], [right]) => {
      const a = first.indexOf(left);
      const b = first.indexOf(right);
      return (a < 0 ? first.length : a) - (b < 0 ? first.length : b) || left.localeCompare(right);
    });
  console.log(`[ config   ] ${BRAND_LABEL} updater:`);
  for (const [name, value] of entries) console.log(`              ${name}=${value}`);
}

function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}

function outputStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter((key) => !VOLATILE_KEYS.has(key)).map((key) => [key, outputStable(record[key])]));
  }
  return value;
}

function outputContentKey(value: unknown): string {
  return JSON.stringify(outputStable(value)) ?? 'null';
}

async function outputInspectFund(root: string, ticker: string): Promise<{ digest: string; meta: Record<string, unknown> }> {
  const dir = path.join(root, 'funds', ticker);
  const hash = createHash('sha256');
  async function visit(folder: string): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const text = await readFile(file, 'utf8').catch(() => '');
        hash.update(path.relative(dir, file));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await readJson<Record<string, unknown>>(path.join(dir, 'meta.json')) ?? {};
  return { digest: hash.digest('hex'), meta };
}

function outputCount(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.totalRows === 'number') return record.totalRows;
    if (Array.isArray(record.rows)) return record.rows.length;
  }
  return null;
}

function outputMoney(value: unknown): string | null {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>).value : value;
  if (raw === null || raw === undefined || raw === '' || raw === '—') return null;
  const amount = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount)) return null;
  if (Math.abs(amount) >= 1e9) return `$${(amount / 1e9).toFixed(1)}B`;
  if (Math.abs(amount) >= 1e6) return `$${(amount / 1e6).toFixed(1)}M`;
  if (Math.abs(amount) >= 1e3) return `$${(amount / 1e3).toFixed(1)}K`;
  return `$${amount.toFixed(2)}`;
}

function outputFundLine(index: number, total: number, ticker: string, status: string, data: Record<string, unknown> = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const field = (name: string, value: unknown): string => value === null || value === undefined || value === 'null' ? '' : `${name}=${outputClean(value)}`;
  const detail = [
    field('history', outputCount(data.history)),
    field('holdings', outputCount(data.holdings)),
    field('divs', outputCount(data.distributions)),
    field('netAssets', outputMoney(data.netAssets)),
    field('div', data.dividendYield),
    field('sec', data.secYield),
  ].filter(Boolean).join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}

function outputCreateReporter(root: string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: Record<string, unknown> = {}): Promise<void> {
      const after = await outputInspectFund(root, ticker);
      const meta = after.meta;
      const metrics = (meta.metrics as Record<string, unknown> | undefined) ?? {};
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), {
        history: meta.history,
        holdings: meta.holdings,
        distributions: (meta.distributions as Record<string, unknown> | undefined)?.rows,
        netAssets: meta.aum,
        dividendYield: metrics.dividendYield,
        secYield: metrics.secYield,
        ...extra,
      }, reason));
    },
  };
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
  const marker = 'window.productsData';
  const start = html.indexOf(marker);
  if (start < 0) return [];
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
    if (!asOf && /^\d{4}-\d{2}-\d{2}$/.test(date)) asOf = date;
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
  if (!result) return { history: [], dividends: [], exchange: null };
  const timestamps: unknown[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjusted: unknown[] = Array.isArray(result.indicators?.adjclose?.[0]?.adjclose) ? result.indicators.adjclose[0].adjclose : [];
  const history: YahooHistoryRow[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const unix = Number(timestamps[index]);
    if (!Number.isFinite(unix)) continue;
    const date = new Date(unix * 1000).toISOString().slice(0, 10);
    const close = round(numberOrNull(quote.close?.[index]));
    const adjClose = round(numberOrNull(adjusted[index] ?? quote.close?.[index]));
    const volume = numberOrNull(quote.volume?.[index]);
    if (close === null && adjClose === null) continue;
    history.push({ date, close, adjClose, volume: volume === null ? null : Math.trunc(volume) });
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
  };
}

function tagText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return cleanText(match?.[1] ?? '');
}

export function parseNportXml(xml: string): { seriesName: string; asOf: string | null; rows: Array<Record<(typeof HOLDINGS_HEADERS)[number], string>>; netAssets: number | null } {
  const seriesName = tagText(xml, 'seriesName') || tagText(xml, 'seriesId');
  const asOfCandidate = tagText(xml, 'repPdDate');
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfCandidate) ? asOfCandidate : null;
  const netAssets = numberOrNull(tagText(xml, 'totNetAssets'));
  const sections = [...xml.matchAll(/<invstOrSec(?:\s[^>]*)?>([\s\S]*?)<\/invstOrSec>/gi)].map((match) => match[1]);
  const rows = sections.map((section) => {
    const marketValue = numberOrNull(tagText(section, 'valUSD'));
    const weight = numberOrNull(tagText(section, 'pctVal'));
    const shares = numberOrNull(tagText(section, 'balance'));
    return {
      Name: tagText(section, 'name') || '—',
      Ticker: tagText(section, 'ticker') || '—',
      Identifier: tagText(section, 'cusip') || tagText(section, 'isin') || '—',
      Weight: formatPercent(weight),
      'Market Value': formatMoney(marketValue),
      'Shares Held': formatShares(shares),
      'Asset Category': tagText(section, 'assetCat') || tagText(section, 'assetType') || '—',
    };
  }).filter((row) => row.Name !== '—');
  return { seriesName, asOf, rows, netAssets };
}

function normalizeFundName(value: string): string {
  return cleanText(value).toLowerCase().replace(/themes|etf|fund|the/g, '').replace(/[^a-z0-9]/g, '');
}

function matchesNportSeries(seriesName: string, fund: CatalogFund): boolean {
  const left = normalizeFundName(seriesName);
  const right = normalizeFundName(fund.name);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
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

export function calculateReturn(history: YahooHistoryRow[], from: Date): number | null {
  const usable = history.filter((row) => row.adjClose !== null && Number.isFinite(row.adjClose));
  if (usable.length < 2) return null;
  const latest = usable[0];
  const target = from.getTime();
  const earlier = usable.find((row) => new Date(`${row.date}T00:00:00Z`).getTime() <= target) ?? usable[usable.length - 1];
  if (!latest.adjClose || !earlier.adjClose) return null;
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
  };
}

// File defaults and explicit overrides: allowlisted scalar controls only, so GitHub Actions
// can resolve them without interpolating user input into bash. Precedence: config file <
// advanced JSON < nonblank named inputs < environment.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_THEMES', 'SEC_UA', 'VERBOSE',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
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
    const value = env[key];
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

export async function fetchWithRetry(url: string, options: RequestInit, config: Pick<UpdaterConfig, 'maxRetries' | 'requestSleepMs' | 'verbose'>, gate?: () => Promise<void>): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      if (gate) await gate();
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (![408, 425, 429].includes(response.status) && response.status < 500) throw new Error(`HTTP ${response.status}`);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < config.maxRetries) {
      outputNote(config, `retry ${attempt + 1}/${config.maxRetries}: ${url}`);
      await sleep(Math.max(250, config.requestSleepMs) * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

async function fetchText(url: string, config: UpdaterConfig, gate?: () => Promise<void>, headers: HeadersInit = {}): Promise<string> {
  const response = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ThemesETFs-static-feed/1.0)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      ...headers,
    },
  }, config, gate);
  return response.text();
}

async function fetchJson(url: string, config: UpdaterConfig, gate?: () => Promise<void>, headers: HeadersInit = {}): Promise<unknown> {
  const response = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ThemesETFs-static-feed/1.0)',
      Accept: 'application/json',
      ...headers,
    },
  }, config, gate);
  return response.json();
}

async function fetchThemesCatalog(config: UpdaterConfig, gate: () => Promise<void>): Promise<CatalogFund[]> {
  const html = await fetchText(THEMES_CATALOG_URL, config, gate);
  const catalog = parseThemesCatalog(html);
  if (!catalog.length) throw new Error('catalog: window.productsData was not found on themesetfs.com/etfs');
  return catalog;
}

async function fetchEdgarFallback(fund: CatalogFund, config: UpdaterConfig, gate: () => Promise<void>): Promise<ParsedHoldings | null> {
  const secHeaders = { 'User-Agent': config.secUserAgent || SEC_UA_DEFAULT };
  const submissions = await fetchJson(`https://data.sec.gov/submissions/CIK${THEMES_ETF_TRUST_CIK}.json`, config, gate, secHeaders) as any;
  const recent = submissions?.filings?.recent ?? {};
  const forms: unknown[] = Array.isArray(recent.form) ? recent.form : [];
  const accessions: unknown[] = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const documents: unknown[] = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  const limit = Math.min(forms.length, 40);
  for (let index = 0; index < limit; index += 1) {
    if (!/^NPORT-P(?:\/A)?$/i.test(String(forms[index] ?? ''))) continue;
    const accession = String(accessions[index] ?? '');
    const document = String(documents[index] ?? '');
    if (!accession || !document) continue;
    const archive = `https://www.sec.gov/Archives/edgar/data/${Number(THEMES_ETF_TRUST_CIK)}/${accession.replace(/-/g, '')}/${document}`;
    try {
      const xml = await fetchText(archive, config, gate, secHeaders);
      const parsed = parseNportXml(xml);
      if (!parsed.rows.length || !matchesNportSeries(parsed.seriesName, fund)) continue;
      return { asOf: parsed.asOf, netAssets: parsed.netAssets, sharesOutstanding: null, rows: parsed.rows };
    } catch (error) {
      outputNote(config, `EDGAR N-PORT candidate failed for ${fund.ticker}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
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
  await writeFile(file, stableStringify(value), 'utf8');
  return 'written';
}

async function prunePages(dir: string, count: number): Promise<void> {
  if (!existsSync(dir)) return;
  const files = await readdir(dir).catch(() => []);
  await Promise.all(files.filter((file) => /^\d{3}\.json$/.test(file) && Number(file.slice(0, 3)) > count).map((file) => rm(path.join(dir, file))));
}

async function writePagedSheet<T extends Record<string, unknown>>(ticker: string, sheet: 'holdings' | 'history', headers: readonly string[], rows: T[], pageSize: number): Promise<{ pages: string[]; pageSize: number; totalRows: number }> {
  const chunks = pages(rows, pageSize);
  const dir = path.join(API_ROOT, 'funds', ticker, sheet);
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
  await prunePages(dir, chunks.length);
  return { pages: chunks.map((_, index) => `./${sheet}/${pageFileName(index + 1)}`), pageSize, totalRows: rows.length };
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

function trailingDividendYield(dividends: YahooDistribution[], nav: number | null, now = new Date()): number | null {
  if (!nav || nav <= 0) return null;
  const twelveMonthsAgo = now.getTime() - 366 * 86_400_000;
  const amount = dividends.filter((item) => new Date(item.date).getTime() >= twelveMonthsAgo).reduce((sum, item) => sum + item.amount, 0);
  return round((amount / nav) * 100);
}

function existingManifest(meta: any, key: 'holdings' | 'history'): Record<string, unknown> | null {
  const value = meta?.[key];
  return value && typeof value === 'object' && Array.isArray(value.pages) ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function skeletonEntry(fund: CatalogFund): Record<string, unknown> {
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: `./funds/${fund.ticker}/meta.json`,
    ter: fund.terValue === null ? '—' : `${fund.terValue.toFixed(2)}%`,
    terValue: fund.terValue,
    nav: formatMoney(fund.navValue),
    navValue: fund.navValue,
    aum: '—',
    aumValue: null,
    closePrice: formatMoney(fund.closePriceValue),
    closePriceValue: fund.closePriceValue,
    distributions: { frequency: '00 - None', paymentsPerYear: null, exDate: null, dividend: null },
    metrics: { ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, dividendYield: null, secYield: null },
    holdings: 0,
    history: 0,
  };
}

async function updateFund(fund: CatalogFund, config: UpdaterConfig, gate: () => Promise<void>): Promise<{ entry: Record<string, unknown>; reason?: string }> {
  const fundDir = path.join(API_ROOT, 'funds', fund.ticker);
  const prior = await readJson<Record<string, any>>(path.join(fundDir, 'meta.json'));
  let holdings: ParsedHoldings | null = null;
  let holdingsSource = '';
  let fallbackReason = '';

  if (!config.skipThemes) {
    try {
      const csv = await fetchText(THEMES_HOLDINGS_URL(fund.ticker), config, gate, { Accept: 'text/csv,*/*;q=0.8' });
      holdings = parseThemesHoldingsCsv(csv);
      if (!holdings.rows.length) throw new Error('official CSV contained no holdings rows');
      holdingsSource = 'official Themes ETFs daily holdings CSV';
    } catch (error) {
      fallbackReason = `official holdings unavailable: ${error instanceof Error ? error.message : String(error)}`;
      outputNote(config, `${fund.ticker}: ${fallbackReason}`);
    }
  }

  if (!holdings && config.edgarFallback) {
    try {
      const fallback = await fetchEdgarFallback(fund, config, gate);
      if (fallback?.rows.length) {
        holdings = fallback;
        holdingsSource = `SEC EDGAR Form N-PORT-P (${THEMES_ETF_TRUST}, CIK ${THEMES_ETF_TRUST_CIK})`;
      }
    } catch (error) {
      outputNote(config, `${fund.ticker}: SEC fallback unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let yahoo: ParsedYahooChart | null = null;
  if (!config.skipYahoo) {
    try { yahoo = parseYahooChart(await fetchJson(yahooChartUrl(fund.ticker, config.historyRange), config, gate)); }
    catch (error) { outputNote(config, `${fund.ticker}: Yahoo history unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const priorHoldings = existingManifest(prior, 'holdings');
  const priorHistory = existingManifest(prior, 'history');
  if (!holdings && !priorHoldings) throw new Error(fallbackReason || 'no current or previously published holdings data');

  let holdingsManifest = priorHoldings;
  if (holdings) {
    const manifest = await writePagedSheet(fund.ticker, 'holdings', HOLDINGS_HEADERS, holdings.rows, config.holdingsPageSize);
    holdingsManifest = {
      ...manifest,
      asOfDate: isoDisplayDate(holdings.asOf),
      asOf: holdings.asOf,
      source: holdingsSource.startsWith('official') ? THEMES_HOLDINGS_URL(fund.ticker) : edgarFilingsUrl(),
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
    const manifest = await writePagedSheet(fund.ticker, 'history', HISTORY_HEADERS, rows, config.historyPageSize);
    historyManifest = {
      ...manifest,
      asOfDate: isoDisplayDate(yahoo.history[0]?.date ?? null),
      asOf: yahoo.history[0]?.date ?? null,
      source: yahooChartProvenanceUrl(fund.ticker),
      sourceKind: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
    };
  }

  const netAssets = holdings?.netAssets ?? asNumber(prior?.aumValue) ?? asNumber(prior?.totalNetAssets);
  const sharesOutstanding = holdings?.sharesOutstanding ?? asNumber(prior?.sharesOutstanding?.value) ?? asNumber(prior?.sharesOutstanding);
  const returns = yahoo ? deriveReturns(yahoo.history) : (prior?.returns?.monthEnd ?? {});
  const dividendData = yahoo ? dividendsWorksheet(yahoo.dividends) : (prior?.distributions ?? { frequency: '00 - None', paymentsPerYear: null, headers: ['Ex-Date', 'Amount'], rows: [] });
  const dividendYield = yahoo ? trailingDividendYield(yahoo.dividends, fund.navValue ?? asNumber(prior?.navValue)) : asNumber(prior?.metrics?.dividendYield);
  const navValue = fund.navValue ?? asNumber(prior?.navValue);
  const asOf = holdings?.asOf ?? (historyManifest?.asOf as string | undefined) ?? prior?.asOf ?? null;
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
    aum: { display: formatAum(netAssets), value: netAssets, asOfDate: isoDisplayDate(holdings?.asOf ?? (prior?.holdings?.asOf ?? null)), source: holdingsSource || prior?.aum?.source || 'previously published data' },
    aumValue: netAssets,
    asOfDate: isoDisplayDate(asOf),
    exchange: yahoo?.exchange ?? prior?.exchange ?? null,
    closePrice: formatMoney(fund.closePriceValue ?? asNumber(prior?.closePriceValue)),
    closePriceValue: fund.closePriceValue ?? asNumber(prior?.closePriceValue),
    totalNetAssets: netAssets,
    sharesOutstanding: { display: formatShares(sharesOutstanding), value: sharesOutstanding, asOfDate: isoDisplayDate(holdings?.asOf ?? null) },
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
      secYield: null,
      secYieldText: '—',
      returnsBasis: 'derived from Yahoo Finance adjusted market-price closes',
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
      holdingsSource: holdingsSource || prior?.source?.holdingsSource || 'previously published data',
      historySource: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
      historyUrl: yahooChartProvenanceUrl(fund.ticker),
      nportDoc: edgarFilingsUrl(),
      registrant: `${THEMES_ETF_TRUST}, CIK ${THEMES_ETF_TRUST_CIK}`,
      factsheet: fund.factsheet ?? null,
      prospectus: fund.prospectus ?? null,
    },
    generatedAt: now,
  };
  await writeJsonIfChanged(path.join(fundDir, 'meta.json'), meta);
  return { entry: buildCatalogEntry(meta), reason: fallbackReason || undefined };
}

async function readCursor(): Promise<string | null> {
  const state = await readJson<{ cursor?: unknown }>(path.join(API_ROOT, 'update-state.json'));
  return state?.cursor ? sanitizeTicker(state.cursor) : null;
}

function usage(): string {
  return `Usage: bun scripts/update-data.ts\n\nThe updater reads scripts/update-data.config.json (file defaults) and the environment controls documented in README.md; explicit environment values win.\nControls: ${CONTROL_NAMES.join(', ')}\nUse TICKERS="BOTT,CLOD,AUMI" for an isolated update; use MAX_FETCHES=N for a cursor-based bounded batch.\nMAX_RETRIES: integer >= 1 (retries after the first request). HISTORY_RANGE: max or Ny, limits the Yahoo history request window.\nSEC_UA: User-Agent for SEC requests (default is the daggerok feed descriptor).`;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (process.argv.slice(2).some((argument) => argument === '-h' || argument === '--help')) { console.log(usage()); return; }
  const config = readConfig(await runtimeControls(env));
  outputPrintConfig(config);
  const gate = createRequestGate(config.concurrency, config.requestSleepMs);
  const indexFile = path.join(API_ROOT, 'index.json');
  const previousIndex = await readJson<{ generatedAt?: string; funds?: Array<Record<string, unknown>> }>(indexFile);
  const previousEntries = new Map((previousIndex?.funds ?? []).map((entry) => [sanitizeTicker(entry.ticker), entry]));
  let catalog: CatalogFund[];
  if (config.skipThemes) {
    catalog = (previousIndex?.funds ?? []).map((entry) => ({
      ticker: sanitizeTicker(entry.ticker), name: cleanText(entry.name), category: cleanText(entry.category),
      navValue: asNumber(entry.navValue), closePriceValue: asNumber(entry.closePriceValue), terValue: asNumber(entry.terValue),
      fundPage: cleanText(entry.fundPage) || THEMES_FUND_URL(sanitizeTicker(entry.ticker)),
    })).filter((fund) => fund.ticker);
  } else {
    catalog = await fetchThemesCatalog(config, gate);
  }
  console.log(`[ catalog  ] ${catalog.length} ${BRAND_LABEL} (official Themes ETFs catalog)`);

  if (config.tickers.size) {
    const known = new Set(catalog.map((fund) => fund.ticker));
    const missing = [...config.tickers].filter((ticker) => !known.has(ticker));
    if (missing.length) throw new Error(`requested ticker(s) not found in official catalog: ${missing.join(', ')}`);
  }

  const filtered = catalog.filter((fund) => catalogPassesFilters(fund, config) && (!config.tickers.size || config.tickers.has(fund.ticker)));
  let candidates = filtered;
  if (!config.tickers.size && config.maxFetches > 0) {
    const cursor = await readCursor();
    if (cursor) {
      const index = filtered.findIndex((fund) => fund.ticker === cursor);
      if (index >= 0) candidates = filtered.slice(index + 1);
    }
  }
  if (config.maxFetches > 0) candidates = candidates.slice(0, config.maxFetches);
  outputPrintFilter(candidates.length, catalog.length, hasDeferredFilters(config));

  const reporter = outputCreateReporter(API_ROOT, candidates.length);
  const queue = candidates.slice();
  const updates = new Map<string, Record<string, unknown>>();
  const stats = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const workerCount = Math.max(1, Math.min(config.concurrency, Math.max(1, queue.length)));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const fund = queue.shift();
      if (!fund) return;
      const before = await reporter.before(fund.ticker);
      try {
        const result = await updateFund(fund, config, gate);
        if (!fundPassesDeferredFilters(result.entry as Record<string, any>, config)) {
          stats.skipped += 1;
          await reporter.result(fund.ticker, before, 'skipped', 'data filter');
          continue;
        }
        updates.set(fund.ticker, result.entry);
        const after = await outputInspectFund(API_ROOT, fund.ticker);
        if (before.digest === after.digest) stats.unchanged += 1; else stats.updated += 1;
        await reporter.result(fund.ticker, before, undefined, result.reason);
      } catch (error) {
        stats.failed += 1;
        await reporter.result(fund.ticker, before, 'failed', error instanceof Error ? error.message : String(error));
      }
    }
  });
  await Promise.all(workers);

  const allEntries = new Map<string, Record<string, unknown>>(previousEntries);
  for (const fund of catalog) if (!allEntries.has(fund.ticker)) allEntries.set(fund.ticker, skeletonEntry(fund));
  for (const [ticker, entry] of updates) allEntries.set(ticker, entry);
  const funds = [...allEntries.values()].sort((left, right) => String(left.ticker).localeCompare(String(right.ticker)));
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, entry) => sum + Number(entry.holdings ?? 0), 0),
    history: funds.reduce((sum, entry) => sum + Number(entry.history ?? 0), 0),
  };
  const index = {
    generatedAt: previousIndex?.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
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
  const indexResult = await writeJsonIfChanged(indexFile, index);
  if (indexResult === 'written' && previousIndex?.generatedAt) {
    await writeFile(indexFile, stableStringify({ ...index, generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }), 'utf8');
  }

  const stateFile = path.join(API_ROOT, 'update-state.json');
  if (config.maxFetches > 0 && candidates.length) {
    await writeJsonIfChanged(stateFile, { cursor: candidates[candidates.length - 1].ticker, savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  } else if (config.maxFetches === 0 && existsSync(stateFile)) {
    await rm(stateFile);
  }

  console.log(`[ done     ] ${stats.updated} funds updated, ${stats.failed} failures`);
  console.log(`[ done     ] counts: funds=${counts.funds} holdings=${counts.holdings} history=${counts.history} unchanged=${stats.unchanged} skipped=${stats.skipped}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[ fatal    ] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
