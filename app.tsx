/**
 * @file Themes ETFs Watchlist Application
 * Client-side static feed viewer for api/themes/** with multi-ETF Watchlist
 * aggregation. Same single-file approach as daggerok/Amplify: the paginated
 * static API and lazy sheet loading follow daggerok/iShares.
 *
 * Babel standalone note: the inline pipeline strips type annotations, but it
 * does not accept every TypeScript-only expression. Follow the Amplify dev
 * style — plain `byId()` instead of DOM casts, no `as` casts, no non-null
 * `!`, no interfaces or enums.
 */

/// <reference types="bun" />

// =========================================================================
// 1. Types, constants & column tooltips
// =========================================================================

type ActiveTab = string;
type SortDirection = 'asc' | 'desc';
type TableRow = Record<string, unknown> & { searchIndex?: string };
type TabInfo = { id: ActiveTab; label: string; count: number | string };

type IndexFund = {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  dataFile: string;
  ter: string;
  terValue: number;
  nav: string;
  navValue: number;
  aum: string;
  aumValue: number;
  asOfDate: string;
  inceptionDate: string;
  exchange: string;
  closePrice: string;
  premiumDiscount: string;
  cusip?: string | null;
  isin?: string | null;
  distributions: { frequency: string; exDate: string; dividend: string };
  returns: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
  metrics?: {
    tr1y?: number | null;
    tr3y?: number | null;
    tr5y?: number | null;
    tr10y?: number | null;
    cagr3y?: number | null;
    cagr5y?: number | null;
    cagr10y?: number | null;
    siAnn?: number | null;
    dividendYield?: number | null;
    dividendYieldText?: string | null;
    secYield?: number | null;
    secYieldText?: string | null;
  };
  holdings: number;
  history: number;
};

type FundRow = TableRow & {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  ter: string;
  terValue: number;
  nav: string;
  navValue: number;
  aum: string;
  aumValue: number;
  asOfDate: string;
  inceptionDate: string;
  exchange: string;
  closePrice: string;
  premiumDiscount: string;
  ytd: number;
  yr1: number;
  yr3: number;
  yr5: number;
  yr10: number;
  si: number;
  tr3y?: number | null;
  tr5y?: number | null;
  tr10y?: number | null;
  cagr3y?: number | null;
  cagr5y?: number | null;
  cagr10y?: number | null;
  dividendYield?: number | null;
  dividendFrequency: string;
  secYield?: number | null;
  returnAsOf: string;
  returns?: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
  distributions?: { frequency: string; exDate: string; dividend: string };
  holdings: number;
  history: number;
};

type WatchlistRow = TableRow & {
  key: string;
  symbol: string;
  name: string;
  funds: string[];
  fundCount: number;
  weightSum: number;
  maxWeight: number;
  cusips: string[];
  identifier: string;
};

const INDEX_URL = './api/themes/index.json';
const THEME_KEY = 'themes-theme';
const SELECTED_KEY = 'themes-selected-etfs';
const BLACKLIST_KEY = 'themes-blacklisted-etfs';
const ACTIVE_FUND_KEY = 'themes-active-fund';
const FILTERS_KEY = 'themes-tab-filters';
const LEGACY_FILTERS_KEY = 'themes-searches'; // pre-rename key, migrated at boot
const SORTS_KEY = 'themes-tab-sorts';
const SITE_STATE_KEY = 'themes-site-state';
const HOLDINGS_CONCURRENCY = 6; // bounded whole-catalog aggregation workers
const WATCHLIST_CHUNK = 250; // rows per rendered Watchlist DOM chunk
const DEFAULT_SELECTED_TICKERS: string[] = []; // start clean: no pre-selected funds

const DETAIL_TABS: Array<{ key: string; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'holdings', label: 'Holdings' },
  { key: 'history', label: 'History' },
  { key: 'distributions', label: 'Distributions' },
];

const NUMERIC_SHEET_HEADERS = ['Weight', 'Shares Held', 'Shares Outstanding', 'Total Net Assets', 'Par Value', 'Market Value', 'Coupon', 'NAV'];

// Hover explanations for table headers. Native `title` tooltips, same pattern as daggerok/iShares.
const COLUMN_TOOLTIPS: Record<string, string> = {
  '#': 'Row index in current table view.',
  Use: 'Use / Multi-ETF Selection — Check this box to include this ETF\'s underlying holdings in the combined Watchlist tab.',
  Ticker: 'Ticker Symbol — Unique stock market identifier. For holdings: the StockTicker column exactly as published in the Themes ETFs daily holdings CSV, which carries the option contract code for option positions (SPXW 261001P07075000, RUT 261016C03050000), the CUSIP for Treasury bills and bonds, and the literal label Cash&Other for cash balances. "—" when the position has no exchange ticker — option, Treasury and cash rows key on the CUSIP instead.',
  'Fund Name': 'Fund Name — Official fund name as published in the Themes ETFs catalog on themesetfs.com and in the fund page heading.',
  Category: 'Category — the Themes ETFs catalog category the fund belongs to on themesetfs.com: Equity High Income, Boosted High Income, High Income Alternatives, Hedged Equity Income or Enhanced Fixed Income. The tab shows that provider label verbatim.',
  Name: 'Security Name — Full name of the company or instrument as published in the SecurityName column of the Themes ETFs daily holdings CSV.',
  Identifier: 'CUSIP — Committee on Uniform Security Identification Procedures identifier, as published in the Cusip column of the Themes ETFs daily holdings CSV. Options and Treasury bills carry their own code here, so positions with no exchange ticker are still identified in the Watchlist by this.',
  SEDOL: 'SEDOL — Stock Exchange Daily Official List identifier. Not published by Themes ETFs; shown as "—" (data limitation).',
  FIGI: 'FIGI — Bloomberg Financial Instrument Global Identifier. Not published by Themes ETFs; shown as "—" (data limitation).',
  ISIN: 'ISIN — International Securities Identification Number. Themes ETFs publishes it per fund in the fund page Fund Details panel (for example US78433H3030); holdings rows carry a CUSIP, not an ISIN.',
  TER: 'Expense Ratio — Total Annual Fund Operating Expenses as a % of assets, from the Fund Details panel of the official Themes ETFs fund page.',
  NAV: 'NAV (Net Asset Value) — Per-share dollar value published as "Net Asset Value" in the Fund Details panel of the official Themes ETFs fund page.',
  'Net Assets': 'Net Assets (AUM) — Total net assets published in the Fund Details panel of the official Themes ETFs fund page and repeated on every row of the daily holdings CSV.',
  Weight: 'Weight — Position weight as a percentage of the fund\'s total net assets, from the Weightings column of the daily holdings CSV. Negative for written (sold) option positions.',
  'Weight Sum': 'Weight Sum — Summed weight of this holding across all selected ETFs (%).',
  'Max Weight': 'Max Weight — Highest single-fund weight for this holding across selected ETFs (%).',
  '# ETFs': 'Number of selected ETFs that currently hold this security.',
  ETFs: 'Selected ETFs holding this security.',
  Type: 'Category — the asset-class part of the Themes ETFs catalog grouping (see the Category column). Same source as the category tabs.',
  Expense: 'Expense Ratio — Total Annual Fund Operating Expenses as a % of assets, from the Fund Details panel of the official Themes ETFs fund page.',
  'Dividend Yield': 'Dividend Yield — the official Themes ETFs distribution rate: the most recent distribution annualised (x 12 for a monthly payer) and divided by the fund\'s most recent ex-date NAV, exactly as published in the Distribution Information block and the ETF lineup table.',
  'SEC Yield': 'SEC Yield (30-Day) — the official 30-Day SEC Yield published in the Distribution Information block of the Themes ETFs fund page and in the ETF lineup table; "—" where Themes ETFs publishes none for this fund.',
  'YTD Return': 'YTD Return — the Year-to-Date NAV Performance figure from the fund page performance table, as of the monthly "Data as of" date shown in the Return As Of column.',
  'TR 1Y': 'TR 1Y (1-Year Total Return) — the 1 Yr NAV Performance figure from the official Themes ETFs fund page performance table; "—" for a fund younger than 1 year.',
  'TR 3Y': 'TR 3Y (3-Year Total Return) — cumulative NAV return over 3 years, derived from the published 3 Yr annualized figure as (1 + 3 Yr)^3 - 1; "—" for a fund younger than 3 years.',
  'TR 5Y': 'TR 5Y (5-Year Total Return) — cumulative NAV return over 5 years, derived from the published 5 Yr annualized figure as (1 + 5 Yr)^5 - 1; "—" for a fund younger than 5 years.',
  'TR 10Y': 'TR 10Y (10-Year Total Return) — cumulative NAV return over 10 years, derived from the published 10 Yr annualized figure as (1 + 10 Yr)^10 - 1; "—" for a fund younger than 10 years, which is every Themes ETFs fund today.',
  'CAGR 3Y': 'CAGR 3Y (3-Year Compound Annual Growth Rate) — the 3 Yr annualized NAV Performance figure from the official Themes ETFs fund page performance table.',
  'CAGR 5Y': 'CAGR 5Y (5-Year Compound Annual Growth Rate) — the 5 Yr annualized NAV Performance figure from the official Themes ETFs fund page performance table.',
  'CAGR 10Y': 'CAGR 10Y (10-Year Compound Annual Growth Rate) — the 10 Yr annualized NAV Performance figure from the official Themes ETFs fund page performance table; "—" for a fund younger than 10 years.',
  YTD: 'Year-to-date NAV Performance from the fund page performance table.',
  '1Y': '1-year NAV Performance from the official Themes ETFs fund page performance table.',
  '3Y': '3-year annualized NAV Performance from the official Themes ETFs fund page performance table; "—" for a fund younger than 3 years.',
  '5Y': '5-year annualized NAV Performance from the official Themes ETFs fund page performance table; "—" for a fund younger than 5 years.',
  '10Y': '10-year annualized NAV Performance from the official Themes ETFs fund page performance table; "—" for a fund younger than 10 years.',
  'SI Ann.': 'Since-inception annualized NAV Performance ("Inception (Annualized)") from the official Themes ETFs fund page performance table.',
  'Return As Of': 'As-of date of the monthly performance table on the fund page ("Data as of: MM/DD/YYYY").',
  Inception: 'Inception Date — fund launch date from the Fund Details panel of the official Themes ETFs fund page.',
  Exchange: 'Primary Exchange — the listing exchange from the Fund Details panel of the official Themes ETFs fund page.',
  Close: 'Market Price — the most recent closing market price from the Fund Details panel of the official Themes ETFs fund page, with the Yahoo Finance daily close as the fallback.',
  'Prem/Disc': 'Premium / Discount — (Market Price - Net Asset Value) / Net Asset Value, computed from the two official fund page figures when Themes ETFs does not print a premium/discount value.',
  Holdings: 'Rows in the fund\'s latest Themes ETFs daily holdings CSV.',
  History: 'Rows in the fund\'s daily price history (Yahoo Finance chart feed).',
  'As Of': 'As-of date of the NAV / Net Assets / Market Price figures.',
  Frequency: 'Distribution frequency — inferred from Yahoo Finance dividend events. Codes: 00 — / None / Unknown / Other (irregular schedule), 01 Monthly, 04 Quarterly, 06 Semi-annually, 12 Annually, 99 Irregular. The Overview tab shows the raw label.',
  'Ex-Date': 'Ex-dividend date of the latest distribution, from the official Themes ETFs fund page Distribution History table. "—" if the fund has never made a distribution.',
  Dividend: 'Latest distribution amount per share, from the official Themes ETFs fund page Distribution History table. "—" if the fund has never made a distribution.',
  'Declaration Date': 'Declaration date of the distribution, from the official Themes ETFs fund page Distribution History table.',
  'Record Date': 'Record date of the distribution, from the official Themes ETFs fund page Distribution History table.',
  'Payable Date': 'Payable date of the distribution, from the official Themes ETFs fund page Distribution History table.',
  Coupon: 'Bond annual coupon rate (%). Themes ETFs does not publish a coupon column; shown as "—" (data limitation).',
  Maturity: 'Bond maturity date. Themes ETFs does not publish a maturity column; shown as "—" (data limitation).',
  'Market Value': 'Position market value in USD, from the MarketValue column of the daily holdings CSV. Negative for written (sold) option positions.',
  Section: 'Section — Grouping of the overview metric (Fund, Cost, Price, Assets, Returns, Distributions, Holdings).',
  Metric: 'Metric — Overview metric name.',
  Value: 'Overview metric value.',
  Date: 'Date of the daily price history row.',
  'Shares Held': 'Shares or contracts held, from the Shares column of the daily holdings CSV. Negative for written (sold) option positions.',
  'Shares Outstanding': 'Fund shares outstanding, from the SharesOutstanding column of the daily holdings CSV.',
  'Total Net Assets': 'Fund total net assets in USD, from the NetAssets column of the daily holdings CSV.',
  'Daily Change': 'Change in Net Asset Value or Market Price versus the previous day, as published in the Fund Details panel.',
};

// =========================================================================
// 2. DOM references, application state & lazy fund data
// =========================================================================

function byId(id: string): any {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzone-text');
const fileInput = document.getElementById('file-input');

const el = {
  themeToggle: byId('theme-toggle'),
  tickerCount: byId('ticker-count'),
  subtitle: byId('app-subtitle'),
  searchInput: byId('search-input'),
  searchClearBtn: byId('search-clear-btn'),
  tabsBar: byId('tabs-bar'),
  selectedTabsPanel: byId('selected-tabs-panel'),
  selectedTabsBar: byId('selected-tabs-bar'),
  copyBtn: byId('copy-btn'),
  exportCsvBtn: byId('export-csv-btn'),
  exportTxtBtn: byId('export-txt-btn'),
  resetBtn: byId('reset-btn'),
  blacklistBtn: byId('blacklist-btn'),
  blacklistPanel: byId('blacklist-panel'),
  blacklistInput: byId('blacklist-input'),
  blacklistAddBtn: byId('blacklist-add-btn'),
  blacklistClearBtn: byId('blacklist-clear-btn'),
  blacklistChips: byId('blacklist-chips'),
  blacklistEmpty: byId('blacklist-empty'),
  tableHead: byId('table-head'),
  tableBody: byId('table-body'),
  tableScroll: byId('table-scroll'),
  staticLoadSentinel: byId('static-load-sentinel'),
  staticLoadStatus: byId('static-load-status'),
};

type AppState = {
  funds: FundRow[];
  selected: Set<string>;
  blacklist: Set<string>;
  activeTab: ActiveTab;
  activeFundTicker: string | null;
  queryByTab: Record<string, string>;
  sortKey: string;
  sortDir: SortDirection;
  // Last sort the user explicitly chose (column-header click) per tab. Tab
  // switches restore it instead of falling back to the tab default, so an
  // All ETFs sort like "YTD Return" survives Watchlist / detail round trips.
  sortByTab: Record<string, { key: string; dir: SortDirection }>;
  generatedAt: string | null;
  counts: { funds: number; holdings: number; history: number } | null;
};

const state: AppState = {
  funds: [],
  selected: new Set(),
  blacklist: new Set(),
  activeTab: 'All',
  activeFundTicker: null,
  queryByTab: {},
  sortKey: 'rank',
  sortDir: 'asc',
  sortByTab: {},
  generatedAt: null,
  counts: null,
};

// Holdings pipeline bookkeeping (see docs/ui-contract.md §4–§6):
// per-ticker in-flight meta.json dedupe, one serialized page-load chain per
// ticker (the detail-view pager and the background Watchlist loader share it,
// so pages can never be fetched twice or skipped), per-ticker completion
// flags powering the Watchlist "Loading… / N+" label, and the chunked
// Watchlist rendering cursor.
const metaInFlight: Map<string, Promise<any>> = new Map();
const holdingsChains: Map<string, Promise<void>> = new Map();
const holdingsComplete = new Set<string>();
let watchlistChunkSig = '';
let watchlistRenderedCount = 0;
let watchlistRefreshTimer: any = null;

// Lazy per-fund data: meta.json plus accumulated sheet pages (iShares-style).
type SheetEntry = {
  headers: string[];
  rows: string[][];
  nextPage: number;
  manifest: any;
  loading: boolean;
};

const fundMetaCache: Map<string, any> = new Map();
const sheetState: Map<string, SheetEntry> = new Map();
let sheetGeneration = 0;

// =========================================================================
// 3b. Column types, auto-detection and the column filter engine (pure, no DOM)
// =========================================================================

/**
 * Every column of a table has a type that decides how its cells are compared:
 * text, number, percentage, money, date, date and time, or time of day. The type
 * is detected from a sample of the cell texts (80% of the filled cells must
 * agree) and can be overridden per column with the badge in the header.
 *
 * Filter expressions (one input under every column header):
 *   - the same grammar in every mode: space = AND, comma = OR, a leading ! = NOT,
 *     ? = the value is empty or unavailable, !? = it has a value
 *   - text: word (contains), "two words", =exact, ^starts, ends$, /regex/
 *   - number, percentage, money: >10 >=10 <50 <=50 =22 !=22, ranges 10..50 / ..50 / 10..,
 *     K M B T suffixes (>10B), an optional $ or %
 *   - date, date and time: the same operators and ranges over dates written as 2024,
 *     2024-06, 2024-06-15 or 2024-06-15T14:30; a partial date is the whole period
 *     (=2024 is the whole year), keywords today, yesterday, tomorrow, now and relative
 *     offsets -7d, +2w, -3m, -1y
 *   - time: >09:30, 09:30..16:00, =12:00
 *   Values that are unavailable match only ? and negated conditions.
 */
type ColType = 'string' | 'number' | 'percent' | 'currency' | 'date' | 'datetime' | 'time';

const ALL_COL_TYPES: ColType[] = ['string', 'number', 'percent', 'currency', 'date', 'datetime', 'time'];

const COL_TYPE_LABELS: Record<ColType, string> = { string: 'ABC', number: '123', percent: '%', currency: '$', date: 'D', datetime: 'DT', time: 'T' };

const COL_TYPE_NAMES: Record<ColType, string> = { string: 'text', number: 'number', percent: 'percentage', currency: 'money', date: 'date', datetime: 'date and time', time: 'time of day' };

const COL_TYPE_CLASSES: Record<ColType, string> = {
  string: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  number: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  percent: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300',
  currency: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  date: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
  datetime: 'bg-fuchsia-100 dark:bg-fuchsia-900/50 text-fuchsia-700 dark:text-fuchsia-300',
  time: 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300',
};

const COL_TYPE_PLACEHOLDERS: Record<ColType, string> = {
  string: 'text, !not, "a b"', number: '>10 <50, =22', percent: '>5 <20, 10..15', currency: '>1B, ..500M', date: '>2024-01, -30d..', datetime: '>2024-06-01T09:30', time: '>09:30 <16:00',
};

const COL_TYPE_HELP: Record<ColType, string> = {
  string: 'Text filter: space = AND, comma = OR, !word = NOT, "two words" = phrase, =exact, ^starts, ends$, /regex/, ? = empty, !? = has a value.',
  number: 'Number filter: >10 >=10 <50 <=50 =22 !=22, ranges 10..50 / ..50 / 10.., suffixes K M B T, space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  percent: 'Percentage filter: >5 <20, 10..15, =12.5 (rounds like the shown value), space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  currency: 'Money filter: >1B, ..500M, 10..20, suffixes K M B T, an optional $, space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  date: 'Date filter: >2024-06-01, 2024 (the whole year), 2024-06 (the whole month), 2024-01..2024-06, today, yesterday, -7d, +2w, -3m, -1y, space = AND, comma = OR, ! = NOT, ? = empty.',
  datetime: 'Date and time filter: >2024-06-01T09:30, 2024-06-01 (the whole day), 2024-01..2024-06, today, -7d.., space = AND, comma = OR, ! = NOT, ? = empty.',
  time: 'Time filter: >09:30, 09:30..16:00, =12:00 (the whole minute), space = AND, comma = OR, ! = NOT, ? = empty.',
};

const FILTER_DAY_MS = 86400000;
const EMPTY_CELLS = new Set(['', '-', '--', '–', '—', 'n/a', 'na', 'null', 'none', 'nan']);
const TYPE_SAMPLE_SIZE = 60;
const TYPE_AGREEMENT = 0.8;
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MAGNITUDES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

function isEmptyCell(value: string): boolean {
  return EMPTY_CELLS.has(value.trim().toLowerCase());
}

function monthFromName(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  const abbr = MONTH_ABBR.indexOf(lower === 'sept' ? 'sep' : lower);
  return abbr >= 0 ? abbr : MONTH_FULL.indexOf(lower);
}

/** UTC milliseconds of a calendar date; NaN when the date does not exist (2024-02-30). */
function utcMs(year: number, month: number, day: number): number {
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : NaN;
}

/** Date in one of the common written forms, as UTC midnight milliseconds; NaN when the text is not a date. */
function parseDatePart(text: string): number {
  const value = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (m) return utcMs(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value); // US month/day/year unless the first number cannot be a month
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const year = m[3].length === 2 ? (Number(m[3]) < 70 ? 2000 : 1900) + Number(m[3]) : Number(m[3]);
    return first > 12 ? utcMs(year, second, first) : utcMs(year, first, second);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (m) return utcMs(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]*(\d{4})$/.exec(value);
  if (m && monthFromName(m[2]) >= 0) return utcMs(Number(m[3]), monthFromName(m[2]) + 1, Number(m[1]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value);
  if (m && monthFromName(m[1]) >= 0) return utcMs(Number(m[3]), monthFromName(m[1]) + 1, Number(m[2]));
  return NaN;
}

/** Time of day in seconds since midnight (24-hour or AM/PM); NaN when the text is not a time. */
function parseTimePart(text: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([AaPp][Mm])?$/.exec(text.trim());
  if (!m) return NaN;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = m[3] === undefined ? 0 : Number(m[3]);
  if (m[5]) {
    if (hours < 1 || hours > 12) return NaN;
    hours = (hours % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return NaN;
  return hours * 3600 + minutes * 60 + seconds + (m[4] ? Number(`0.${m[4]}`) : 0);
}

type Temporal = { kind: 'date' | 'datetime' | 'time'; value: number };

/** A date (UTC midnight ms), a date with a time (UTC ms, an offset such as Z or +02:00 is honored) or a time of day (seconds). */
function parseTemporal(raw: string): Temporal | null {
  const text = raw.trim();
  if (!text) return null;
  const time = parseTimePart(text);
  if (Number.isFinite(time)) return { kind: 'time', value: time };
  const date = parseDatePart(text);
  if (Number.isFinite(date)) return { kind: 'date', value: date };
  const m = /^(.+?)(?:T|\s+)(\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AaPp][Mm])?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return null;
  const day = parseDatePart(m[1]);
  const clock = parseTimePart(m[2]);
  if (!Number.isFinite(day) || !Number.isFinite(clock)) return null;
  let ms = day + clock * 1000;
  if (m[3] && m[3] !== 'Z') {
    const digits = m[3].slice(1).replace(':', '');
    ms -= (m[3][0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  return { kind: 'datetime', value: ms };
}

type Magnitude = { value: number; decimals: number; scale: number; percent: boolean; currency: boolean };

/** $1,234.50, (12.5), -3.2%, 5B, +1.2 pp, 12x: the number with the precision and the unit it was written with. */
function parseMagnitude(raw: string): Magnitude | null {
  let text = raw.trim();
  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) { negative = true; text = paren[1].trim(); }
  const m = /^([+-]?)\s*([$€£¥]?)\s*([+-]?)\s*(\d[\d,]*(?:\.\d*)?|\.\d+)\s*([kmbtKMBT])?\s*(%|pp|bp|x)?$/.exec(text);
  if (!m) return null;
  if (m[1] === '-' || m[3] === '-') negative = !negative;
  const digits = m[4].replace(/,/g, '');
  const scale = m[5] ? MAGNITUDES[m[5].toLowerCase()] : 1;
  const value = Number(digits) * scale;
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, decimals: digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0, scale, percent: m[6] === '%', currency: m[2] !== '' };
}

/** The sortable and filterable number behind a cell text for its column type; NaN when there is none. */
function parseCellValue(text: string, type: ColType): number {
  if (type === 'string') return NaN;
  if (type === 'number' || type === 'percent' || type === 'currency') {
    const magnitude = parseMagnitude(text);
    return magnitude ? magnitude.value : NaN;
  }
  const temporal = parseTemporal(text);
  if (!temporal) return NaN;
  if (type === 'time') return temporal.kind === 'time' ? temporal.value : NaN;
  if (temporal.kind === 'time') return NaN;
  if (type === 'date') return Math.floor(temporal.value / 86400000) * 86400000;
  return temporal.value;
}

/** Detects the type of a column from sample cell texts: 80% of the filled cells must agree, otherwise text. */
function detectColType(samples: string[]): ColType {
  const values = samples.map(sample => String(sample ?? '').trim()).filter(value => !isEmptyCell(value)).slice(0, TYPE_SAMPLE_SIZE);
  if (!values.length) return 'string';
  const need = Math.ceil(values.length * TYPE_AGREEMENT);
  const count = { date: 0, datetime: 0, time: 0, percent: 0, currency: 0, number: 0 };
  values.forEach(value => {
    const temporal = parseTemporal(value);
    if (temporal) { count[temporal.kind] += 1; return; }
    const magnitude = parseMagnitude(value);
    if (!magnitude) return;
    if (magnitude.percent) count.percent += 1;
    else if (magnitude.currency) count.currency += 1;
    else count.number += 1;
  });
  if (count.date + count.datetime >= need) return count.datetime > 0 ? 'datetime' : 'date';
  if (count.time >= need) return 'time';
  if (count.percent >= need) return 'percent';
  if (count.currency >= need || count.currency + count.number >= need && count.currency > 0) return 'currency';
  if (count.number >= need) return 'number';
  return 'string';
}

// ---- filter expressions ---------------------------------------------------------

type FilterToken = { op: string; text: string; neg: boolean; quoted: boolean; regex: boolean; flags: string };

/** Splits an expression into AND tokens grouped by commas (OR groups); quotes keep spaces, !/>= prefixes may precede a quote. */
function tokenizeFilter(input: string): FilterToken[][] {
  const groups: FilterToken[][] = [[]];
  let i = 0;
  const length = input.length;
  while (i < length) {
    const char = input[i];
    if (char === ' ' || char === '\t') { i += 1; continue; }
    if (char === ',') { groups.push([]); i += 1; continue; }
    let neg = false;
    if (char === '!') { neg = true; i += 1; }
    let prefix = '';
    const op = /^(>=|<=|!=|==|=|>|<|\^)/.exec(input.slice(i));
    if (op) { prefix = op[1]; i += prefix.length; }
    let text = '';
    let quoted = false;
    let regex = false;
    let flags = '';
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      quoted = true;
      i += 1;
      while (i < length && input[i] !== quote) { text += input[i]; i += 1; }
      if (i < length) i += 1;
    } else if (input[i] === '/' && prefix === '') {
      const end = input.indexOf('/', i + 1);
      if (end > i) {
        regex = true;
        text = input.slice(i + 1, end);
        i = end + 1;
        while (i < length && /[a-z]/i.test(input[i])) { flags += input[i]; i += 1; }
      }
    }
    if (!quoted && !regex) {
      while (i < length && input[i] !== ' ' && input[i] !== '\t' && input[i] !== ',') { text += input[i]; i += 1; }
    }
    const token = { op: prefix, text, neg, quoted, regex, flags };
    if (token.text !== '' || token.op !== '' || token.neg || token.quoted || token.regex) groups[groups.length - 1].push(token);
  }
  return groups.filter(group => group.length > 0);
}

type Interval = { lo: number; hi: number };
type Condition =
  | { kind: 'empty'; neg: boolean }
  | { kind: 'text'; mode: 'contains' | 'exact' | 'starts' | 'ends' | 'regex'; value: string; re: RegExp | null; neg: boolean }
  | { kind: 'cmp'; op: '=' | '>' | '>=' | '<' | '<=' | 'range'; a: Interval | null; b: Interval | null; temporal: boolean; neg: boolean };

type CompiledFilter = { ok: true; test: (num: number, text: string) => boolean } | { ok: false; error: string };

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / FILTER_DAY_MS) * FILTER_DAY_MS;
}

/** A written date or time as the half-open interval [lo, hi) it denotes (2024 is the whole year); null when it is not valid for the column type. */
function temporalInterval(text: string, type: ColType, now: number): Interval | null {
  const word = text.trim().toLowerCase();
  if (type === 'time') {
    if (word === 'now') { const t = (now % FILTER_DAY_MS) / 1000; return { lo: t, hi: t + 1 }; }
    const t = parseTimePart(word);
    if (!Number.isFinite(t)) return null;
    return { lo: t, hi: t + (/^\d{1,2}:\d{2}(?:\s*[ap]m)?$/.test(word) ? 60 : 1) };
  }
  const today = startOfUtcDay(now);
  if (word === 'now') return { lo: now, hi: now + 1 };
  if (word === 'today') return { lo: today, hi: today + FILTER_DAY_MS };
  if (word === 'yesterday') return { lo: today - FILTER_DAY_MS, hi: today };
  if (word === 'tomorrow') return { lo: today + FILTER_DAY_MS, hi: today + 2 * FILTER_DAY_MS };
  const relative = /^([+-]?)(\d+)\s*([dwmy])$/.exec(word);
  if (relative) {
    const amount = (relative[1] === '-' ? -1 : 1) * Number(relative[2]);
    const base = new Date(today);
    if (relative[3] === 'd') base.setUTCDate(base.getUTCDate() + amount);
    else if (relative[3] === 'w') base.setUTCDate(base.getUTCDate() + amount * 7);
    else if (relative[3] === 'm') base.setUTCMonth(base.getUTCMonth() + amount);
    else base.setUTCFullYear(base.getUTCFullYear() + amount);
    const lo = base.getTime();
    return { lo, hi: lo + FILTER_DAY_MS };
  }
  let m = /^(\d{4})$/.exec(word);
  if (m) return { lo: utcMs(Number(m[1]), 1, 1), hi: utcMs(Number(m[1]) + 1, 1, 1) };
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(word);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { lo: utcMs(year, month, 1), hi: month === 12 ? utcMs(year + 1, 1, 1) : utcMs(year, month + 1, 1) };
  }
  const temporal = parseTemporal(text);
  if (!temporal || temporal.kind === 'time') return null;
  if (temporal.kind === 'date') return { lo: temporal.value, hi: temporal.value + FILTER_DAY_MS };
  if (type === 'date') { const day = startOfUtcDay(temporal.value); return { lo: day, hi: day + FILTER_DAY_MS }; }
  return { lo: temporal.value, hi: temporal.value + (/\d{1,2}:\d{2}:\d{2}/.test(text) ? 1000 : 60000) };
}

/** A written number as an interval: [value - half, value + half) for equality (matches the precision it was written with), the exact point otherwise. */
function numericInterval(text: string): Interval | null {
  const magnitude = parseMagnitude(text);
  if (!magnitude) return null;
  const half = 0.5 * 10 ** -magnitude.decimals * magnitude.scale;
  return { lo: magnitude.value - half, hi: magnitude.value + half };
}

function pointOf(interval: Interval): number {
  return (interval.lo + interval.hi) / 2;
}

function compileCondition(token: FilterToken, type: ColType, now: number): Condition | string {
  const text = token.text;
  if (!token.quoted && !token.regex && token.op === '' && text === '?') return { kind: 'empty', neg: token.neg };
  if (type === 'string') {
    if (token.regex) {
      try { return { kind: 'text', mode: 'regex', value: text, re: new RegExp(text, token.flags === '' ? 'i' : token.flags), neg: token.neg }; } catch { return `invalid regular expression /${text}/`; }
    }
    const lower = text.toLowerCase();
    if (token.op === '=' || token.op === '==') return { kind: 'text', mode: 'exact', value: lower, re: null, neg: token.neg };
    if (token.op === '^') return { kind: 'text', mode: 'starts', value: lower, re: null, neg: token.neg };
    if (token.op === '' && !token.quoted && lower.length > 1 && lower.endsWith('$')) return { kind: 'text', mode: 'ends', value: lower.slice(0, -1), re: null, neg: token.neg };
    return { kind: 'text', mode: 'contains', value: token.op + lower, re: null, neg: token.neg };
  }
  const temporal = type === 'date' || type === 'datetime' || type === 'time';
  const literal = (value: string): Interval | null => (temporal ? temporalInterval(value, type, now) : numericInterval(value));
  const range = token.op === '' ? /^(.*?)\.\.(.*)$/.exec(text) : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const a = range[1] === '' ? null : literal(range[1]);
    const b = range[2] === '' ? null : literal(range[2]);
    if (range[1] !== '' && !a) return `cannot read "${range[1]}" as ${COL_TYPE_NAMES[type]}`;
    if (range[2] !== '' && !b) return `cannot read "${range[2]}" as ${COL_TYPE_NAMES[type]}`;
    return { kind: 'cmp', op: 'range', a, b, temporal, neg: token.neg };
  }
  const interval = literal(text);
  if (!interval) return `cannot read "${text}" as ${COL_TYPE_NAMES[type]}`;
  const op = token.op === '' || token.op === '==' ? '=' : token.op;
  if (op === '=' || op === '>' || op === '>=' || op === '<' || op === '<=') return { kind: 'cmp', op, a: interval, b: null, temporal, neg: token.neg };
  return `unknown operator "${token.op}"`;
}

function evalCondition(condition: Condition, type: ColType, num: number, text: string): boolean {
  if (condition.kind === 'empty') {
    const empty = type === 'string' ? isEmptyCell(text) : Number.isNaN(num);
    return condition.neg ? !empty : empty;
  }
  if (condition.kind === 'text') {
    let hit: boolean;
    if (condition.mode === 'exact') hit = text === condition.value;
    else if (condition.mode === 'starts') hit = text.startsWith(condition.value);
    else if (condition.mode === 'ends') hit = text.endsWith(condition.value);
    else if (condition.mode === 'regex' && condition.re) hit = condition.re.test(text);
    else hit = text.includes(condition.value);
    return condition.neg ? !hit : hit;
  }
  if (Number.isNaN(num)) return condition.neg;
  const a = condition.a;
  const b = condition.b;
  let hit = false;
  if (condition.op === 'range') {
    hit = (a === null || num >= (condition.temporal ? a.lo : pointOf(a))) && (b === null || (condition.temporal ? num < b.hi : num <= pointOf(b)));
  } else if (a) {
    if (condition.op === '=') hit = num >= a.lo && num < a.hi;
    else if (condition.temporal) hit = condition.op === '>' ? num >= a.hi : condition.op === '>=' ? num >= a.lo : condition.op === '<' ? num < a.lo : num < a.hi;
    else hit = condition.op === '>' ? num > pointOf(a) : condition.op === '>=' ? num >= pointOf(a) : condition.op === '<' ? num < pointOf(a) : num <= pointOf(a);
  }
  return condition.neg ? !hit : hit;
}

/** Compiles a filter expression for a column type. `text` passed to test() must be lower-case; `num` is NaN when unavailable. Null for an empty expression. */
function compileFilter(input: string, type: ColType, now: number = Date.now()): CompiledFilter | null {
  if (input.trim() === '') return null;
  const groups = tokenizeFilter(input);
  if (!groups.length) return null;
  const compiled: Condition[][] = [];
  for (const group of groups) {
    const conditions: Condition[] = [];
    for (const token of group) {
      const condition = compileCondition(token, type, now);
      if (typeof condition === 'string') return { ok: false, error: condition };
      conditions.push(condition);
    }
    compiled.push(conditions);
  }
  return { ok: true, test: (num: number, text: string) => compiled.some(group => group.every(condition => evalCondition(condition, type, num, text))) };
}


// =========================================================================
// 3c. Column filters: state, header badges, the filter row and its events
//     (the expression grammar and the type detection are in 3b above)
// =========================================================================

/**
 * One filterable column of a table. `key` is the sort key of the column header (the key passed to
 * sortHeader), `text` the cell text as the table shows it (also the sample for the type detection),
 * `value` the exact number behind a numeric cell (so a filter compares full precision, not the
 * rounded text) and `extraClass` the classes of a horizontally pinned column.
 */
type FilterColumn = {
  key: string;
  label: string;
  numeric: boolean;
  text: (row: any) => string;
  value?: (row: any) => number | null | undefined;
  extraClass?: string;
};

const FILTER_STORAGE_PREFIX = 'themes'; // the app's localStorage prefix: the same words that start THEME_KEY
const COLUMN_FILTERS_KEY = `${FILTER_STORAGE_PREFIX}-column-filters`;
const COLUMN_TYPES_KEY = `${FILTER_STORAGE_PREFIX}-column-types`;
const SHOW_FILTERS_KEY = `${FILTER_STORAGE_PREFIX}-show-filters`;
const FILTER_DEBOUNCE_MS = 250;

/** scope (catalog, watchlist, holdings, history, distributions) -> column key -> expression / type chosen with the header badge */
const columnFilterState: { filters: Record<string, Record<string, string>>; typeOverrides: Record<string, Record<string, ColType>>; show: boolean } = { filters: {}, typeOverrides: {}, show: true };

/** What the last render of a scope computed: the columns, the types in use and the detected types (header badges read it). */
const filterInfo: Record<string, { columns: FilterColumn[]; types: ColType[]; detected: ColType[] }> = {};

const filterTimers: Map<string, any> = new Map();
let suppressTableAnimation = false;

function filterStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function filterStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota or private mode */ }
}

function filterStorageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked storage */ }
}

/** Which set of filters belongs to the shown table; none for the overview and the empty states. */
function currentFilterScope(): string {
  if (state.activeTab === 'watchlist') return 'watchlist';
  if (isEtfCatalogTab(state.activeTab)) return 'catalog';
  const key = detailTabKey(state.activeTab);
  return isDetailTab(state.activeTab) && (key === 'holdings' || key === 'history' || key === 'distributions') ? key : '';
}

function filterExpressionFor(scope: string, key: string): string {
  const map = columnFilterState.filters[scope];
  return map && typeof map[key] === 'string' ? map[key] : '';
}

function typeOverrideFor(scope: string, key: string): ColType | undefined {
  const map = columnFilterState.typeOverrides[scope];
  return map ? map[key] : undefined;
}

/** Signature of a scope's filters and type overrides, for the memoized views. */
function columnFilterSig(scope: string): string {
  return JSON.stringify([columnFilterState.filters[scope] || {}, columnFilterState.typeOverrides[scope] || {}, Math.floor(Date.now() / 86400000)]);
}

/**
 * Applies the column filters of a scope to rows and records the column types for the header. The
 * types are detected from `sample` (the rows before any search or filter), so a filter never changes
 * the type of its own column. A filter whose expression does not parse is ignored (the input shows why).
 */
function applyColumnFilters(scope: string, rows: any[], columns: FilterColumn[], sample: any[] = rows): any[] {
  const detected = columns.map(col => {
    const texts: string[] = [];
    for (let i = 0; i < sample.length && texts.length < TYPE_SAMPLE_SIZE; i++) {
      const text = col.text(sample[i]);
      if (!isEmptyCell(text)) texts.push(text);
    }
    return detectColType(texts);
  });
  const types = columns.map((col, i) => typeOverrideFor(scope, col.key) || detected[i]);
  filterInfo[scope] = { columns, types, detected };
  const active: Array<{ col: FilterColumn; type: ColType; test: (num: number, text: string) => boolean }> = [];
  columns.forEach((col, i) => {
    const expression = filterExpressionFor(scope, col.key);
    if (!expression.trim()) return;
    const compiled = compileFilter(expression, types[i]);
    if (compiled && compiled.ok) active.push({ col, type: types[i], test: compiled.test });
  });
  if (!active.length) return rows;
  return rows.filter(row => active.every(filter => {
    if (filter.type === 'string') return filter.test(NaN, filter.col.text(row).toLowerCase());
    const numeric = filter.type === 'number' || filter.type === 'percent' || filter.type === 'currency';
    if (numeric && filter.col.value) {
      const raw = filter.col.value(row);
      return filter.test(typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN, '');
    }
    return filter.test(parseCellValue(filter.col.text(row), filter.type), '');
  }));
}

/** Columns of a header-driven sheet (holdings, history, distributions): the cells are the row's `col0..colN` strings. */
function sheetFilterColumns(headers: string[], numericHeaders: string[]): FilterColumn[] {
  return headers.map((header, index) => ({
    key: `col${index}`,
    label: header || `Col ${index + 1}`,
    numeric: numericHeaders.includes(header),
    text: (row: any) => String(row[`col${index}`] ?? ''),
  }));
}

function activeFilterCount(scope: string): number {
  const info = filterInfo[scope];
  const keys = info ? info.columns.map(col => col.key) : Object.keys(columnFilterState.filters[scope] || {});
  return keys.filter(key => filterExpressionFor(scope, key).trim() !== '').length;
}

/** Header badge with the column type (auto-detected or set by the user); click cycles the type, Shift+click returns to auto-detection. */
function typeBadgeHtml(scope: string, key: string, type: ColType, detected: ColType): string {
  const overridden = type !== detected;
  const title = `Column type: ${COL_TYPE_NAMES[type]} (${overridden ? 'set by you, detected: ' + COL_TYPE_NAMES[detected] : 'auto-detected'}). Click to cycle the type, Shift+click to return to auto-detection.`;
  return `<button type="button" data-type-col="${escapeHtml(key)}" data-filter-scope="${escapeHtml(scope)}" title="${escapeHtml(title)}" class="type-badge ${COL_TYPE_CLASSES[type]}${overridden ? ' is-override' : ''}">${COL_TYPE_LABELS[type]}</button>`;
}

/** The type badge of a column of the table being rendered (empty for tables without filters). */
function filterBadgeFor(key: string): string {
  const scope = currentFilterScope();
  const info = filterInfo[scope];
  if (!info) return '';
  const index = info.columns.findIndex(col => col.key === key);
  return index < 0 ? '' : typeBadgeHtml(scope, key, info.types[index], info.detected[index]);
}

/** The row of filter inputs under the column headers; a column whose expression does not parse shows the reason in red. */
function filterRowHtml(scope: string, info: { columns: FilterColumn[]; types: ColType[] }, leading: string): string {
  return `<tr class="filter-row">${leading}${info.columns.map((col, i) => {
    const expression = filterExpressionFor(scope, col.key);
    const active = expression.trim() !== '';
    const compiled = active ? compileFilter(expression, info.types[i]) : null;
    const error = compiled && !compiled.ok ? compiled.error : '';
    const help = `${error ? 'Cannot apply this filter: ' + error + '. ' : ''}${COL_TYPE_HELP[info.types[i]]}`;
    return `<th class="filter-cell${col.extraClass ? ' ' + col.extraClass : ''}"><div class="filter-wrap"><input type="text" data-filter-col="${escapeHtml(col.key)}" data-filter-scope="${escapeHtml(scope)}" value="${escapeHtml(expression)}" placeholder="${escapeHtml(COL_TYPE_PLACEHOLDERS[info.types[i]])}" spellcheck="false" autocomplete="off" aria-label="Filter ${escapeHtml(col.label)}" title="${escapeHtml(help)}" class="filter-input${active ? ' is-active' : ''}${error ? ' is-invalid' : ''}" />${active ? `<button type="button" data-clear-filter="${escapeHtml(col.key)}" data-filter-scope="${escapeHtml(scope)}" class="filter-clear" title="Clear this filter" aria-label="Clear the ${escapeHtml(col.label)} filter">✕</button>` : ''}</div></th>`;
  }).join('')}</tr>`;
}

/** Called after a table head is written: adds the filter row for the shown scope (the catalog has the # and Use cells in front). */
function appendFilterRow(): void {
  const scope = currentFilterScope();
  const info = filterInfo[scope];
  if (!info || !columnFilterState.show) return;
  const leading = scope === 'catalog'
    ? '<th class="filter-cell"></th><th class="filter-cell catalog-sticky-col catalog-sticky-use"><div class="flex items-center justify-center gap-1 text-slate-400 dark:text-slate-500 text-[0.65rem] uppercase tracking-wider"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18l-7 8v6l-4 2v-8z"/></svg>filter</div></th>'
    : '<th class="filter-cell"></th>';
  el.tableHead.insertAdjacentHTML('beforeend', filterRowHtml(scope, info, leading));
}

function renderFilterControls(): void {
  const button: any = document.getElementById('filters-btn');
  const clear: any = document.getElementById('clear-filters-btn');
  const badge: any = document.getElementById('filters-badge');
  const summary: any = document.getElementById('filters-summary');
  if (!button || !clear || !badge || !summary) return;
  const scope = currentFilterScope();
  const count = scope ? activeFilterCount(scope) : 0;
  button.disabled = !scope;
  button.setAttribute('aria-pressed', String(columnFilterState.show));
  summary.textContent = columnFilterState.show ? 'on' : 'off';
  badge.hidden = count === 0;
  badge.textContent = String(count);
  clear.hidden = count === 0;
}

/** The filter row sticks right below the header row: tell the CSS how tall the first row is. */
function syncHeadHeight(): void {
  const first = el.tableHead.querySelector('tr');
  if (first) el.tableScroll.style.setProperty('--head-h', `${first.getBoundingClientRect().height}px`);
}

/** Re-renders after a filter change and puts the caret back into the filter input that was being edited. */
function rerenderKeepingFilterFocus(): void {
  const active: any = document.activeElement;
  const key = active && active.dataset ? active.dataset.filterCol : undefined;
  const scope = active && active.dataset ? active.dataset.filterScope : undefined;
  const caret = key !== undefined && typeof active.selectionStart === 'number' ? active.selectionStart : 0;
  suppressTableAnimation = true;
  render();
  suppressTableAnimation = false;
  if (key === undefined) return;
  const next: any = [...el.tableHead.querySelectorAll('input[data-filter-col]')].find((node: any) => node.dataset.filterCol === key && node.dataset.filterScope === scope);
  if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch { /* not a text input */ } }
}

function persistColumnFilters(): void {
  const clean: Record<string, Record<string, string>> = {};
  Object.keys(columnFilterState.filters).forEach(scope => {
    const map = columnFilterState.filters[scope] || {};
    const keys = Object.keys(map).filter(key => typeof map[key] === 'string' && map[key].trim() !== '');
    if (keys.length) clean[scope] = Object.fromEntries(keys.map(key => [key, map[key]]));
  });
  if (Object.keys(clean).length) filterStorageSet(COLUMN_FILTERS_KEY, JSON.stringify(clean));
  else filterStorageRemove(COLUMN_FILTERS_KEY);
}

function persistColumnTypes(): void {
  const clean: Record<string, Record<string, ColType>> = {};
  Object.keys(columnFilterState.typeOverrides).forEach(scope => { if (Object.keys(columnFilterState.typeOverrides[scope] || {}).length) clean[scope] = columnFilterState.typeOverrides[scope]; });
  if (Object.keys(clean).length) filterStorageSet(COLUMN_TYPES_KEY, JSON.stringify(clean));
  else filterStorageRemove(COLUMN_TYPES_KEY);
}

function restoreColumnFilters(): void {
  const parse = (key: string): any => { try { return JSON.parse(filterStorageGet(key) || '{}') || {}; } catch { return {}; } };
  const saved = parse(COLUMN_FILTERS_KEY);
  const filters: Record<string, Record<string, string>> = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    Object.keys(saved).forEach(scope => {
      const map = saved[scope];
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      const clean: Record<string, string> = {};
      Object.keys(map).forEach(key => { if (typeof map[key] === 'string' && map[key].trim() !== '') clean[key] = map[key]; });
      if (Object.keys(clean).length) filters[scope] = clean;
    });
  }
  columnFilterState.filters = filters;
  const savedTypes = parse(COLUMN_TYPES_KEY);
  const overrides: Record<string, Record<string, ColType>> = {};
  if (savedTypes && typeof savedTypes === 'object' && !Array.isArray(savedTypes)) {
    Object.keys(savedTypes).forEach(scope => {
      const map = savedTypes[scope];
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      const clean: Record<string, ColType> = {};
      Object.keys(map).forEach(key => { if (ALL_COL_TYPES.includes(map[key])) clean[key] = map[key]; });
      if (Object.keys(clean).length) overrides[scope] = clean;
    });
  }
  columnFilterState.typeOverrides = overrides;
  columnFilterState.show = filterStorageGet(SHOW_FILTERS_KEY) !== 'false';
}

function setFilter(scope: string, key: string, value: string): void {
  const next = { ...(columnFilterState.filters[scope] || {}) };
  if (value.trim() === '') delete next[key];
  else next[key] = value;
  columnFilterState.filters[scope] = next;
  persistColumnFilters();
  rerenderKeepingFilterFocus();
}

/** Typing applies the filter after a short pause (FILTER_DEBOUNCE_MS), also when the input loses focus meanwhile; Enter applies it at once (a re-render on blur would swallow the click on a header). */
function scheduleFilter(scope: string, key: string, value: string): void {
  const id = `${scope}:${key}`;
  const pending = filterTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  filterTimers.set(id, setTimeout(() => { filterTimers.delete(id); if (filterExpressionFor(scope, key) !== value) setFilter(scope, key, value); }, FILTER_DEBOUNCE_MS));
}

function flushFilter(scope: string, key: string, value: string): void {
  const id = `${scope}:${key}`;
  const pending = filterTimers.get(id);
  if (pending !== undefined) { clearTimeout(pending); filterTimers.delete(id); }
  if (filterExpressionFor(scope, key) !== value) setFilter(scope, key, value);
}

function clearAllFilters(scope: string): void {
  filterTimers.forEach(timer => clearTimeout(timer));
  filterTimers.clear();
  columnFilterState.filters[scope] = {};
  persistColumnFilters();
  render();
}

/** Header badge click: next type in the cycle; Shift+click returns to auto-detection. */
function cycleColumnType(scope: string, key: string, reset: boolean): void {
  const info = filterInfo[scope];
  const index = info ? info.columns.findIndex(col => col.key === key) : -1;
  const detected: ColType = info && index >= 0 ? info.detected[index] : 'string';
  const current = typeOverrideFor(scope, key) || detected;
  const next = reset ? detected : ALL_COL_TYPES[(ALL_COL_TYPES.indexOf(current) + 1) % ALL_COL_TYPES.length];
  const map = { ...(columnFilterState.typeOverrides[scope] || {}) };
  if (next === detected) delete map[key];
  else map[key] = next;
  columnFilterState.typeOverrides[scope] = map;
  persistColumnTypes();
  render();
}

/** Filter inputs and type badges live in the table header (delegated: the header is rebuilt on every render). */
function bindColumnFilterEvents(): void {
  const filtersBtn: any = document.getElementById('filters-btn');
  const clearBtn: any = document.getElementById('clear-filters-btn');
  if (filtersBtn) {
    filtersBtn.addEventListener('click', () => {
      columnFilterState.show = !columnFilterState.show;
      filterStorageSet(SHOW_FILTERS_KEY, String(columnFilterState.show));
      render();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const scope = currentFilterScope();
      if (scope) clearAllFilters(scope);
    });
  }
  el.tableHead.addEventListener('input', (event: any) => {
    const target = event.target;
    if (target && target.dataset && target.dataset.filterCol !== undefined) scheduleFilter(target.dataset.filterScope, target.dataset.filterCol, target.value);
  });
  el.tableHead.addEventListener('keydown', (event: any) => {
    const target = event.target;
    if (!target || !target.dataset || target.dataset.filterCol === undefined) return;
    if (event.key === 'Enter') { event.preventDefault(); flushFilter(target.dataset.filterScope, target.dataset.filterCol, target.value); }
    else if (event.key === 'Escape' && target.value !== '') { event.preventDefault(); event.stopPropagation(); flushFilter(target.dataset.filterScope, target.dataset.filterCol, ''); }
  });
  el.tableHead.addEventListener('click', (event: any) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const clear = target.closest('button[data-clear-filter]');
    if (clear) { event.stopPropagation(); flushFilter(clear.dataset.filterScope, clear.dataset.clearFilter, ''); return; }
    const badge = target.closest('button[data-type-col]');
    if (badge) { event.stopPropagation(); cycleColumnType(badge.dataset.filterScope, badge.dataset.typeCol, Boolean(event.shiftKey)); }
  });
}


// =========================================================================
// 3d. Column filters of this app's tables (the keys are the sort keys of the column headers)
// =========================================================================

const FUND_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'ticker', label: 'Ticker', numeric: false, text: (fund: any) => String((fund.ticker) ?? ''), extraClass: 'catalog-sticky-col catalog-sticky-ticker' },
  { key: 'name', label: 'Fund Name', numeric: false, text: (fund: any) => String((fund.name) ?? '') },
  { key: 'category', label: 'Type', numeric: false, text: (fund: any) => String((categoryLabel(fund.category)) ?? '') },
  { key: 'navValue', label: 'NAV', numeric: true, text: (fund: any) => String((fund.nav || '—') ?? ''), value: (fund: any) => fund.navValue },
  { key: 'aumValue', label: 'Net Assets', numeric: true, text: (fund: any) => String((formatMoney(fund.aumValue)) ?? ''), value: (fund: any) => fund.aumValue },
  { key: 'terValue', label: 'Expense', numeric: true, text: (fund: any) => String((fund.ter || '—') ?? ''), value: (fund: any) => fund.terValue },
  { key: 'dividendYield', label: 'Dividend Yield', numeric: true, text: (fund: any) => String((formatPercent(fund.dividendYield)) ?? ''), value: (fund: any) => fund.dividendYield },
  { key: 'secYield', label: 'SEC Yield', numeric: true, text: (fund: any) => String((formatPercent(fund.secYield)) ?? ''), value: (fund: any) => fund.secYield },
  { key: 'dividendFrequency', label: 'Frequency', numeric: false, text: (fund: any) => String((fund.dividendFrequency || '—') ?? '') },
  { key: 'ytd', label: 'YTD Return', numeric: true, text: (fund: any) => String((formatPercent(fund.ytd)) ?? ''), value: (fund: any) => fund.ytd },
  { key: 'yr1', label: 'TR 1Y', numeric: true, text: (fund: any) => String((formatPercent(fund.yr1)) ?? ''), value: (fund: any) => fund.yr1 },
  { key: 'tr3y', label: 'TR 3Y', numeric: true, text: (fund: any) => String((formatPercent(fund.tr3y)) ?? ''), value: (fund: any) => fund.tr3y },
  { key: 'tr5y', label: 'TR 5Y', numeric: true, text: (fund: any) => String((formatPercent(fund.tr5y)) ?? ''), value: (fund: any) => fund.tr5y },
  { key: 'tr10y', label: 'TR 10Y', numeric: true, text: (fund: any) => String((formatPercent(fund.tr10y)) ?? ''), value: (fund: any) => fund.tr10y },
  { key: 'cagr3y', label: 'CAGR 3Y', numeric: true, text: (fund: any) => String((formatPercent(fund.cagr3y)) ?? ''), value: (fund: any) => fund.cagr3y },
  { key: 'cagr5y', label: 'CAGR 5Y', numeric: true, text: (fund: any) => String((formatPercent(fund.cagr5y)) ?? ''), value: (fund: any) => fund.cagr5y },
  { key: 'cagr10y', label: 'CAGR 10Y', numeric: true, text: (fund: any) => String((formatPercent(fund.cagr10y)) ?? ''), value: (fund: any) => fund.cagr10y },
  { key: 'si', label: 'SI Ann.', numeric: true, text: (fund: any) => String((formatPercent(fund.si)) ?? ''), value: (fund: any) => fund.si },
  { key: 'returnAsOf', label: 'Return As Of', numeric: false, text: (fund: any) => String((fund.returnAsOf || '—') ?? '') },
  { key: 'inceptionDate', label: 'Inception', numeric: false, text: (fund: any) => String((fund.inceptionDate || '—') ?? '') },
  { key: 'holdings', label: 'Holdings', numeric: true, text: (fund: any) => String((formatInteger(fund.holdings)) ?? ''), value: (fund: any) => fund.holdings },
  { key: 'history', label: 'History', numeric: true, text: (fund: any) => String((formatInteger(fund.history)) ?? ''), value: (fund: any) => fund.history },
  { key: 'asOfDate', label: 'As Of', numeric: false, text: (fund: any) => String((fund.asOfDate || '—') ?? '') },
];

const WATCHLIST_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'symbol', label: 'Ticker', numeric: false, text: (row: any) => String(row.symbol ?? ''), extraClass: 'watchlist-sticky-col watchlist-sticky-ticker' },
  { key: 'name', label: 'Name', numeric: false, text: (row: any) => String(row.name ?? '') },
  { key: 'funds', label: 'ETFs', numeric: false, text: (row: any) => (Array.isArray(row.funds) ? row.funds.join(' ') : '') },
  { key: 'fundCount', label: '# ETFs', numeric: true, text: (row: any) => String(row.fundCount ?? ''), value: (row: any) => row.fundCount },
  { key: 'weightSum', label: 'Weight Sum', numeric: true, text: (row: any) => (typeof row.weightSum === 'number' ? `${row.weightSum.toFixed(3)}%` : ''), value: (row: any) => row.weightSum },
  { key: 'maxWeight', label: 'Max Weight', numeric: true, text: (row: any) => (typeof row.maxWeight === 'number' ? `${row.maxWeight.toFixed(3)}%` : ''), value: (row: any) => row.maxWeight },
  { key: 'identifier', label: 'Identifier', numeric: false, text: (row: any) => String(row.identifier ?? '') },
];

/** Catalog rows after the tab, the blacklist, the search and the column filters (no sorting). */
function filteredCatalogFunds(): FundRow[] {
  const base = visibleFunds();
  return applyColumnFilters('catalog', filterRows(base), FUND_FILTER_COLUMNS, base);
}

/** Sheet rows (holdings, history, distributions) as objects with the cells in col0..colN, after the search and the column filters (no sorting). */
function sheetView(scope: string, headers: string[], sourceRows: string[][], numericHeaders: string[]): any[] {
  // Themes distribution rows are objects keyed by header ({ 'Ex-Date': ..., Amount: ... }); the other sheets are arrays
  const all = sourceRows.map((rawRow: any, sourceIndex) => {
    const row: string[] = Array.isArray(rawRow) ? rawRow : headers.map(header => String((rawRow && rawRow[header]) ?? ''));
    const cells: Record<string, unknown> = { values: row, searchIndex: row.join(' ').toLowerCase(), rank: sourceIndex };
    headers.forEach((header, index) => { cells[`col${index}`] = row[index] ?? ''; });
    return cells;
  });
  return applyColumnFilters(scope, filterRows(all), sheetFilterColumns(headers, numericHeaders), all);
}

// =========================================================================
// 3e. Columns menu: show or hide the columns of the ETF catalog table (the choice is remembered in localStorage)
// =========================================================================

// ---- one reusable multi-select popover (same component as the Stocks app) ----

type DropdownItem = { id: string; label: string; count: number; selected: boolean; badges?: string; locked?: boolean }; // locked: always selected, cannot be toggled

type Dropdown = { refresh(): void; open(query?: string): void; close(restoreFocus?: boolean): void; isOpen(): boolean };

type DropdownConfig = {
  trigger: any;
  panel: any;
  title: string; // "Exchanges"
  noun: string; // "exchanges", used in the search placeholder and the empty state
  unit: string; // what the row number counts: "stocks" or "columns"
  getItems(): DropdownItem[];
  /** Receives the complete new selection; the owner persists it and re-renders. */
  onChange(selected: Set<string>): void;
};

const DD_TICK = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

/**
 * Accessible multi-select popover. Layout, top to bottom: search field (first
 * line, autofocused), bulk actions (All / Clear / Toggle / Reset),
 * counts + "Selected only", the scrollable option list. The selection lives in
 * the owner's state and is independent of the search text: the search only
 * decides which rows are visible, bulk actions touch only the visible rows and
 * merge with the rest, Reset restores "everything selected".
 * Keyboard (focus stays in the search input; combobox + aria-activedescendant):
 * Up/Down/PageUp/PageDown move, Enter toggles the active row (Shift+Enter =
 * Only), Space toggles while the search is empty, Ctrl/Cmd+A selects all visible,
 * Esc clears the search, then closes and refocuses the trigger. Typing on the
 * closed trigger opens the list with that text as the query. Under 640px the
 * panel is a bottom sheet with a backdrop (see .dd-panel in index.html).
 */
function createDropdown(cfg: DropdownConfig): Dropdown {
  const { trigger, panel } = cfg;
  const uid = panel.id;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', cfg.title);
  panel.innerHTML = `
    <div class="dd-search">
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3.5 3.5"/></svg>
      <input type="text" class="dd-input" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${uid}-list" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search ${escapeHtml(cfg.noun)}..." aria-label="Search ${escapeHtml(cfg.noun)}" />
      <button type="button" class="dd-qclear" hidden aria-label="Clear search" tabindex="-1">✕</button>
      <button type="button" class="dd-close" aria-label="Close ${escapeHtml(cfg.title)}">✕</button>
    </div>
    <div class="dd-actions" role="group" aria-label="Bulk actions for the shown ${escapeHtml(cfg.noun)}">
      <button type="button" class="dd-act" data-act="all" title="Select every shown row (Ctrl/Cmd+A)">All</button>
      <button type="button" class="dd-act" data-act="none" title="Deselect every shown row">Clear</button>
      <button type="button" class="dd-act" data-act="toggle" title="Invert the selection of the shown rows">Toggle</button>
      <button type="button" class="dd-act" data-act="reset" title="Back to the default: everything selected, whatever the search">Reset</button>
    </div>
    <div class="dd-meta">
      <span class="dd-count" aria-live="polite"></span>
      <button type="button" class="dd-seltoggle" aria-pressed="false" title="Show only the rows selected so far">Selected only</button>
    </div>
    <div class="dd-list themed-scroll" id="${uid}-list" tabindex="-1" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(cfg.title)}"></div>`;
  const backdrop = document.createElement('div');
  backdrop.className = 'dd-backdrop';
  // Portal both to <body>: no ancestor stacking context or overflow can cover or clip the popover.
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  const input: any = panel.querySelector('.dd-input');
  const list: any = panel.querySelector('.dd-list');
  const count: any = panel.querySelector('.dd-count');
  const qClear: any = panel.querySelector('.dd-qclear');
  const selToggle: any = panel.querySelector('.dd-seltoggle');

  let isOpen = false;
  let query = '';
  let selectedOnly = false;
  let activeId: string | null = null;
  let shown: DropdownItem[] = [];
  let closeTimer: any = 0;

  const optionId = (index: number) => `${uid}-o${index}`;
  const inRoot = (node: any) => Boolean(node && (panel.contains(node) || trigger.contains(node) || backdrop.contains(node)));

  function matches(item: DropdownItem): boolean {
    if (selectedOnly && !item.selected) return false;
    const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const text = normalizeSearchText(item.label);
    return tokens.every(token => text.includes(token));
  }

  function paintActive(scroll: boolean): void {
    const rows: any[] = [...list.querySelectorAll('.dd-opt')];
    let activeEl: any = null;
    rows.forEach(row => {
      const on = row.dataset.id === activeId;
      row.classList.toggle('is-active', on);
      if (on) activeEl = row;
    });
    if (activeEl) input.setAttribute('aria-activedescendant', activeEl.id);
    else input.removeAttribute('aria-activedescendant');
    if (scroll && activeEl) {
      const top = activeEl.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 6;
      else if (top + activeEl.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + activeEl.offsetHeight - list.clientHeight + 6;
    }
  }

  function refresh(): void {
    const all = cfg.getItems();
    shown = all.filter(matches);
    if (!shown.some(item => item.id === activeId)) activeId = shown.length ? shown[0].id : null;
    const keepScroll = list.scrollTop;
    list.innerHTML = shown.length
      ? shown.map((item, i) => `
        <div class="dd-opt${item.count === 0 ? ' dd-zero' : ''}${item.locked ? ' dd-locked' : ''}" role="option" id="${optionId(i)}" data-id="${escapeHtml(item.id)}" aria-selected="${item.selected}"${item.locked ? ' aria-disabled="true" title="Always shown"' : ''}>
          <span class="dd-check">${DD_TICK}</span>
          <span class="dd-name" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
          ${item.badges || ''}
          <span class="dd-num" title="${escapeHtml(cfg.unit)}">${item.count}</span>
          ${item.locked ? `<span class="dd-only dd-only-ghost" aria-hidden="true">Only</span>` : `<button type="button" class="dd-only" data-only tabindex="-1" aria-label="Only ${escapeHtml(item.label)}">Only</button>`}
        </div>`).join('')
      : `<div class="dd-empty">${selectedOnly && !query.trim() ? `Nothing selected` : `No ${escapeHtml(cfg.noun)} match “${escapeHtml(query.trim())}”`}</div>`;
    list.scrollTop = keepScroll;
    const selectedTotal = all.filter(item => item.selected).length;
    const narrowed = Boolean(query.trim()) || selectedOnly;
    count.textContent = `${selectedTotal} of ${all.length} selected${narrowed ? ` · ${shown.filter(item => item.selected).length} of ${shown.length} shown` : ''}`;
    qClear.hidden = !query;
    selToggle.setAttribute('aria-pressed', String(selectedOnly));
    selToggle.classList.toggle('is-on', selectedOnly);
    paintActive(false);
  }

  function apply(op: 'all' | 'none' | 'toggle' | 'reset' | 'flip' | 'only', id = ''): void {
    const all = cfg.getItems();
    let next = new Set(all.filter(item => item.selected).map(item => item.id));
    const visible = shown.map(item => item.id);
    if (op === 'all') visible.forEach(v => next.add(v));
    else if (op === 'none') visible.forEach(v => next.delete(v));
    else if (op === 'toggle') visible.forEach(v => { if (next.has(v)) next.delete(v); else next.add(v); });
    else if (op === 'reset') next = new Set(all.map(item => item.id));
    else if (op === 'flip') { if (next.has(id)) next.delete(id); else next.add(id); }
    else if (op === 'only') next = new Set([id]);
    all.forEach(item => { if (item.locked) next.add(item.id); }); // locked rows stay selected whatever the operation
    cfg.onChange(next);
    refresh();
  }

  function place(): void {
    panel.style.left = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.maxHeight = '';
    if (window.matchMedia('(max-width: 639px)').matches) return; // bottom sheet, positioned by CSS
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const natural = panel.offsetHeight;
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const flip = below < Math.min(natural, 360) && above > below;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    panel.style.maxHeight = `${Math.max(180, flip ? above : below) - 8}px`;
    if (flip) {
      panel.style.top = 'auto';
      panel.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      panel.style.transformOrigin = 'bottom left';
    } else {
      panel.style.top = `${rect.bottom + 8}px`;
      panel.style.transformOrigin = 'top left';
    }
  }

  function open(initialQuery = ''): void {
    if (isOpen) return;
    isOpen = true;
    clearTimeout(closeTimer);
    query = initialQuery;
    selectedOnly = false;
    input.value = initialQuery;
    const firstSelected = cfg.getItems().find(item => item.selected && matches(item));
    activeId = firstSelected ? firstSelected.id : null;
    refresh();
    panel.hidden = false;
    place();
    void panel.offsetWidth; // reflow so the transition starts from the closed state
    panel.classList.add('is-open');
    backdrop.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    const row: any = [...list.querySelectorAll('.dd-opt')].find((r: any) => r.dataset.id === activeId);
    if (row) list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop - list.clientHeight / 3);
    paintActive(false);
  }

  function close(restoreFocus = false): void {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!isOpen) panel.hidden = true; }, reduceMotion() ? 0 : 200);
  }

  function move(delta: number): void {
    if (!shown.length) return;
    const index = shown.findIndex(item => item.id === activeId);
    const next = index < 0 ? (delta > 0 ? 0 : shown.length - 1) : (index + delta + shown.length) % shown.length;
    activeId = shown[next].id;
    paintActive(true);
  }

  function setQuery(value: string): void {
    query = value;
    list.scrollTop = 0;
    refresh();
  }

  trigger.addEventListener('click', () => { if (isOpen) close(); else open(); });
  trigger.addEventListener('keydown', (event: any) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
    else if (event.key.length === 1 && event.key !== ' ') { event.preventDefault(); open(event.key); }
  });
  input.addEventListener('input', () => setQuery(input.value));
  input.addEventListener('keydown', (event: any) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      apply('all');
      return;
    }
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(1); break;
      case 'ArrowUp': event.preventDefault(); move(-1); break;
      case 'PageDown': event.preventDefault(); move(8); break;
      case 'PageUp': event.preventDefault(); move(-8); break;
      case 'Enter':
        event.preventDefault();
        if (activeId !== null && shown.some(item => item.id === activeId)) apply(event.shiftKey ? 'only' : 'flip', activeId);
        break;
      case ' ':
        if (!input.value && activeId !== null) { event.preventDefault(); apply('flip', activeId); }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (input.value) { input.value = ''; setQuery(''); } else close(true);
        break;
      default:
    }
  });
  panel.addEventListener('keydown', (event: any) => {
    if (event.key === 'Escape' && event.target !== input) { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  list.addEventListener('mousedown', (event: any) => event.preventDefault()); // keep focus in the search field
  list.addEventListener('pointermove', (event: any) => {
    const row = event.target.closest && event.target.closest('.dd-opt');
    if (row && row.dataset.id !== activeId) { activeId = row.dataset.id; paintActive(false); }
  });
  list.addEventListener('click', (event: any) => {
    const row = event.target.closest && event.target.closest('.dd-opt');
    if (!row) return;
    apply(event.target.closest('[data-only]') ? 'only' : 'flip', row.dataset.id);
  });
  qClear.addEventListener('mousedown', (event: any) => event.preventDefault());
  qClear.addEventListener('click', () => { input.value = ''; setQuery(''); input.focus(); });
  panel.querySelector('.dd-close').addEventListener('click', () => close(true));
  backdrop.addEventListener('click', () => close());
  selToggle.addEventListener('click', () => { selectedOnly = !selectedOnly; list.scrollTop = 0; refresh(); input.focus({ preventScroll: true }); });
  panel.querySelectorAll('[data-act]').forEach((button: any) => {
    button.addEventListener('click', () => apply(button.dataset.act));
  });
  panel.addEventListener('focusout', (event: any) => {
    if (isOpen && event.relatedTarget && !inRoot(event.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', (event: any) => {
    if (isOpen && !inRoot(event.target)) close();
  });
  window.addEventListener('resize', () => { if (isOpen) place(); });
  window.addEventListener('scroll', () => { if (isOpen) place(); }, { passive: true, capture: true });
  // The panel lives at the end of <body>, so Tab at its edges hands focus back to the page order around the trigger.
  panel.addEventListener('keydown', (event: any) => {
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('input, button')].filter((node: any) => node.tabIndex >= 0 && node.offsetParent !== null);
    if (!focusable.length) return;
    const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
    if (event.target !== edge) return;
    event.preventDefault();
    close();
    if (event.shiftKey) { trigger.focus({ preventScroll: true }); return; }
    const page = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
      .filter((node: any) => !panel.contains(node) && node.tabIndex >= 0 && !node.disabled && (node.offsetParent !== null || node === trigger));
    const next: any = page[page.indexOf(trigger) + 1];
    if (next) next.focus();
  });

  return { refresh, open, close, isOpen: () => isOpen };
}

// ---- the Columns menu: Use and Ticker are listed but locked, everything else is optional ----

const COLUMN_VISIBILITY_KEY = `${FILTER_STORAGE_PREFIX}-hidden-columns`;
const CATALOG_LEADING_CELLS = 2; // the # cell and the Use cell stand in front of FUND_FILTER_COLUMNS

let hiddenColumns: Set<string> = new Set();
let columnsDd: Dropdown | null = null;
let columnsRoot: any = null;
let columnsStyle: any = null;

/** One row per column, first to last as in the table. */
function menuColumns(): Array<{ key: string; label: string; locked: boolean }> {
  return [{ key: 'use', label: 'Use', locked: true }]
    .concat(FUND_FILTER_COLUMNS.map(col => ({ key: col.key, label: col.label, locked: col.key === 'ticker' })));
}

function loadHiddenColumns(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_VISIBILITY_KEY) || '[]');
    if (Array.isArray(saved)) hiddenColumns = new Set(saved.filter(key => typeof key === 'string' && menuColumns().some(col => col.key === key && !col.locked)));
  } catch {
    hiddenColumns = new Set();
  }
}

function persistHiddenColumns(): void {
  try {
    localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify([...hiddenColumns]));
  } catch {
    // Storage is blocked: the choice lasts for this page only.
  }
}

/** Hidden cells are removed with CSS (header, filter row and body share the same cell positions), so sorting, filters, exports and Copy Tickers never change. */
function hiddenColumnsCss(): string {
  const selectors: string[] = [];
  FUND_FILTER_COLUMNS.forEach((col, index) => {
    if (col.key === 'ticker' || !hiddenColumns.has(col.key)) return;
    const position = index + CATALOG_LEADING_CELLS + 1;
    selectors.push(`#table-head > tr > :nth-child(${position}), #table-body > tr > :nth-child(${position})`);
  });
  return selectors.length ? `${selectors.join(',')}{display:none}` : '';
}

function columnMenuItems(): DropdownItem[] {
  return menuColumns().map((col, index) => ({ id: col.key, label: col.label, count: index + 1, selected: col.locked || !hiddenColumns.has(col.key), locked: col.locked }));
}

function renderColumnsButton(): void {
  const total = menuColumns().length;
  const shown = total - hiddenColumns.size;
  const summary: any = document.getElementById('columns-summary');
  const badge: any = document.getElementById('columns-badge');
  const button: any = document.getElementById('columns-btn');
  if (!summary || !badge || !button) return;
  summary.textContent = shown === total ? `${shown} of ${total}` : `${shown} selected`;
  badge.hidden = shown === total;
  badge.textContent = `${shown}/${total}`;
  button.classList.toggle('is-filtered', shown < total);
}

function applyColumnSelection(selected: Set<string>): void {
  hiddenColumns = new Set(menuColumns().filter(col => !col.locked && !selected.has(col.key)).map(col => col.key));
  persistHiddenColumns();
  if (columnsStyle) columnsStyle.textContent = hiddenColumnsCss();
  renderColumnsButton();
}

/** Builds the Columns button, its panel and the style element once, in front of the Filters button. */
function ensureColumnsMenu(): void {
  if (columnsRoot) return;
  const anchor: any = document.getElementById('filters-btn');
  if (!anchor || !anchor.parentNode) return;
  columnsStyle = document.createElement('style');
  columnsStyle.id = 'column-visibility-style';
  document.head.appendChild(columnsStyle);
  columnsRoot = document.createElement('div');
  columnsRoot.className = 'dd-root';
  columnsRoot.hidden = true;
  columnsRoot.innerHTML = `<button type="button" id="columns-btn" class="dd-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="columns-panel" title="Choose the columns of the table"><span class="dd-label">Columns:</span><span class="dd-value" id="columns-summary">...</span><span class="dd-badge" id="columns-badge" hidden></span><svg class="dd-chev" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></button><div id="columns-panel" class="dd-panel" hidden></div>`;
  anchor.parentNode.insertBefore(columnsRoot, anchor);
  columnsDd = createDropdown({
    trigger: document.getElementById('columns-btn'),
    panel: document.getElementById('columns-panel'),
    title: 'Columns',
    noun: 'columns',
    unit: 'column position',
    getItems: columnMenuItems,
    onChange: applyColumnSelection,
  });
  renderColumnsButton();
}

/** on = the catalog table is shown: apply the hidden columns and show the menu; off = Watchlist or a detail tab, every cell is visible. */
function setCatalogColumnStyle(on: boolean): void {
  ensureColumnsMenu();
  if (columnsStyle) columnsStyle.textContent = on ? hiddenColumnsCss() : '';
  if (columnsRoot) columnsRoot.hidden = !on;
  if (!on && columnsDd) columnsDd.close();
}

loadHiddenColumns();

// =========================================================================
// 3f. Categories dropdown: replaces the category tabs; every category is selected by default (= All ETFs)
// =========================================================================

const HIDDEN_CATEGORIES_KEY = `${FILTER_STORAGE_PREFIX}-hidden-categories`;

let hiddenCategories: Set<string> = new Set();
let categoriesDd: Dropdown | null = null;
let categoriesRoot: any = null;

function loadHiddenCategories(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_CATEGORIES_KEY) || '[]');
    if (Array.isArray(saved)) hiddenCategories = new Set(saved.filter(name => typeof name === 'string'));
  } catch {
    hiddenCategories = new Set();
  }
}

function persistHiddenCategories(): void {
  try {
    localStorage.setItem(HIDDEN_CATEGORIES_KEY, JSON.stringify([...hiddenCategories]));
  } catch {
    // Storage is blocked: the choice lasts for this page only.
  }
}

/** True while some, but not all, asset classes are checked: only then the table is narrowed (all or none checked = All ETFs). */
function categoryFilterActive(): boolean {
  const all = uniqueCategories();
  const shown = all.filter(category => !hiddenCategories.has(category)).length;
  return shown > 0 && shown < all.length;
}

function categoryAllowed(category: string): boolean {
  return !categoryFilterActive() || !hiddenCategories.has(category);
}

function categoryItems(): DropdownItem[] {
  return uniqueCategories().map(category => ({
    id: category,
    label: categoryLabel(category),
    count: state.funds.filter(fund => fund.category === category && !state.blacklist.has(fund.ticker)).length,
    selected: !hiddenCategories.has(category),
  }));
}

function applyCategorySelection(selected: Set<string>): void {
  hiddenCategories = new Set(uniqueCategories().filter(category => !selected.has(category)));
  persistHiddenCategories();
  render();
}

function renderCategoriesButton(): void {
  const summary: any = document.getElementById('categories-summary');
  const badge: any = document.getElementById('categories-badge');
  const button: any = document.getElementById('categories-btn');
  if (!summary || !badge || !button) return;
  const all = uniqueCategories();
  const shown = all.filter(category => !hiddenCategories.has(category));
  const filtered = categoryFilterActive();
  summary.textContent = !filtered ? 'All' : shown.length === 1 ? categoryLabel(shown[0]) : `${shown.length} selected`;
  badge.hidden = !filtered;
  badge.textContent = `${shown.length}/${all.length}`;
  button.classList.toggle('is-filtered', filtered);
  if (categoriesRoot) categoriesRoot.hidden = all.length < 2;
}

/** Builds the Categories button and its panel once, right after the All ETFs pill. */
function ensureCategoriesMenu(): void {
  if (categoriesRoot) return;
  const anchor: any = document.getElementById('tabs-bar');
  if (!anchor || !anchor.parentNode) return;
  categoriesRoot = document.createElement('div');
  categoriesRoot.className = 'dd-root';
  categoriesRoot.hidden = true;
  categoriesRoot.innerHTML = `<button type="button" id="categories-btn" class="dd-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="categories-panel" title="Show only some asset classes (All = every ETF)"><span class="dd-label">Asset classes:</span><span class="dd-value" id="categories-summary">...</span><span class="dd-badge" id="categories-badge" hidden></span><svg class="dd-chev" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></button><div id="categories-panel" class="dd-panel dd-panel-wide" hidden></div>`;
  anchor.parentNode.insertBefore(categoriesRoot, anchor.nextSibling);
  categoriesDd = createDropdown({
    trigger: document.getElementById('categories-btn'),
    panel: document.getElementById('categories-panel'),
    title: 'Asset classes',
    noun: 'asset classes',
    unit: 'ETFs',
    getItems: categoryItems,
    onChange: applyCategorySelection,
  });
}

loadHiddenCategories();


init();

// =========================================================================
// 3. Theme & small helpers
// =========================================================================

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  el.themeToggle.textContent = dark ? '☀️' : '🌙';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char] || char));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '-') return null;
  const parsed = Number(value.replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberCell(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? '' : String(parsed);
}

function formatPercent(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? '—' : `${parsed.toFixed(2)}%`;
}

function formatDividendFrequency(value: unknown): string {
  const raw = String(value ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  if (!normalized || normalized === '-') return '00 - None';
  if (normalized === 'monthly') return '01 - Monthly';
  if (normalized === 'quarterly') return '04 - Quarterly';
  if (normalized === 'semi-annual' || normalized === 'semi-annually' || normalized === 'semiannual' || normalized === 'semiannually') return '06 - Semi-annually';
  if (normalized === 'annual' || normalized === 'annually') return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular') return '99 - Irregular';
  return raw;
}

function formatInteger(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null || parsed === 0 ? '—' : parsed.toLocaleString('en-US');
}

function formatMoney(value: unknown): string {
  const parsed = numberOrNull(value);
  if (parsed === null) return '—';
  if (Math.abs(parsed) >= 1e12) return `$${(parsed / 1e12).toFixed(2)}T`;
  if (Math.abs(parsed) >= 1e9) return `$${(parsed / 1e9).toFixed(2)}B`;
  if (Math.abs(parsed) >= 1e6) return `$${(parsed / 1e6).toFixed(2)}M`;
  if (Math.abs(parsed) >= 1e3) return `$${(parsed / 1e3).toFixed(2)}K`;
  return `$${parsed.toFixed(2)}`;
}

function sanitizeTicker(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function getHeaderTooltip(header: string): string {
  if (!header) return '';
  if (COLUMN_TOOLTIPS[header]) return COLUMN_TOOLTIPS[header];
  const clean = String(header).trim();
  const keys = Object.keys(COLUMN_TOOLTIPS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key.toLowerCase() === clean.toLowerCase()) return COLUMN_TOOLTIPS[key];
  }
  return clean;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function downloadText(text: string, fileName: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows: string[][]): string {
  return rows
    .map(row => row.map(cell => {
      const value = String(cell ?? '');
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(','))
    .join('\n');
}

function exportFileName(scope: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `themes-${scope.toLowerCase().replace(/\s+/g, '-')}-${stamp}.${extension}`;
}

function setStatus(message: string, tone: 'info' | 'success' | 'error'): void {
  console.debug(`[${tone}] ${message}`);
}

// =========================================================================
// 4. Static API loading & paginated sheets (api/themes/**, iShares-style)
// =========================================================================

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** Flattens index.json month-end metrics onto the row so sorting works. */
function normalizeFundRow(fund: IndexFund): FundRow {
  const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
  const metrics = fund.metrics || {};
  const row: any = {
    ...fund,
    ytd: monthEnd.ytd ?? null,
    yr1: metrics.tr1y ?? monthEnd.yr1 ?? null,
    yr3: monthEnd.yr3 ?? null,
    yr5: monthEnd.yr5 ?? null,
    yr10: monthEnd.yr10 ?? null,
    si: metrics.siAnn ?? monthEnd.sinceInception ?? null,
    tr3y: metrics.tr3y ?? null,
    tr5y: metrics.tr5y ?? null,
    tr10y: metrics.tr10y ?? null,
    cagr3y: metrics.cagr3y ?? monthEnd.yr3 ?? null,
    cagr5y: metrics.cagr5y ?? monthEnd.yr5 ?? null,
    cagr10y: metrics.cagr10y ?? monthEnd.yr10 ?? null,
    dividendYield: metrics.dividendYield ?? null,
    dividendFrequency: formatDividendFrequency(fund.distributions && fund.distributions.frequency ? fund.distributions.frequency : '—'),
    secYield: metrics.secYield ?? null, // official Themes ETFs 30-Day SEC Yield from the fund page / lineup table.
    returnAsOf: monthEnd.asOfDate ?? null,
    searchIndex: '',
  };
  row.searchIndex = [
    fund.ticker, fund.name, fund.category, fund.ter, fund.nav, fund.aum,
    fund.exchange, fund.inceptionDate, fund.asOfDate, monthEnd.asOfDate,
    fund.distributions && fund.distributions.frequency, metrics.dividendYieldText, metrics.secYieldText,
    fund.cusip, fund.isin,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
  return row;
}

async function loadCatalog(): Promise<void> {
  setStatus('Loading Themes ETFs data from api/themes/index.json…', 'info');
  const data = await fetchJson(INDEX_URL);
  state.funds = (data.funds || [])
    .map((fund: IndexFund) => normalizeFundRow(fund))
    .sort((a: FundRow, b: FundRow) => a.ticker.localeCompare(b.ticker));
  state.generatedAt = data.generatedAt || null;
  state.counts = data.counts || null;

  // A restored selection/blacklist must reference known funds only.
  state.blacklist = new Set([...state.blacklist].filter(ticker => state.funds.some(fund => fund.ticker === ticker)));
  state.selected = new Set([...state.selected].filter(ticker => state.funds.some(fund => fund.ticker === ticker) && !state.blacklist.has(ticker)));
  if (!state.activeFundTicker && state.selected.size) state.activeFundTicker = [...state.selected][0] || null;
  if (state.activeFundTicker && !state.selected.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }

  el.searchInput.disabled = false;
  [el.copyBtn, el.exportCsvBtn, el.exportTxtBtn, el.resetBtn].forEach(button => { button.disabled = false; });
  applyRestoredTab();
  applySortForTab(state.activeTab);
  render();
  void ensureHoldingsForSelection();
  const activeTicker = state.activeFundTicker;
  if (activeTicker) {
    void loadFundMeta(activeTicker).then(meta => {
      if (meta && state.activeTab === 'detail:holdings') void ensureSheet('holdings', meta.holdings);
    });
  }
}

/**
 * meta.json requests are deduplicated per ticker while in flight: the
 * detail view and the background Watchlist loader share one request.
 * Catalog-only funds (no holdings, no history) short-circuit to null and
 * are cached as such; failed fetches are not cached so they can retry.
 */
async function loadFundMeta(ticker: string): Promise<any> {
  const cached = fundMetaCache.get(ticker);
  if (cached !== undefined) return cached;
  const inflight = metaInFlight.get(ticker);
  if (inflight) return inflight;
  const known = state.funds.find(fund => fund.ticker === ticker);
  if (known && !known.holdings && !known.history) {
    fundMetaCache.set(ticker, null); // catalog-only fund: no workbook exists
    return null;
  }
  const request = (async () => {
    try {
      const meta = await fetchJson(`./api/themes/funds/${encodeURIComponent(ticker)}/meta.json`);
      fundMetaCache.set(ticker, meta);
      return meta;
    } catch (error) {
      console.warn(`Failed to load meta.json for ${ticker}:`, error);
      return null;
    }
  })();
  metaInFlight.set(ticker, request.finally(() => metaInFlight.delete(ticker)));
  return metaInFlight.get(ticker);
}

function sheetKey(sheet: string): string {
  return `${state.activeFundTicker}:${sheet}`;
}

function resetSheetPaging(): void {
  sheetGeneration += 1;
}

async function fetchPage(ticker: string, pagePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  const path = String(pagePath).replace(/^\.?\//, '');
  const page = await fetchJson(`./api/themes/funds/${encodeURIComponent(ticker)}/${path}`);
  const headers: string[] = Array.isArray(page.headers) ? page.headers : [];
  const rows: any[] = Array.isArray(page.rows) ? page.rows : [];
  return { headers, rows: rows.map(row => headers.map(header => String(row[header] ?? ''))) };
}

/** Loads the first page of a paginated sheet and prepares lazy appending. */
async function ensureSheet(sheet: 'holdings' | 'history', manifest: any): Promise<void> {
  const key = sheetKey(sheet);
  if (sheetState.has(key) || !manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) return;
  sheetState.set(key, { headers: [], rows: [], nextPage: 0, manifest, loading: false });
  await loadNextSheetPage(sheet);
}

/**
 * Serializes page-load work per ticker: the detail-view pager and the
 * background Watchlist loader enqueue onto the same chain, and each unit of
 * work re-checks `nextPage` while holding the chain — so two rapid selection
 * updates can never fetch the same holdings page twice or skip one.
 */
function withTickerChain<T>(ticker: string, fn: () => Promise<T>): Promise<T> {
  const previous = holdingsChains.get(ticker) ?? Promise.resolve();
  const work = previous.then(fn, fn);
  holdingsChains.set(ticker, work.then(() => undefined, () => undefined));
  return work;
}

/** Fetches the next page of `entry`. The caller must already hold the
 *  per-ticker chain (loadAllHoldingsForTicker) or use appendSheetPage. */
async function fetchNextSheetPage(ticker: string, entry: SheetEntry): Promise<void> {
  if (entry.nextPage >= entry.manifest.pages.length) return;
  const page = await fetchPage(ticker, entry.manifest.pages[entry.nextPage]);
  if (!entry.headers.length && page.headers.length) entry.headers = page.headers;
  entry.rows = entry.rows.concat(page.rows);
  entry.nextPage += 1;
}

/** Enqueues the next page fetch of `entry` under the per-ticker chain (no-op when the manifest is exhausted). */
function appendSheetPage(ticker: string, entry: SheetEntry): Promise<void> {
  return withTickerChain(ticker, () => fetchNextSheetPage(ticker, entry));
}

async function loadNextSheetPage(sheet: 'holdings' | 'history'): Promise<void> {
  const key = sheetKey(sheet);
  const entry = sheetState.get(key);
  const ticker = state.activeFundTicker;
  if (!entry || !ticker || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
  entry.loading = true;
  renderStaticLoadSentinel();
  try {
    const generation = sheetGeneration;
    await appendSheetPage(ticker, entry);
    if (generation !== sheetGeneration) return;
    if (state.activeTab === `detail:${sheet}`) render();
  } catch (error) {
    console.error(`Failed to load ${ticker} ${sheet} page:`, error);
  } finally {
    entry.loading = false;
    renderStaticLoadSentinel();
  }
}

/** True while any selected ETF's holdings have not finished loading. */
function isHoldingsLoading(): boolean {
  for (const ticker of state.selected) {
    if (!holdingsComplete.has(ticker)) return true;
  }
  return false;
}

/**
 * Loads every holdings page of one ticker. Runs inside the per-ticker chain,
 * so it composes safely with the detail-view pager (shared cache entry, no
 * duplicate or skipped pages). Queued work for an ETF that was deselected in
 * the meantime is skipped; in-flight loads finish into the cache and are
 * ignored by the aggregation, which only reads the current selection.
 */
async function loadAllHoldingsForTicker(ticker: string): Promise<void> {
  await withTickerChain(ticker, async () => {
    if (!state.selected.has(ticker)) return; // deselected while queued: skip
    const meta = await loadFundMeta(ticker);
    if (!meta || !meta.holdings || !Array.isArray(meta.holdings.pages) || !meta.holdings.pages.length) return;
    const key = `${ticker}:holdings`;
    let entry = sheetState.get(key);
    if (!entry) {
      entry = { headers: [], rows: [], nextPage: 0, manifest: meta.holdings, loading: false };
      sheetState.set(key, entry);
    }
    while (entry.nextPage < entry.manifest.pages.length) {
      if (!state.selected.has(ticker)) return; // deselected mid-load: skip the rest
      await fetchNextSheetPage(ticker, entry); // chain already held: no re-queue
    }
  });
}

/**
 * Watchlist aggregation needs every holdings page of every selected ETF
 * (same pipeline as daggerok/iShares). Runs with bounded concurrency (6
 * funds at a time) so a whole-catalog selection cannot overload the static
 * feed; Watchlist holdings are cached under each fund's own key,
 * independent of the active fund.
 */
async function ensureHoldingsForSelection(): Promise<void> {
  const queue = [...state.selected].filter(ticker => !holdingsComplete.has(ticker));
  if (!queue.length) return;
  const workers = Array.from({ length: Math.min(HOLDINGS_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const ticker = queue.shift();
      if (!ticker) break;
      try {
        await loadAllHoldingsForTicker(ticker);
      } catch (error) {
        console.error(`Failed to load ${ticker} holdings:`, error);
      } finally {
        holdingsComplete.add(ticker);
        if (state.selected.size > 0) {
          // Keep the Watchlist tab label honest (Loading… -> N+ -> exact)
          // even while the user stays on another tab.
          if (state.activeTab === 'watchlist') scheduleWatchlistRefresh();
          else renderTabs();
        }
      }
    }
  });
  await Promise.all(workers);
  if (state.selected.size > 0) {
    if (state.activeTab === 'watchlist') renderWatchlistTable();
    renderTabs();
  }
}

/** Progressive Watchlist rerenders are throttled (~150 ms) while rows stream in. */
function scheduleWatchlistRefresh(): void {
  if (state.activeTab !== 'watchlist') return;
  if (watchlistRefreshTimer !== null) return;
  watchlistRefreshTimer = setTimeout(() => {
    watchlistRefreshTimer = null;
    if (state.activeTab === 'watchlist') { renderWatchlistTable(); renderTabs(); }
  }, 150);
}

function activeSheetTab(): 'holdings' | 'history' | null {
  if (state.activeTab === 'detail:holdings') return 'holdings';
  if (state.activeTab === 'detail:history') return 'history';
  return null;
}

function maybeLoadMoreRows(): void {
  const sheet = activeSheetTab();
  if (!sheet) return;
  void loadNextSheetPage(sheet);
}

function renderStaticLoadSentinel(): void {
  const sheet = activeSheetTab();
  if (!sheet || !state.activeFundTicker) {
    el.staticLoadSentinel.classList.add('hidden');
    return;
  }
  const entry = sheetState.get(sheetKey(sheet));
  if (!entry) {
    el.staticLoadSentinel.classList.add('hidden');
    return;
  }
  const more = entry.nextPage < entry.manifest.pages.length;
  el.staticLoadSentinel.classList.toggle('hidden', !more);
  el.staticLoadStatus.textContent = entry.loading ? 'Loading more rows…' : more ? 'Scroll or click to load more rows…' : '';
}

// =========================================================================
// 5. Navigation tabs & tab switching
// =========================================================================

function categoryLabel(category: string): string {
  return category || 'ETF';
}

function uniqueCategories(): string[] {
  const categories = [...new Set(state.funds.map(fund => fund.category).filter(Boolean))];
  return categories.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function visibleFunds(): FundRow[] {
  return state.funds.filter(fund => categoryAllowed(fund.category) && !state.blacklist.has(fund.ticker));
}

function getTabs(): TabInfo[] {
  const tabs: TabInfo[] = [];
  // The asset classes are a multi-select dropdown (3f), not tabs: All ETFs is the only catalog tab.
  tabs.push({ id: 'All', label: 'All ETFs', count: state.funds.filter(fund => categoryAllowed(fund.category) && !state.blacklist.has(fund.ticker)).length });
  return tabs;
}

function getSelectedTabs(): TabInfo[] {
  const tabs: TabInfo[] = [];
  const activeFund = getActiveFund();

  if (activeFund) {
    DETAIL_TABS.forEach(tab => {
      tabs.push({
        id: `detail:${tab.key}`,
        label: tab.key === 'overview' ? `${activeFund.ticker} ${tab.label}` : tab.label,
        count: getDetailCount(tab.key),
      });
    });
  }

  if (state.selected.size > 0) {
    const rowCount = getDedupedWatchlistRows().length;
    // While holdings are still loading, never show a misleading exact count:
    // "Loading…" (nothing aggregated yet) or "N+" (partial aggregation that
    // can only grow). The exact deduplicated count appears on completion.
    const count = isHoldingsLoading() ? (rowCount ? `${rowCount}+` : 'Loading…') : rowCount;
    tabs.push({ id: 'watchlist', label: 'Watchlist', count });
  }

  return tabs;
}

function getAllTabIds(): ActiveTab[] {
  return [...getTabs(), ...getSelectedTabs()].map(tab => tab.id);
}

function getActiveFund(): FundRow | null {
  if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) return null;
  return state.funds.find(fund => fund.ticker === state.activeFundTicker) || null;
}

function getDetailCount(key: string): number {
  const activeFund = getActiveFund();
  if (!activeFund) return 0;
  if (key === 'holdings') return activeFund.holdings || 0;
  if (key === 'history') return activeFund.history || 0;
  if (key === 'distributions') {
    const meta = fundMetaCache.get(activeFund.ticker);
    return meta && meta.distributions && Array.isArray(meta.distributions.rows) ? meta.distributions.rows.length : 0;
  }
  return 0;
}

function ensureValidTab(): void {
  const tabIds = getAllTabIds();
  if (!tabIds.includes(state.activeTab)) {
    state.activeTab = 'All';
    applySortForTab(state.activeTab);
  }
}

function applyRestoredTab(): void {
  const tabIds = getAllTabIds();
  if (!tabIds.includes(state.activeTab)) state.activeTab = 'All';
  syncSearchInput();
}

function renderTabs(): void {
  renderTabButtons(el.tabsBar, getTabs(), 0);
  ensureCategoriesMenu();
  renderCategoriesButton();
  categoriesDd?.refresh();
  const selectedTabs = getSelectedTabs();
  el.selectedTabsPanel.classList.toggle('is-visible', selectedTabs.length > 0);
  renderTabButtons(el.selectedTabsBar, selectedTabs);
}

function renderTabButtons(container: any, tabs: TabInfo[], minTabs = 1): void {
  container.classList.toggle('hidden', tabs.length <= minTabs);
  // All ETFs pill checkbox: checked iff EVERY non-blacklisted catalog ETF is
  // selected (.every over the whole catalog, never a size comparison).
  const catalogFunds = state.funds.filter(fund => !state.blacklist.has(fund.ticker));
  const allSelected = catalogFunds.length > 0 && catalogFunds.every(fund => state.selected.has(fund.ticker));
  container.innerHTML = tabs.map(tab => {
    // The All ETFs pill is lit only while no asset class narrows the table
    const isActive = tab.id === state.activeTab && (tab.id !== 'All' || !categoryFilterActive());
    const activeClasses = 'bg-blue-600 text-white font-medium border-blue-500 shadow-sm';
    const inactiveClasses = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700';
    if (tab.id === 'All') {
      return `
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
          <input type="checkbox" id="select-all-toggle" ${allSelected ? 'checked' : ''} class="w-3.5 h-3.5 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
          <button data-tab="All" class="font-medium hover:underline focus:outline-none">
            ${escapeHtml(tab.label)} (${tab.count})
          </button>
        </div>
      `;
    }
    return `
      <button
        data-tab="${escapeHtml(tab.id)}"
        class="px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
        ${escapeHtml(tab.label)} (${tab.count})
      </button>
    `;
  }).join('');

  container.querySelectorAll('button[data-tab]').forEach((button: any) => {
    button.addEventListener('click', () => {
      const next = button.dataset.tab || 'All';
      // Transition guard: leave the current tab's search query saved before
      // the destination tab restores its own (never overwrite when staying
      // on the same tab, e.g. at boot before DOM hydration).
      if (state.activeTab && state.activeTab !== next) saveActiveTabQuery();
      state.activeTab = next;
      if (next === 'All' && hiddenCategories.size) { hiddenCategories = new Set(); persistHiddenCategories(); } // All ETFs clears the asset class selection
      // Coming back to a tab (e.g. All ETFs after visiting Watchlist) must
      // show the sort the user last chose there, not the tab default.
      applySortForTab(state.activeTab);
      resetSheetPaging();
      syncSearchInput();
      persistSiteState();
      render();
      maybeLoadMoreRows();
    });
  });

  const selectAllToggle = container.querySelector('#select-all-toggle');
  if (selectAllToggle) {
    selectAllToggle.addEventListener('change', (event: any) => {
      event.stopPropagation();
      // All ETFs pill: whole non-blacklisted catalog from any tab, no navigation.
      toggleAllCatalogEfts(Boolean(event.target.checked));
    });
    selectAllToggle.addEventListener('click', (event: any) => event.stopPropagation());
  }
}

function applyDefaultSortForTab(tab: ActiveTab): void {
  if (tab === 'watchlist') {
    state.sortKey = 'weightSum';
    state.sortDir = 'desc';
  } else if (tab === 'detail:overview') {
    state.sortKey = 'section';
    state.sortDir = 'asc';
  } else {
    // Holdings, History and Distributions arrive already ordered by the
    // source workbook (weight / date); keep the source order by default.
    state.sortKey = 'rank';
    state.sortDir = 'asc';
  }
}

/**
 * Restores the sort the user last chose on this tab (recorded on every
 * column-header click, persisted in localStorage) or falls back to the tab
 * default when the tab was never explicitly sorted.
 */
function applySortForTab(tab: ActiveTab): void {
  const remembered = state.sortByTab[tab];
  if (remembered) {
    state.sortKey = remembered.key;
    state.sortDir = remembered.dir;
    return;
  }
  applyDefaultSortForTab(tab);
}

/** Records the current sort as this tab's remembered sort. */
function rememberSortForCurrentTab(): void {
  state.sortByTab[state.activeTab] = { key: state.sortKey, dir: state.sortDir };
  persistTabSorts();
}

function tabLabel(tab: ActiveTab): string {
  const match = /^detail:(.+)$/.exec(tab);
  if (match) {
    const found = DETAIL_TABS.find(item => item.key === match[1]);
    return found ? found.label : tab;
  }
  return tab === 'watchlist' ? 'Watchlist' : categoryLabel(tab);
}

function isEtfCatalogTab(tab: ActiveTab): boolean {
  return tab === 'All' || uniqueCategories().includes(tab);
}

function isDetailTab(tab: ActiveTab): boolean {
  return /^detail:(overview|holdings|history|distributions)$/.test(tab);
}

function detailTabKey(tab: ActiveTab): string {
  const match = /^detail:(.+)$/.exec(tab);
  return match ? match[1] : 'overview';
}

// =========================================================================
// 6. Table rendering, sorting & tooltips
// =========================================================================

function render(keepRows = true): void {
  const anchor = captureViewAnchor();
  setCatalogColumnStyle(false);
  ensureValidTab();
  updateSearchClearBtn();
  renderTabs();
  renderBlacklistPanel();
  animateTableUpdate();
  if (state.activeTab === 'watchlist') renderWatchlistTable();
  else if (isDetailTab(state.activeTab)) renderDetailTable(detailTabKey(state.activeTab));
  else renderFundsTable();
  fitTableHeight();
  renderStaticLoadSentinel();
  renderFilterControls();
  syncHeadHeight();
  restoreViewAnchor(anchor, keepRows);
  applySavedView();
  lastRenderedTab = state.activeTab;
}

function animateTableUpdate(): void {
  if (suppressTableAnimation) return;
  el.tableBody.classList.remove('table-content-enter');
  void el.tableBody.offsetWidth; // reflow to restart the animation
  el.tableBody.classList.add('table-content-enter');
}

// ---- keep the view where it was across re-renders (filter or search removed, columns changed) ----

type ViewAnchor = { tab: string; top: number; left: number; cols: number; col: number; colOffset: number; rows: { key: string; offset: number }[] };
let lastRenderedTab = '';

/** Right edge of the sticky leading columns: the first horizontally scrolling column starts here. */
/** The refresh animation of the table body moves every row by a few px for a moment: measure without it. */
function tbodyShift(): number {
  try { return new DOMMatrix(getComputedStyle(el.tableBody).transform).m42; } catch { return 0; }
}

function stickyEdge(): number {
  const box = el.tableScroll;
  const origin = box.getBoundingClientRect().left + box.clientLeft;
  let edge = origin;
  // from the CSS offset and width, not from the rect: a cell that has not stuck yet sits further right
  el.tableHead.querySelectorAll('tr:first-child th[class*="sticky-col"]').forEach((th: any) => {
    const left = parseFloat(getComputedStyle(th).left);
    if (Number.isFinite(left)) edge = Math.max(edge, origin + left + th.offsetWidth);
  });
  return edge;
}

/** Remembers the rows visible under the sticky header (with their offsets) and the first visible scrolling column. */
function captureViewAnchor(): ViewAnchor {
  const box = el.tableScroll;
  const boxRect = box.getBoundingClientRect();
  const headBottom = el.tableHead.getBoundingClientRect().bottom;
  const anchor: ViewAnchor = { tab: lastRenderedTab, top: box.scrollTop, left: box.scrollLeft, cols: 0, col: -1, colOffset: 0, rows: [] };
  for (const tr of Array.from(el.tableBody.rows) as any[]) {
    const rect = tr.getBoundingClientRect();
    if (rect.bottom <= headBottom) continue;
    if (rect.top >= boxRect.bottom || anchor.rows.length >= 40) break;
    const key = tr.dataset.key || tr.dataset.ticker;
    if (key) anchor.rows.push({ key, offset: rect.top - tbodyShift() - headBottom });
  }
  const cells = Array.from(el.tableHead.querySelectorAll('tr:first-child th')) as any[];
  const edge = stickyEdge();
  anchor.cols = cells.length;
  anchor.col = cells.findIndex(th => !/sticky-col/.test(th.className) && th.getBoundingClientRect().right > edge + 1);
  if (anchor.col >= 0) anchor.colOffset = cells[anchor.col].getBoundingClientRect().left - edge;
  return anchor;
}

/** Puts the first remembered row that still exists back at its old offset and the same column at its old place; falls back to the top when none of the visible rows survived. */
function restoreViewAnchor(anchor: ViewAnchor, keepRows: boolean): void {
  if (anchor.tab !== state.activeTab) return;
  const box = el.tableScroll;
  const headBottom = el.tableHead.getBoundingClientRect().bottom;
  if (keepRows && anchor.rows.length) {
    const byKey = new Map<string, any>();
    for (const tr of Array.from(el.tableBody.rows) as any[]) {
      const key = tr.dataset.key || tr.dataset.ticker;
      if (key) byKey.set(key, tr);
    }
    const hit = anchor.rows.find(row => byKey.has(row.key));
    box.scrollTop = hit ? box.scrollTop + byKey.get(hit.key).getBoundingClientRect().top - tbodyShift() - headBottom - hit.offset : 0;
  } else if (!keepRows) box.scrollTop = anchor.top;
  const cells = Array.from(el.tableHead.querySelectorAll('tr:first-child th')) as any[];
  if (anchor.col >= 0 && cells.length === anchor.cols) box.scrollLeft += cells[anchor.col].getBoundingClientRect().left - stickyEdge() - anchor.colOffset;
  else box.scrollLeft = anchor.left;
}

// ---- remember the view per tab across page loads and tab switches ----

const VIEW_KEY = THEME_KEY.replace(/-theme$/, '') + '-view';
type SavedView = Pick<ViewAnchor, 'rows' | 'col' | 'colOffset' | 'cols'>;
let savedViews: Record<string, SavedView> = {};
try {
  const stored = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
  if (stored && typeof stored === 'object') savedViews = stored;
} catch { /* unreadable storage: start from the top */ }
const settledViewTabs = new Set<string>();
let saveViewTimer: any = 0;

/**
 * A tab is restored once its rows exist (in the hub: once every feed is loaded, otherwise rows keep arriving above the saved one)
 * and their height has stopped changing for a few frames: right after the first render the CDN styles are not applied yet,
 * so positions measured then would be wrong.
 */
const restoringViewTabs = new Set<string>();

function applySavedView(): void {
  const tab = state.activeTab;
  if (!el.tableBody.querySelector('tr[data-key], tr[data-ticker]')) return;
  const first = !settledViewTabs.has(tab);
  if (!first && lastRenderedTab === tab) return;
  if (restoringViewTabs.has(tab)) return;
  const saved = savedViews[tab];
  if (!saved || !Array.isArray(saved.rows)) { settledViewTabs.add(tab); return; }
  restoringViewTabs.add(tab);
  let lastHeight = -1;
  let stable = 0;
  let frames = 0;
  const step = (): void => {
    if (state.activeTab !== tab) { restoringViewTabs.delete(tab); return; }
    const row: any = el.tableBody.querySelector('tr[data-key], tr[data-ticker]');
    const height = row ? row.getBoundingClientRect().height : -1;
    stable = height === lastHeight ? stable + 1 : 0;
    lastHeight = height;
    if (stable < 3 && ++frames < 120) { requestAnimationFrame(step); return; }
    restoringViewTabs.delete(tab);
    settledViewTabs.add(tab);
    restoreViewAnchor({ tab, top: 0, left: 0, cols: saved.cols, col: saved.col, colOffset: saved.colOffset, rows: saved.rows }, true);
  };
  requestAnimationFrame(step);
}

function saveView(): void {
  const tab = state.activeTab;
  if (!settledViewTabs.has(tab)) return;
  const anchor = captureViewAnchor();
  if (!anchor.rows.length) return;
  savedViews[tab] = { cols: anchor.cols, col: anchor.col, colOffset: anchor.colOffset, rows: anchor.rows.slice(0, 5) };
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(savedViews)); } catch { /* quota or private mode */ }
}

el.tableScroll.addEventListener('scroll', () => { clearTimeout(saveViewTimer); saveViewTimer = setTimeout(saveView, 250); }, { passive: true });
window.addEventListener('pagehide', saveView);

function currentQuery(): string {
  return state.queryByTab[state.activeTab] || '';
}

function setCurrentQuery(value: string): void {
  if (value) state.queryByTab[state.activeTab] = value;
  else delete state.queryByTab[state.activeTab];
  persistSearches();
}

/** Transition guard: stores the current input text under the tab being left. */
function saveActiveTabQuery(): void {
  const query = (el.searchInput.value || '').trim();
  if (query) state.queryByTab[state.activeTab] = query;
  else delete state.queryByTab[state.activeTab];
  persistSearches();
}

/** 1-click clear button visibility: shown iff the input has text. */
function updateSearchClearBtn(): void {
  el.searchClearBtn.classList.toggle('hidden', !el.searchInput.value);
}

function syncSearchInput(): void {
  const query = currentQuery();
  if (document.activeElement !== el.searchInput && el.searchInput.value !== query) {
    el.searchInput.value = query;
  }
  el.searchInput.placeholder = isEtfCatalogTab(state.activeTab)
    ? 'Search ETFs, fund names, holdings, tickers, CUSIPs/ISINs, SEDOLs...'
    : `Search ${tabLabel(state.activeTab)}...`;
  updateSearchClearBtn();
}

function filterRows(rows: any[]): any[] {
  const query = normalizeSearchText(currentQuery());
  if (!query) return rows;
  return rows.filter(row => String(row.searchIndex || '').includes(query));
}

function sortValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function compareValues(a: unknown, b: unknown): number {
  const an = numberOrNull(a);
  const bn = numberOrNull(b);
  if (an !== null && bn !== null) return an - bn;
  const as = String(a ?? '');
  const bs = String(b ?? '');
  // History dates ("Aug 21 2026") sort chronologically.
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(as) || /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(bs)) {
    const ad = Date.parse(as.replace(/-/g, ' '));
    const bd = Date.parse(bs.replace(/-/g, ' '));
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
  }
  return as.localeCompare(bs, undefined, { numeric: true });
}

function sortRows(rows: any[]): any[] {
  if (state.sortKey === 'rank') return rows;
  const direction = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key)) * direction);
}

// `extraClass` is opt-in and only used by the All ETFs catalog for its
// horizontally pinned columns (`Use` + `Ticker`). Every other call site
// (Watchlist, Overview, Distributions, generic sheet views) omits it and
// renders exactly as before. See the `catalog-sticky-*` rules in index.html.
function sortHeader(label: string, key: string, numeric = false, extraClass = ''): string {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const align = numeric ? ' text-right' : '';
  const tooltip = getHeaderTooltip(label);
  return `<th class="py-3.5 px-4${align}${extraClass ? ' ' + extraClass : ''}" title="${escapeHtml(tooltip)}"><div class="flex items-center gap-1.5${numeric ? ' justify-end' : ''}"><button data-sort="${escapeHtml(key)}" title="${escapeHtml(tooltip)}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:text-blue-600 dark:focus:text-blue-400">${escapeHtml(label)}${arrow}</button>${filterBadgeFor(key)}</div></th>`;
}

function indexHeader(): string {
  return `<th class="py-3.5 px-4 w-12 text-center" title="${escapeHtml(getHeaderTooltip('#'))}">#</th>`;
}

/**
 * The rows the catalog table actually renders: catalog tab + active search
 * filter + blacklist exclusion. This is the exact scope of the header Use
 * checkbox (checked state is `.every(...)` over these rows, never a
 * selection-size comparison).
 */
function visibleCatalogRows(): FundRow[] {
  return filteredCatalogFunds();
}

// Only the All ETFs catalog uses this header (single call site), so the
// horizontal pin is hard-coded here rather than parameterized.
function useHeader(): string {
  const rows = visibleCatalogRows();
  const allSelected = rows.length > 0 && rows.every(fund => state.selected.has(fund.ticker));
  return `<th class="catalog-sticky-col catalog-sticky-use py-3.5 px-4 w-20 text-center" title="${escapeHtml(getHeaderTooltip('Use'))}">
    <div class="inline-flex items-center justify-center gap-1">
      <input type="checkbox" id="select-all-checkbox" ${allSelected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" title="Select / Deselect all visible ETFs" />
      <span>Use</span>
    </div>
  </th>`;
}

function bindSortHeaders(): void {
  appendFilterRow();
  el.tableHead.querySelectorAll('button[data-sort]').forEach((button: any) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort || 'rank';
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else {
        state.sortKey = key;
        state.sortDir = ['ticker', 'name', 'category', 'symbol', 'section', 'metric', 'identifier', 'label'].includes(key) ? 'asc' : 'desc';
      }
      rememberSortForCurrentTab();
      render(false);
    });
  });
}

function bindSelectAllCheckbox(): void {
  const checkbox = el.tableHead.querySelector('#select-all-checkbox');
  if (!checkbox) return;
  checkbox.addEventListener('change', (event: any) => {
    event.stopPropagation();
    // Header Use checkbox: strictly the visible (filtered) catalog rows.
    toggleVisibleSelection(Boolean(event.target.checked));
  });
  checkbox.addEventListener('click', (event: any) => event.stopPropagation());
}

function renderFundsTable(): void {
  setCatalogColumnStyle(true);
  const rows = sortRows(filteredCatalogFunds());
  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${useHeader()}
      ${sortHeader('Ticker', 'ticker', false, 'catalog-sticky-col catalog-sticky-ticker')}
      ${sortHeader('Fund Name', 'name')}
      ${sortHeader('Type', 'category')}
      ${sortHeader('NAV', 'navValue', true)}
      ${sortHeader('Net Assets', 'aumValue', true)}
      ${sortHeader('Expense', 'terValue', true)}
      ${sortHeader('Dividend Yield', 'dividendYield', true)}
      ${sortHeader('SEC Yield', 'secYield', true)}
      ${sortHeader('Frequency', 'dividendFrequency')}
      ${sortHeader('YTD Return', 'ytd', true)}
      ${sortHeader('TR 1Y', 'yr1', true)}
      ${sortHeader('TR 3Y', 'tr3y', true)}
      ${sortHeader('TR 5Y', 'tr5y', true)}
      ${sortHeader('TR 10Y', 'tr10y', true)}
      ${sortHeader('CAGR 3Y', 'cagr3y', true)}
      ${sortHeader('CAGR 5Y', 'cagr5y', true)}
      ${sortHeader('CAGR 10Y', 'cagr10y', true)}
      ${sortHeader('SI Ann.', 'si', true)}
      ${sortHeader('Return As Of', 'returnAsOf')}
      ${sortHeader('Inception', 'inceptionDate')}
      ${sortHeader('Holdings', 'holdings', true)}
      ${sortHeader('History', 'history', true)}
      ${sortHeader('As Of', 'asOfDate')}
    </tr>
  `;
  bindSortHeaders();
  bindSelectAllCheckbox();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="25" class="py-12 text-center text-slate-400 dark:text-slate-500">No ETFs match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((fund, index) => {
      const selected = state.selected.has(fund.ticker);
      return `
        <tr data-ticker="${escapeHtml(fund.ticker)}" class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30 ${selected ? 'selected-row' : ''}">
          <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
          <td class="catalog-sticky-col catalog-sticky-use py-2.5 px-4 text-center">
            <div class="inline-flex items-center justify-center gap-1.5">
              <input data-checkbox="${escapeHtml(fund.ticker)}" type="checkbox" ${selected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" aria-label="Use ${escapeHtml(fund.ticker)}" />
              <button data-blacklist="${escapeHtml(fund.ticker)}" class="w-4 h-4 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 leading-none transition" title="Blacklist ${escapeHtml(fund.ticker)} — hide it from All ETFs">✕</button>
            </div>
          </td>
          <td class="catalog-sticky-col catalog-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(fund.ticker)}</td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(fund.name)}">${escapeHtml(fund.name)}</td>
          <td class="py-2.5 px-4 text-slate-600 dark:text-slate-300">${escapeHtml(categoryLabel(fund.category))}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.nav || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatMoney(fund.aumValue)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.ter || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.dividendYield)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.secYield)}</td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">${escapeHtml(fund.dividendFrequency || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.ytd)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.yr1)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr3y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr5y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr10y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr3y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr5y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr10y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.si)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.returnAsOf || '—')}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.inceptionDate || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.holdings)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.history)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.asOfDate || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  el.tableBody.querySelectorAll('input[data-checkbox]').forEach((checkbox: any) => {
    checkbox.addEventListener('change', (event: any) => {
      event.stopPropagation();
      const ticker = checkbox.dataset.checkbox || '';
      toggleFund(ticker);
    });
    checkbox.addEventListener('click', (event: any) => event.stopPropagation());
  });

  el.tableBody.querySelectorAll('button[data-blacklist]').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      blacklistTickers([button.dataset.blacklist || '']);
    });
  });

  const selected = state.selected.size;
  const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
  const activeText = state.activeFundTicker ? ` Active ETF detail tabs are for ${state.activeFundTicker}.` : '';
  setStatus(`Showing ${rows.length} ETF${rows.length === 1 ? '' : 's'}${queryText}. Use the checkboxes in the “Use” column to select ETFs.${selected ? ` ${selected} selected.` : ' No ETFs selected yet.'}${activeText}`, selected ? 'success' : 'info');
  el.tickerCount.textContent = `${rows.length} ETFs`;
  renderSubtitle();
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

type HoldingPosition = { fund: string; name: string; identifier: string; weight: number; cells: Record<string, unknown> };

const MISSING_TOKENS = new Set(['', '-', '--', '—', '–', 'N/A', 'NA', 'NONE', 'NULL']);

/**
 * Treats blank / dash / N/A-style placeholders as missing. All-zero CUSIPs
 * (published as `000000000` verbatim by some EDGAR N-PORT filings) also count
 * as missing, so identifier-less rows fall through to the name instead of
 * collapsing into one garbage key.
 */
function cleanKeyPart(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || MISSING_TOKENS.has(text.toUpperCase())) return '';
  if (/^0+$/.test(text)) return '';
  return text.toUpperCase();
}

/**
 * Documented dedupe key fallback order (docs/ui-contract.md §5):
 * Ticker -> CUSIP -> ISIN -> Identifier/Security ID -> SEDOL/FIGI -> Name.
 * Keys are namespaced (T:/C:/I:/D:/S:/N:) so identifier values can never
 * collide with tickers. Numeric local listing tickers (e.g. 005930) are
 * valid tickers, not placeholders. Rows are never aggressively dropped:
 * bonds without exchange tickers, cash positions, derivatives and zero-weight
 * holdings all resolve to a key (the name being the last resort).
 */
function positionDedupeKey(row: Record<string, unknown>): { key: string; shown: string } | null {
  const first = (...values: unknown[]): string => {
    for (const value of values) {
      const clean = cleanKeyPart(value);
      if (clean) return clean;
    }
    return '';
  };
  const ticker = first(row.Ticker, row.Symbol);
  if (ticker) return { key: `T:${ticker}`, shown: ticker };
  const cusip = first(row.CUSIP);
  if (cusip) return { key: `C:${cusip}`, shown: cusip };
  const isin = first(row.ISIN);
  if (isin) return { key: `I:${isin}`, shown: isin };
  const identifier = first(row.Identifier, row['Security ID']);
  if (identifier) return { key: `D:${identifier}`, shown: identifier };
  const sedol = first(row.SEDOL, row.FIGI);
  if (sedol) return { key: `S:${sedol}`, shown: sedol };
  const name = String(row.Name ?? row['Security Name'] ?? '').trim();
  if (name) return { key: `N:${name.toUpperCase()}`, shown: name };
  return null;
}

function sheetPositions(ticker: string): HoldingPosition[] {
  const entry = sheetState.get(`${ticker}:holdings`);
  if (!entry || !entry.headers.length) return [];
  return entry.rows.map(row => {
    // Holding rows carry the exchange ticker resolved at data-build time;
    // bond / private positions have no ticker ("-") and the key falls back
    // through the identifier chain to the published name.
    const cells: Record<string, unknown> = {};
    entry.headers.forEach((header, index) => {
      if (header) cells[header] = row[index] ?? '';
    });
    const weight = numberOrNull(cells.Weight);
    const rawIdentifier = String(cells.Identifier ?? '').trim();
    return {
      fund: ticker,
      name: String(cells.Name ?? '').trim(),
      identifier: cleanKeyPart(rawIdentifier) ? rawIdentifier : '',
      weight: weight === null ? 0 : weight,
      cells,
    };
  });
}

function getSelectedPositions(): HoldingPosition[] {
  return [...state.selected].flatMap(ticker => sheetPositions(ticker));
}

let watchlistCache: { signature: string; rows: WatchlistRow[] } | null = null;

function getDedupedWatchlistRows(): WatchlistRow[] {
  // Memoized: the aggregation is recomputed only when the selection or the
  // loaded row counts change (progressive streaming and tab label updates
  // otherwise re-render many times per second on large selections).
  const tickers = [...state.selected].sort();
  const signature =
    tickers.join('|') +
    '#' +
    tickers.map(ticker => (sheetState.get(`${ticker}:holdings`)?.rows.length ?? 0)).join(',');
  if (watchlistCache && watchlistCache.signature === signature) return watchlistCache.rows;

  const map: Map<string, WatchlistRow> = new Map();
  getSelectedPositions().forEach(position => {
    const resolved = positionDedupeKey(position.cells);
    if (!resolved) return;
    let row = map.get(resolved.key);
    if (!row) {
      row = {
        key: resolved.key,
        symbol: resolved.shown,
        name: position.name,
        funds: [],
        fundCount: 0,
        weightSum: 0,
        maxWeight: 0,
        cusips: [],
        identifier: '',
        searchIndex: '',
      };
      map.set(resolved.key, row);
    }
    if (!row.funds.includes(position.fund)) row.funds.push(position.fund);
    row.weightSum += position.weight;
    row.maxWeight = Math.max(row.maxWeight, position.weight);
    if (position.identifier && !row.cusips.includes(position.identifier)) row.cusips.push(position.identifier);
    if (position.name) row.name = position.name;
  });
  map.forEach(row => {
    row.fundCount = row.funds.length;
    row.funds.sort();
    row.cusips.sort();
    row.identifier = row.cusips[0] || '';
    row.searchIndex = [row.symbol, row.name, row.cusips.join(' '), row.funds.join(' ')].join(' ').toLowerCase();
  });
  const rows = [...map.values()];
  watchlistCache = { signature, rows };
  return rows;
}

function getVisibleWatchlistRows(): WatchlistRow[] {
  const base = getDedupedWatchlistRows();
  return sortRows(applyColumnFilters('watchlist', filterRows(base), WATCHLIST_FILTER_COLUMNS, base));
}

function watchlistChunkSignature(rows: WatchlistRow[]): string {
  return [state.sortKey, state.sortDir, currentQuery(), columnFilterSig('watchlist'), rows.length, rows.length ? rows[0].key : ''].join('|');
}

/** Scroll/click extension of the rendered Watchlist chunk (bounded DOM). */
function growWatchlistChunk(): void {
  const rows = getVisibleWatchlistRows();
  if (watchlistRenderedCount + WATCHLIST_CHUNK >= rows.length) return;
  watchlistRenderedCount += WATCHLIST_CHUNK;
  renderWatchlistTable();
}

function renderWatchlistTable(): void {
  const rows = getVisibleWatchlistRows();
  const signature = watchlistChunkSignature(rows);
  if (signature !== watchlistChunkSig) {
    watchlistChunkSig = signature;
    watchlistRenderedCount = 0;
  }
  // The complete filtered result drives the counts, Copy Tickers and both
  // exports; only the DOM is chunked. Scrolling grows the mounted slice.
  const visibleRows = rows.slice(0, watchlistRenderedCount + WATCHLIST_CHUNK);
  const hasMore = rows.length > visibleRows.length;
  const loading = state.selected.size > 0 && isHoldingsLoading();

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${sortHeader('Ticker', 'symbol', false, 'watchlist-sticky-col watchlist-sticky-ticker')}
      ${sortHeader('Name', 'name')}
      ${sortHeader('ETFs', 'funds')}
      ${sortHeader('# ETFs', 'fundCount', true)}
      ${sortHeader('Weight Sum', 'weightSum', true)}
      ${sortHeader('Max Weight', 'maxWeight', true)}
      ${sortHeader('Identifier', 'identifier')}
    </tr>
  `;
  bindSortHeaders();

  if (!state.selected.size) {
    el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">Select ETFs in All ETFs to build the aggregated Watchlist.</td></tr>`;
  } else if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">${
      loading
        ? `Loading holdings of ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'}…`
        : 'Holdings data is not available yet. Run bun ./scripts/update-data.ts to refresh the Themes ETFs feed.'
    }${currentQuery() ? ' No rows match your search.' : ''}</td></tr>`;
  } else {
    let html = visibleRows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="watchlist-sticky-col watchlist-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(row.symbol)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(row.name)}">${escapeHtml(row.name || '—')}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">
          <div class="flex flex-wrap gap-1 max-w-md">
            ${row.funds.map((ticker: string) => `<a href="javascript:void(0)" data-activate-fund="${escapeHtml(ticker)}" title="Open ${escapeHtml(ticker)} detail tabs" class="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800 rounded-full px-2 py-0.5 hover:underline">${escapeHtml(ticker)}</a>`).join('')}
          </div>
        </td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.fundCount}</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.weightSum.toFixed(3)}%</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.maxWeight.toFixed(3)}%</td>
        <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400 text-xs">${escapeHtml(row.identifier || '—')}</td>
      </tr>
    `).join('');
    if (loading) {
      html += `<tr><td colspan="8" class="py-3 text-center text-xs text-slate-400 dark:text-slate-500">Loading holdings of the remaining selected ETFs…</td></tr>`;
    }
    if (hasMore) {
      html += `<tr id="watchlist-more-row" class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition"><td colspan="8" class="py-3 text-center text-xs text-slate-400 dark:text-slate-500">Scroll or click to load more rows… (${rows.length - visibleRows.length} remaining)</td></tr>`;
    }
    el.tableBody.innerHTML = html;
  }

  el.tableBody.querySelectorAll('a[data-activate-fund]').forEach((link: any) => {
    link.addEventListener('click', (event: any) => {
      event.stopPropagation();
      activateFund(link.dataset.activateFund || '');
    });
  });
  const moreRow = el.tableBody.querySelector('#watchlist-more-row');
  if (moreRow) moreRow.addEventListener('click', () => growWatchlistChunk());

  const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
  setStatus(`Watchlist built from ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'}: ${rows.length} ticker${rows.length === 1 ? '' : 's'}${queryText}. Deduplicated by ticker, or by identifier for bond rows.`, 'success');
  el.tickerCount.textContent = `${rows.length} tickers`;
  renderSubtitle();
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function renderDetailTable(key: string): void {
  const activeFund = getActiveFund();
  if (!activeFund) {
    renderEmptyDetail('Select an ETF row to see ETF details.');
    return;
  }

  if (key === 'overview') return renderOverviewTable(activeFund);
  if (key === 'distributions') return renderDistributionsTable(activeFund);
  return renderSheetTable(activeFund, key === 'history' ? 'history' : 'holdings');
}

function renderEmptyDetail(message: string): void {
  el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Details</th></tr>`;
  el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(message)}</td></tr>`;
  el.tickerCount.textContent = activeDetailTickerText();
}

function activeDetailTickerText(): string {
  return state.activeFundTicker ? `${state.activeFundTicker}` : '0 ETFs';
}

function renderSheetTable(fund: FundRow, sheet: 'holdings' | 'history'): void {
  const catalogCount = sheet === 'holdings' ? fund.holdings : fund.history;
  const entry = sheetState.get(sheetKey(sheet));

  if (!catalogCount) {
    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">${escapeHtml(fund.ticker)}</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(fund.ticker)} publishes no ${sheet === 'holdings' ? 'holdings workbook' : 'NAV history workbook'} (catalog-only fund, e.g. a commodity trust).</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    renderSubtitle(`${fund.ticker} has no current static ${sheet} sheet; the feed records the provider coverage limitation in meta.json.`);
    return;
  }

  if (!entry) {
    // Immediate loading placeholder: the previous fund's table is never left
    // visible while the next fund loads.
    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Loading…</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">Loading ${escapeHtml(fund.ticker)} ${sheet}…</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    void loadFundMeta(fund.ticker).then(meta => {
      if (state.activeTab !== `detail:${sheet}` || state.activeFundTicker !== fund.ticker) return;
      if (!meta) {
        el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-rose-500">Could not load ${escapeHtml(fund.ticker)} data — meta.json is unavailable. Run bun ./scripts/update-data.ts to refresh the feed, then reload.</td></tr>`;
        return;
      }
      void ensureSheet(sheet, sheet === 'holdings' ? meta.holdings : meta.history).then(() => render());
    });
    return;
  }

  const headers = entry.headers;
  const rows = sortRows(sheetView(sheet, headers, entry.rows, NUMERIC_SHEET_HEADERS));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${headers.map((header, index) => sortHeader(header || `Col ${index + 1}`, `col${index}`, NUMERIC_SHEET_HEADERS.includes(header))).join('')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No rows match your search${entry.loading ? ' (still loading…)' : ''}.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => {
      const values: string[] = row.values || [];
      return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        ${values.map((cell, columnIndex) => `
          <td class="py-2.5 px-4 ${NUMERIC_SHEET_HEADERS.includes(headers[columnIndex]) ? 'text-right font-mono text-slate-700 dark:text-slate-300' : 'text-slate-700 dark:text-slate-300'}">${escapeHtml(cell === '' ? '—' : cell)}</td>
        `).join('')}
      </tr>
    `;}).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} ${sheet === 'holdings' ? 'Holdings' : 'NAV History'} — ${entry.rows.length.toLocaleString('en-US')} of ${(entry.manifest.totalRows || 0).toLocaleString('en-US')} rows loaded${entry.manifest.asOfDate ? ` (as of ${entry.manifest.asOfDate})` : ''}.`);
}

function renderOverviewTable(fund: FundRow): void {
  const meta = fundMetaCache.get(fund.ticker);
  const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
  const quarterEnd = (fund.returns && fund.returns.quarterEnd) || {};
  const overview: Array<{ section: string; metric: string; value: unknown }> = [
    { section: 'Fund', metric: 'Ticker', value: fund.ticker },
    { section: 'Fund', metric: 'Fund Name', value: fund.name },
    { section: 'Fund', metric: 'Category', value: categoryLabel(fund.category) },
    { section: 'Fund', metric: 'Inception', value: fund.inceptionDate },
    { section: 'Fund', metric: 'Primary Exchange', value: fund.exchange },
    { section: 'Fund', metric: 'Underlying Exposure', value: meta && meta.identifiers ? meta.identifiers.indexName : null },
    { section: 'Fund', metric: 'CUSIP', value: meta && meta.identifiers ? meta.identifiers.cusip : null },
    { section: 'Fund', metric: 'ISIN', value: meta && meta.identifiers ? meta.identifiers.isin : null },
    { section: 'Fund', metric: 'Fund Page', value: fund.fundPage },
    { section: 'Fund', metric: 'ETF Lineup Page', value: meta && meta.source ? meta.source.lineup : null },
    { section: 'Fund', metric: 'SEC Registrant', value: meta && meta.source ? meta.source.registrant : null },
    { section: 'Fund', metric: 'N-PORT Filing', value: meta && meta.source ? meta.source.nportDoc : null },
    { section: 'Documents', metric: 'Prospectus', value: meta && meta.documents ? meta.documents.prospectus : null },
    { section: 'Documents', metric: 'Summary Prospectus', value: meta && meta.documents ? meta.documents.summaryProspectus : null },
    { section: 'Documents', metric: 'Statement of Additional Information', value: meta && meta.documents ? meta.documents.sai : null },
    { section: 'Documents', metric: 'Annual Report', value: meta && meta.documents ? meta.documents.annualReport : null },
    { section: 'Documents', metric: 'Semi-Annual Report', value: meta && meta.documents ? meta.documents.semiAnnualReport : null },
    { section: 'Documents', metric: 'Fiscal Year Q1 Portfolio Holdings', value: meta && meta.documents ? meta.documents.fiscalQ1Holdings : null },
    { section: 'Documents', metric: 'Fiscal Year Q3 Portfolio Holdings', value: meta && meta.documents ? meta.documents.fiscalQ3Holdings : null },
    { section: 'Documents', metric: 'Supplemental Tax Information', value: meta && meta.documents ? meta.documents.taxInfo : null },
    { section: 'Documents', metric: 'Form 8937', value: meta && meta.documents ? meta.documents.form8937 : null },
    { section: 'Cost', metric: 'Total Annual Fund Operating Expenses', value: fund.ter },
    { section: 'Cost', metric: 'Management Fee', value: meta && meta.expenseRatio ? meta.expenseRatio.managementFeeDisplay : null },
    { section: 'Price', metric: 'NAV (Net Asset Value)', value: fund.nav },
    { section: 'Price', metric: 'Market Price', value: fund.closePrice },
    { section: 'Price', metric: 'Premium / Discount', value: fund.premiumDiscount },
    { section: 'Price', metric: 'NAV Daily Change', value: meta && meta.nav ? meta.nav.dailyChangeText : null },
    { section: 'Price', metric: 'Market Price Daily Change', value: meta && meta.marketPrice ? meta.marketPrice.dailyChangeText : null },
    { section: 'Price', metric: 'As Of', value: fund.asOfDate },
    { section: 'Assets', metric: 'Net Assets', value: formatMoney(fund.aumValue) },
    { section: 'Assets', metric: 'Net Assets (published)', value: fund.aum },
    { section: 'Assets', metric: 'Shares Outstanding', value: meta && meta.sharesOutstanding ? meta.sharesOutstanding.display : null },
    { section: 'Returns', metric: 'Return Basis', value: meta && meta.returns ? meta.returns.derivedFrom : null },
    { section: 'Returns', metric: 'Month-End As Of', value: monthEnd.asOfDate },
    { section: 'Returns', metric: 'YTD (ME)', value: formatPercent(monthEnd.ytd) },
    { section: 'Returns', metric: '1Y (ME)', value: formatPercent(monthEnd.yr1) },
    { section: 'Returns', metric: '3Y CAGR (ME)', value: formatPercent(monthEnd.yr3) },
    { section: 'Returns', metric: '5Y CAGR (ME)', value: formatPercent(monthEnd.yr5) },
    { section: 'Returns', metric: '10Y CAGR (ME)', value: formatPercent(monthEnd.yr10) },
    { section: 'Returns', metric: 'SI Ann. (ME)', value: formatPercent(monthEnd.sinceInception) },
    { section: 'Returns', metric: 'SI Cumulative (ME)', value: formatPercent(monthEnd.sinceInceptionCumulative) },
    { section: 'Returns', metric: 'Quarter-End As Of', value: quarterEnd.asOfDate },
    { section: 'Returns', metric: 'YTD (QE)', value: formatPercent(quarterEnd.ytd) },
    { section: 'Returns', metric: '1Y (QE)', value: formatPercent(quarterEnd.yr1) },
    { section: 'Returns', metric: '3Y CAGR (QE)', value: formatPercent(quarterEnd.yr3) },
    { section: 'Returns', metric: '5Y CAGR (QE)', value: formatPercent(quarterEnd.yr5) },
    { section: 'Returns', metric: '10Y CAGR (QE)', value: formatPercent(quarterEnd.yr10) },
    { section: 'Returns', metric: 'SI Ann. (QE)', value: formatPercent(quarterEnd.sinceInception) },
    { section: 'Distributions', metric: 'Frequency', value: fund.distributions ? fund.distributions.frequency : null },
    { section: 'Distributions', metric: 'Ex-Date', value: fund.distributions ? fund.distributions.exDate : null },
    { section: 'Distributions', metric: 'Latest Dividend', value: fund.distributions ? fund.distributions.dividend : null },
    { section: 'Distributions', metric: 'Distribution Rate', value: meta && meta.yields ? meta.yields.distributionRateText : null },
    { section: 'Distributions', metric: '12-Month Trailing Distribution Rate', value: meta && meta.yields ? meta.yields.yield12MText : null },
    { section: 'Distributions', metric: '30-Day SEC Yield', value: meta && meta.yields ? (meta.yields.secYieldText || '—') : (fund.secYield === null || fund.secYield === undefined ? 'not published on the official Themes ETFs fund page for this fund' : `${fund.secYield.toFixed(2)}%`) },
    { section: 'Distributions', metric: 'Distribution Rate Basis', value: meta && meta.yields ? meta.yields.dividendYieldKind : null },
    { section: 'Distributions', metric: 'SEC Yield Basis', value: meta && meta.yields ? meta.yields.secYieldKind : null },
    { section: 'Distributions', metric: 'Payments Per Year', value: meta && meta.distributions ? meta.distributions.paymentsPerYear : null },
    { section: 'Holdings', metric: 'Holdings Rows', value: fund.holdings },
    { section: 'Holdings', metric: 'Holdings As Of', value: meta && meta.holdings ? meta.holdings.asOfDate : null },
    { section: 'Holdings', metric: 'Holdings Source', value: meta && meta.source ? meta.source.holdingsSource : null },
    { section: 'Holdings', metric: 'History Rows', value: fund.history },
    { section: 'Holdings', metric: 'History As Of', value: meta && meta.history ? meta.history.asOfDate : null },
    { section: 'Holdings', metric: 'History Source', value: meta && meta.source ? meta.source.historySource : null },
    { section: 'Holdings', metric: 'Provider', value: meta && meta.source ? meta.source.provider : null },
  ];

  const rows = sortRows(filterRows(overview.map(item => ({
    section: item.section,
    metric: item.metric,
    value: item.value === null || item.value === undefined || item.value === '' ? '—' : item.value,
    searchIndex: `${item.section} ${item.metric} ${item.value}`.toLowerCase(),
  }))));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${sortHeader('Section', 'section')}
      ${sortHeader('Metric', 'metric')}
      ${sortHeader('Value', 'value')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="4" class="py-12 text-center text-slate-400 dark:text-slate-500">No overview metrics match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="py-2.5 px-4 text-slate-500 dark:text-slate-400">${escapeHtml(row.section)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(row.metric)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${
          /^https?:\/\//.test(String(row.value))
            ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${escapeHtml(row.value)}" target="_blank" rel="noopener noreferrer">open link</a>`
            : escapeHtml(row.value)
        }</td>
      </tr>
    `).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} overview · ${rows.length} metrics. Returns are derived from adjusted market-price closes, not official NAV returns.`);
}

function renderDistributionsTable(fund: FundRow): void {
  const meta = fundMetaCache.get(fund.ticker);
  const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
  const headers: string[] = Array.isArray(worksheet.headers) ? worksheet.headers : [];
  const sourceRows: string[][] = Array.isArray(worksheet.rows) ? worksheet.rows : [];
  const rows = sortRows(sheetView('distributions', headers, sourceRows, []));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${headers.map((header, index) => sortHeader(header, `col${index}`)).join('')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No published distribution for ${escapeHtml(fund.ticker)}.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => {
      const values: string[] = row.values || [];
      return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        ${values.map(cell => `<td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${escapeHtml(cell || '—')}</td>`).join('')}
      </tr>
    `;}).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} distributions · the rows are Yahoo Finance public chart dividend events (ex-dividend date and amount per share); a fund that has never distributed shows an explanatory state instead of a blank table.`);
}

// =========================================================================
// 7. Subtitle
// =========================================================================

function renderHeaderSummary(subtitle: HTMLElement, tickers: Iterable<string>, activeTicker: string | null, activate: (ticker: string) => void): void {
  const panel = document.getElementById('app-summary');
  if (!panel) return;
  // Move existing nodes: provenance links and their handlers remain intact.
  panel.replaceChildren(...Array.from(subtitle.childNodes));
  subtitle.replaceChildren();
  const selected = [...tickers].sort();
  if (!selected.length) return;
  subtitle.append(document.createTextNode(`${selected.length} selected: `));
  selected.forEach((ticker, index) => {
    if (index) subtitle.append(document.createTextNode(', '));
    const link = document.createElement('a');
    link.href = '#';
    link.dataset.headerFund = ticker;
    link.title = `View ${ticker} details`;
    link.className = `font-semibold ${ticker === activeTicker ? 'text-blue-700 dark:text-blue-300 underline' : 'text-blue-600 dark:text-blue-400 hover:underline'}`;
    link.textContent = ticker;
    link.addEventListener('click', event => { event.preventDefault(); activate(ticker); });
    subtitle.append(link);
  });
}

function renderSubtitleDetails(text?: string): void {
  const generated = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : '';
  const countsText = state.counts
    ? `${state.counts.funds} ETFs · ${(state.counts.holdings || 0).toLocaleString('en-US')} holdings rows · ${(state.counts.history || 0).toLocaleString('en-US')} history rows`
    : '';
  const base = text ? String(text) : 'Search Themes ETFs, select ETFs via the “Use” checkbox, then use the Watchlist tab.';
  // Selected ETF count and clickable ticker badges (active fund highlighted);
  // re-rendered by every selection writer so the count never lags.
  const selectedCount = state.selected.size;
  let selectionItem = '';
  if (selectedCount > 0) {
    const catalogFunds = state.funds.filter(fund => !state.blacklist.has(fund.ticker));
    if (catalogFunds.length > 0 && catalogFunds.length === selectedCount && catalogFunds.every(fund => state.selected.has(fund.ticker))) {
      selectionItem = ` · All ${catalogFunds.length} ETFs selected`;
    } else {
      const badges = [...state.selected].sort().map(ticker => {
        const isActive = ticker === state.activeFundTicker;
        return `<a href="javascript:void(0)" data-activate-fund="${escapeHtml(ticker)}" title="View ${escapeHtml(ticker)} details" class="font-semibold ${isActive ? 'text-blue-700 dark:text-blue-300 underline' : 'text-blue-600 dark:text-blue-400 hover:underline'}">${escapeHtml(ticker)}</a>`;
      }).join(', ');
      selectionItem = ` · ${selectedCount} selected: ${badges}`;
    }
  }
  el.subtitle.innerHTML = `
    <span class="block sm:inline">${escapeHtml(base)}${selectionItem}</span>
    <span class="block sm:inline">·${generated ? ` updated ${escapeHtml(generated)}` : ''}${countsText ? ` · ${escapeHtml(countsText)}.` : '.'} Data: <a href="./api/themes/index.json" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">api/themes/index.json</a> generated from <a href="https://themesetfs.com/etfs" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">the official Themes ETFs catalog and daily holdings downloads</a> + SEC EDGAR N-PORT-P (Themes ETF Trust, CIK 0001976322 — holdings fallback only) + Yahoo Finance (daily price history and dividend events)</span>
  `;
  el.subtitle.querySelectorAll('a[data-activate-fund]').forEach((link: any) => {
    link.addEventListener('click', () => activateFund(link.dataset.activateFund || ''));
  });
}

function renderSubtitle(text?: string): void {
  renderSubtitleDetails(text);
  renderHeaderSummary(el.subtitle, state.selected, state.activeFundTicker, activateFund);
}

function setStatusRow(message: string, tone: 'info' | 'error'): void {
  el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center ${tone === 'error' ? 'text-rose-500 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}">${escapeHtml(message)}</td></tr>`;
}

// =========================================================================
// 8. Selection & blacklist
// =========================================================================

/** Active fund fallback: if the active fund was deselected, fall back to the
 *  first remaining selected fund (or none). */
function updateActiveFundFallback(): void {
  // Bulk selection writers (the filtered header checkbox and the All ETFs
  // pill) can add the first selected fund without going through toggleFund.
  // Keep a selected fund active in that case too, otherwise the selected-tabs
  // panel renders as an empty shell until the next page reload restores the
  // fallback in loadCatalog().
  if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }
}

/** Shared trailer for every selection writer: keeps localStorage, tabs,
 *  subtitle badges, per-sheet counts and the Watchlist (visibility, loading
 *  state, count) in sync immediately — no extra click needed. */
function afterSelectionChange(): void {
  updateActiveFundFallback();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
}

/** Row Use checkbox (or row click): toggles exactly one ETF. */
function toggleFund(ticker: string): void {
  const cleanTicker = sanitizeTicker(ticker);
  if (!cleanTicker) return;

  if (state.selected.has(cleanTicker)) {
    state.selected.delete(cleanTicker);
  } else {
    state.selected.add(cleanTicker);
    state.activeFundTicker = cleanTicker;
  }

  afterSelectionChange();
  const activeTicker = state.activeFundTicker;
  if (activeTicker && state.activeTab.startsWith('detail:')) {
    void loadFundMeta(activeTicker).then(meta => {
      // Refresh per-sheet counts once the meta arrives (e.g. Distributions).
      if (meta && state.activeFundTicker === activeTicker && state.activeTab.startsWith('detail:')) render();
    });
  }
}

/** Header Use checkbox: scope is exactly the rows currently rendered by the
 *  catalog table (catalog + active search filter + blacklist exclusion).
 *  Checking selects all visible rows; unchecking deselects visible rows only
 *  (hidden selections survive). */
function toggleVisibleSelection(selectAll: boolean): void {
  visibleCatalogRows().forEach(fund => {
    if (selectAll) state.selected.add(fund.ticker);
    else state.selected.delete(fund.ticker);
  });
  afterSelectionChange();
}

/** All ETFs pill checkbox: scope is always every non-blacklisted ETF in the
 *  entire catalog, operating from any tab under any filter. Toggle-only — it
 *  never navigates away from the current view. */
function toggleAllCatalogEfts(selectAll: boolean): void {
  state.funds.filter(fund => !state.blacklist.has(fund.ticker)).forEach(fund => {
    if (selectAll) state.selected.add(fund.ticker);
    else state.selected.delete(fund.ticker);
  });
  afterSelectionChange();
}

/** Activates a selected fund from a clickable ticker badge (subtitle or
 *  Watchlist ETF badges) without changing the selection. */
function activateFund(ticker: string): void {
  const clean = sanitizeTicker(ticker);
  if (!clean || !state.selected.has(clean)) return;
  state.activeFundTicker = clean;
  persistSelection();
  if (state.activeTab.startsWith('detail:')) {
    resetSheetPaging();
    render();
    maybeLoadMoreRows();
  } else {
    render();
  }
}

function clearSelectionAndSearch(): void {
  state.selected.clear();
  state.activeFundTicker = null;
  state.queryByTab = {};
  state.activeTab = 'All';
  // Sort preferences survive Clear: a sort configured in the past is always
  // kept (per tab, in browser localStorage) and reused. Clear only resets
  // the selection and the searches — never the sort order.
  applySortForTab('All');
  persistSelection();
  localStorage.removeItem(ACTIVE_FUND_KEY);
  el.searchInput.value = '';
  updateSearchClearBtn();
  persistSearches();
  persistSiteState();
  render();
}

function blacklistTickers(rawTickers: string[]): void {
  const known = new Set(state.funds.map(fund => fund.ticker));
  rawTickers
    .flatMap(raw => String(raw || '').split(/[\s,;]+/))
    .map(sanitizeTicker)
    .filter(Boolean)
    .filter(ticker => known.has(ticker))
    .forEach(ticker => state.blacklist.add(ticker));
  state.selected = new Set([...state.selected].filter(ticker => !state.blacklist.has(ticker)));
  if (state.activeFundTicker && state.blacklist.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }
  persistBlacklist();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
}

function submitBlacklistInput(): void {
  blacklistTickers([el.blacklistInput.value || '']);
  el.blacklistInput.value = '';
  fitTableHeight();
}

function unblacklistTicker(ticker: string): void {
  state.blacklist.delete(sanitizeTicker(ticker));
  persistBlacklist();
  render();
}

function clearBlacklist(): void {
  state.blacklist.clear();
  persistBlacklist();
  render();
}

function renderBlacklistPanel(): void {
  el.blacklistChips.innerHTML = '';
  const tickers = [...state.blacklist].sort();
  tickers.forEach(ticker => {
    const chip = document.createElement('span');
    chip.className = 'inline-flex items-center gap-1.5 bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700/50 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium';
    chip.innerHTML = `${escapeHtml(ticker)}<button data-unblacklist="${escapeHtml(ticker)}" class="w-5 h-5 rounded-full hover:bg-rose-200 dark:hover:bg-rose-800 transition" title="Remove ${escapeHtml(ticker)} from blacklist">✕</button>`;
    el.blacklistChips.appendChild(chip);
  });
  el.blacklistEmpty.classList.toggle('hidden', tickers.length > 0);
  el.blacklistChips.querySelectorAll('button[data-unblacklist]').forEach((button: any) => {
    button.addEventListener('click', () => unblacklistTicker(button.dataset.unblacklist || ''));
  });
  syncBlacklistPanelHeight();
}

/**
 * The blacklist panel's max-height is content-driven (an unbounded number of
 * chips), unlike the fixed-height detail nav, so it can't use a static
 * max-height in CSS -- it's measured from scrollHeight instead, and
 * re-measured on every render so the panel resizes smoothly as chips are
 * added or removed while it's open.
 */
function syncBlacklistPanelHeight(): void {
  el.blacklistPanel.style.maxHeight = el.blacklistPanel.classList.contains('is-visible')
    ? `${el.blacklistPanel.scrollHeight}px`
    : '';
}

// =========================================================================
// 9. Actions & exports (CSV, TXT, Copy Tickers)
// =========================================================================

function currentExportRows(): { headers: string[]; rows: string[][]; scope: string } {
  if (state.activeTab === 'watchlist') {
    return {
      headers: ['Ticker', 'Name', 'ETFs', '# ETFs', 'Weight Sum (%)', 'Max Weight (%)', 'Identifiers'],
      rows: getVisibleWatchlistRows().map(row => [
        row.symbol,
        row.name,
        row.funds.join('|'),
        String(row.fundCount),
        row.weightSum.toFixed(6),
        row.maxWeight.toFixed(6),
        row.cusips.join('|'),
      ]),
      scope: 'watchlist',
    };
  }

  if (state.activeTab === 'detail:overview') {
    const fund = getActiveFund();
    const monthEnd = (fund && fund.returns && fund.returns.monthEnd) || {};
    const quarterEnd = (fund && fund.returns && fund.returns.quarterEnd) || {};
    return {
      headers: ['Ticker', 'Fund Name', 'Category', 'TER', 'NAV', 'Net Assets ($)', 'YTD (ME)', '1Y (ME)', '3Y (ME)', '5Y (ME)', '10Y (ME)', 'SI Ann. (ME)', 'ME As Of', '1Y (QE)', '3Y (QE)', 'Inception', 'Holdings', 'History'],
      rows: [[
        fund ? fund.ticker : '',
        fund ? fund.name : '',
        fund ? fund.category : '',
        fund ? fund.ter : '',
        fund ? fund.nav : '',
        fund ? numberCell(fund.aumValue) : '',
        numberCell(monthEnd.ytd),
        numberCell(monthEnd.yr1),
        numberCell(monthEnd.yr3),
        numberCell(monthEnd.yr5),
        numberCell(monthEnd.yr10),
        numberCell(monthEnd.sinceInception),
        monthEnd.asOfDate || '',
        numberCell(quarterEnd.yr1),
        numberCell(quarterEnd.yr3),
        fund ? fund.inceptionDate : '',
        fund ? String(fund.holdings) : '0',
        fund ? String(fund.history) : '0',
      ]],
      scope: fund ? `${fund.ticker}-overview` : 'overview',
    };
  }

  if (state.activeTab === 'detail:distributions') {
    const fund = getActiveFund();
    const meta = fund ? fundMetaCache.get(fund.ticker) : null;
    const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
    return {
      headers: worksheet.headers || [],
      rows: sheetView('distributions', worksheet.headers || [], worksheet.rows || [], []).map((row: any) => row.values),
      scope: fund ? `${fund.ticker}-distributions` : 'distributions',
    };
  }

  if (state.activeTab === 'detail:holdings' || state.activeTab === 'detail:history') {
    const sheet = state.activeTab === 'detail:history' ? 'history' : 'holdings';
    const fund = getActiveFund();
    const entry = fund ? sheetState.get(sheetKey(sheet)) : null;
    if (entry) {
      return {
        headers: entry.headers,
        rows: sheetView(sheet, entry.headers, entry.rows, NUMERIC_SHEET_HEADERS).map((row: any) => row.values),
        scope: fund ? `${fund.ticker}-${sheet}` : sheet,
      };
    }
    return { headers: [], rows: [], scope: sheet };
  }

  return {
    headers: ['Selected', 'Ticker', 'Fund Name', 'Type', 'NAV', 'Net Assets ($)', 'Expense (%)', 'Dividend Yield (%)', 'SEC Yield (%)', 'Frequency', 'YTD Return (%)', 'TR 1Y (%)', 'TR 3Y (%)', 'TR 5Y (%)', 'TR 10Y (%)', 'CAGR 3Y (%)', 'CAGR 5Y (%)', 'CAGR 10Y (%)', 'SI Ann. (%)', 'Return As Of', 'Inception', 'Holdings', 'History', 'As Of'],
    rows: filteredCatalogFunds().map(fund => [
      state.selected.has(fund.ticker) ? 'yes' : 'no',
      fund.ticker,
      fund.name,
      fund.category,
      fund.nav || '',
      numberCell(fund.aumValue),
      numberCell(fund.terValue),
      numberCell(fund.dividendYield),
      numberCell(fund.secYield),
      fund.dividendFrequency || '',
      numberCell(fund.ytd),
      numberCell(fund.yr1),
      numberCell(fund.tr3y),
      numberCell(fund.tr5y),
      numberCell(fund.tr10y),
      numberCell(fund.cagr3y),
      numberCell(fund.cagr5y),
      numberCell(fund.cagr10y),
      numberCell(fund.si),
      fund.returnAsOf || '',
      fund.inceptionDate || '',
      String(fund.holdings),
      String(fund.history),
      fund.asOfDate || '',
    ]),
    scope: 'etfs',
  };
}

function copyTickers(): void {
  let values: string[] = [];
  if (state.activeTab === 'watchlist') values = getVisibleWatchlistRows().map(row => row.symbol);
  else if (isDetailTab(state.activeTab)) values = currentExportRows().rows.map(row => String(row[0] ?? '')).filter(Boolean);
  else values = filteredCatalogFunds().map(fund => fund.ticker);
  values = values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!values.length) return;
  void copyText(values.join(', ')).then(() => {
    const oldText = el.copyBtn.textContent;
    el.copyBtn.textContent = 'Copied!';
    setTimeout(() => { el.copyBtn.textContent = oldText || 'Copy Tickers'; }, 1000);
  });
}

function exportCsv(): void {
  const exportData = currentExportRows();
  if (!exportData.rows.length) return;
  downloadText(
    toCsv([exportData.headers, ...exportData.rows.map(row => row.map(cell => String(cell ?? '')))]),
    exportFileName(exportData.scope, 'csv'),
    'text/csv;charset=utf-8;',
  );
}

function exportTxt(): void {
  const exportData = currentExportRows();
  if (!exportData.rows.length) return;
  downloadText(exportData.rows.map(row => row.join('\t')).join('\n'), exportFileName(exportData.scope, 'txt'), 'text/plain;charset=utf-8;');
}

// =========================================================================
// 10. Scroll fix: only the table scrolls (same fix as daggerok/iShares)
// =========================================================================

function fitTableHeight(): void {
  const rect = el.tableScroll.getBoundingClientRect();
  const bottomPad = window.innerWidth < 640 ? 12 : 24;
  const max = Math.max(240, window.innerHeight - rect.top - bottomPad);
  el.tableScroll.style.maxHeight = `${max}px`;
}

// =========================================================================
// 11. State persistence
// =========================================================================

function persistSelection(): void {
  localStorage.setItem(SELECTED_KEY, JSON.stringify([...state.selected]));
  if (state.activeFundTicker) localStorage.setItem(ACTIVE_FUND_KEY, state.activeFundTicker);
  else localStorage.removeItem(ACTIVE_FUND_KEY);
}

function persistBlacklist(): void {
  localStorage.setItem(BLACKLIST_KEY, JSON.stringify([...state.blacklist]));
}

function cleanFilterMap(source: Record<string, unknown>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [tab, query] of Object.entries(source)) {
    if (typeof query === 'string' && query.length > 0) clean[tab] = query;
  }
  return clean;
}

function persistSearches(): void {
  try {
    const clean = cleanFilterMap(state.queryByTab);
    if (Object.keys(clean).length > 0) {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(clean));
    } else {
      localStorage.removeItem(FILTERS_KEY);
    }
    localStorage.removeItem(LEGACY_FILTERS_KEY);
    persistSiteState();
  } catch {
    /* quota or private mode */
  }
}

function persistSiteState(): void {
  try {
    let saved: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(SITE_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
      }
    } catch {
      saved = {};
    }
    // sheetFilter mirrors the dedicated per-tab filter map so older sessions
    // can migrate without reintroducing a global search string.
    saved.sheetFilter = cleanFilterMap(state.queryByTab);
    saved.activeTab = state.activeTab;
    localStorage.setItem(SITE_STATE_KEY, JSON.stringify(saved));
  } catch {
    /* quota or private mode */
  }
}

function persistTabSorts(): void {
  localStorage.setItem(SORTS_KEY, JSON.stringify(state.sortByTab));
}

function restoreTabSorts(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SORTS_KEY) || '{}') || {};
    const sorts: Record<string, { key: string; dir: SortDirection }> = {};
    Object.keys(saved).forEach(tab => {
      const entry = saved[tab];
      // Keep only well-formed entries; stale keys from older schemas simply
      // sort a missing column (stable no-op) and never break rendering.
      if (entry && typeof entry.key === 'string' && entry.key !== '' && (entry.dir === 'asc' || entry.dir === 'desc')) {
        sorts[tab] = { key: entry.key, dir: entry.dir };
      }
    });
    state.sortByTab = sorts;
  } catch {
    state.sortByTab = {};
  }
}

function restoreSelectedEtfs(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]');
    state.selected = new Set((Array.isArray(saved) ? saved : []).map(sanitizeTicker).filter(Boolean));
    if (!state.selected.size && localStorage.getItem(SELECTED_KEY) === null) state.selected = new Set(DEFAULT_SELECTED_TICKERS);
  } catch {
    state.selected = new Set(DEFAULT_SELECTED_TICKERS);
  }
  const savedActive = sanitizeTicker(localStorage.getItem(ACTIVE_FUND_KEY) || '');
  state.activeFundTicker = savedActive && state.selected.has(savedActive) ? savedActive : ([...state.selected][0] || null);
}

function restoreBlacklist(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(BLACKLIST_KEY) || 'null');
    if (Array.isArray(saved)) state.blacklist = new Set(saved.map(sanitizeTicker));
  } catch {
    // Ignore malformed storage.
  }
}

/** Boot sanitization: only non-empty string values survive; malformed JSON
 *  or non-object payloads are dropped instead of crashing the app. */
function sanitizeFilterMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return cleanFilterMap(value as Record<string, unknown>);
}

function restoreSiteState(): { activeTab: string | null; sheetFilter: Record<string, string> } {
  let activeTab: string | null = null;
  let sheetFilter: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(SITE_STATE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (typeof saved.activeTab === 'string' && saved.activeTab) activeTab = saved.activeTab;
        sheetFilter = sanitizeFilterMap(saved.sheetFilter);
      }
    }
  } catch {
    /* corrupt storage: fall back to defaults */
  }
  return { activeTab, sheetFilter };
}

function restoreSearches(mirror: Record<string, string> = {}): void {
  // Priority (highest last): site-state sheetFilter mirror (oldest), the
  // legacy pre-rename key, then the dedicated per-tab filter key.
  const filters: Record<string, string> = { ...mirror };
  const ingest = (raw: string | null): void => {
    if (!raw) return;
    try {
      Object.assign(filters, sanitizeFilterMap(JSON.parse(raw)));
    } catch {
      /* corrupt entry: dropped */
    }
  };
  ingest(localStorage.getItem(LEGACY_FILTERS_KEY));
  ingest(localStorage.getItem(FILTERS_KEY));
  state.queryByTab = filters;
}

// =========================================================================
// 12. Bootstrap lifecycle
// =========================================================================

// =========================================================================
// 12. N-PORT upload (drag & drop, client-side parse; iShares dropzone twin)
// =========================================================================

/**
 * Parses a SEC Form N-PORT-P primary_doc.xml in the browser (DOMParser, no
 * network). Same normalization as the Bun updater, so uploaded holdings
 * merge into the Watchlist exactly like static-feed holdings.
 */
function parseNportUpload(text: string): { seriesName: string; repPdDate: string; headers: string[]; rows: string[][] } {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not a valid XML file');
  const headers = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
  const rows: string[][] = [];
  let seriesName = '';
  let repPdDate = '';
  const all = doc.getElementsByTagName('*');
  let inGenInfo = false;
  for (let i = 0; i < all.length; i++) {
    const node = all[i];
    const tag = node.localName || '';
    if (tag === 'genInfo') inGenInfo = true;
    if (inGenInfo && !seriesName && tag === 'seriesName') seriesName = (node.textContent || '').trim();
    if (inGenInfo && !repPdDate && tag === 'repPdDate') repPdDate = (node.textContent || '').trim();
    if (tag === 'invstOrSecs') inGenInfo = false;
    if (tag !== 'invstOrSec') continue;
    const pick = (parent: Element, name: string): string => {
      const children = parent.getElementsByTagName('*');
      for (let c = 0; c < children.length; c++) {
        if ((children[c].localName || '') === name) return (children[c].textContent || '').trim();
      }
      return '';
    };
    const name = pick(node, 'name') || pick(node, 'title') || '-';
    const cusip = pick(node, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      const ids = node.getElementsByTagName('*');
      for (let c = 0; c < ids.length; c++) {
        const value = ids[c].getAttribute && ids[c].getAttribute('value');
        if (value && ['isin', 'sedol', 'other', 'cusip'].includes(ids[c].localName || '')) {
          identifier = value;
          break;
        }
      }
    }
    let marketValue = pick(node, 'valUSD');
    let balance = pick(node, 'balance');
    rows.push([
      name,
      '-',
      identifier || '-',
      pick(node, 'pctVal') || '0',
      marketValue || '0',
      balance || '-',
      pick(node, 'assetCat') || '-',
    ]);
  }
  if (!rows.length && !seriesName) throw new Error('no genInfo/invstOrSec entries found (is this a Form N-PORT primary_doc.xml?)');
  return { seriesName, repPdDate, headers, rows };
}

const uploadedFunds = new Map(); // ticker -> { headers, rows }

function normalizeUploadName(value: string): string {
  return String(value || '')
    .toUpperCase()
    .replace(/REG/ig, '')
    .replace(/\u00ae/g, '')
    .replace(/\u2122/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(ETF|FUND|INDEX|THE)\b/g, '')
    .trim();
}

function setDropzoneState(stateName: 'loaded' | 'error' | null, text?: string): void {
  if (!dropzone || !dropzoneText) return;
  dropzone.classList.remove('dz-loaded', 'dz-error');
  if (stateName) dropzone.classList.add(stateName);
  if (text) dropzoneText.textContent = text;
}

function handleUploadedFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseNportUpload(String(reader.result || ''));
      const known = state.funds.find(fund => normalizeUploadName(fund.name) === normalizeUploadName(parsed.seriesName));
      let ticker = known ? known.ticker : '';
      if (!ticker) {
        const answer = window.prompt(`Ticker symbol for "${parsed.seriesName}" (as listed on EDGAR):`, '');
        ticker = sanitizeTicker(answer);
      }
      if (!ticker) {
        setDropzoneState('error', 'Upload cancelled');
        window.setTimeout(() => setDropzoneState(null, 'Upload / Drop N-PORT XML'), 1600);
        return;
      }
      uploadedFunds.set(ticker, { headers: parsed.headers, rows: parsed.rows });

      // Merge the uploaded fund into the catalog (override static holdings).
      const base = known || {
        ticker, name: parsed.seriesName || ticker, category: 'Uploaded', fundPage: null, dataFile: null,
        ter: '—', terValue: null, nav: '—', navValue: null, aum: '—', aumValue: null,
        asOfDate: parsed.repPdDate || '—', inceptionDate: '—', exchange: '', closePrice: '—', closePriceValue: null,
        premiumDiscount: '—', premiumDiscountValue: null,
        distributions: { frequency: '—', exDate: '—', dividend: '—' },
        returns: { monthEnd: null, quarterEnd: null },
      };
      const indexFund: any = {
        ...base,
        ticker,
        name: parsed.seriesName || (known ? known.name : ticker),
        category: known ? known.category : 'Uploaded',
        metrics: { dividendYield: null, secYield: null },
        holdings: parsed.rows.length,
        history: known ? known.history : 0,
      };
      const row = normalizeFundRow(indexFund);
      const existingIndex = state.funds.findIndex(fund => fund.ticker === ticker);
      if (existingIndex >= 0) state.funds[existingIndex] = row;
      else state.funds.push(row);
      state.funds.sort((a, b) => a.ticker.localeCompare(b.ticker));

      // Holdings live in memory: feed the sheet cache + a minimal meta so
      // detail tabs, lazy paging and Watchlist aggregation all work.
      sheetState.set(`${ticker}:holdings`, { headers: parsed.headers, rows: parsed.rows, nextPage: 1, manifest: { pages: [], pageSize: parsed.rows.length, totalRows: parsed.rows.length }, loading: false });
      fundMetaCache.set(ticker, {
        ...fundMetaCache.get(ticker),
        ticker,
        name: row.name,
        category: row.category,
        source: { fundPage: row.fundPage, edgarFiling: null, nportDoc: null, provider: 'uploaded N-PORT XML (session only)' },
        distributions: { frequency: known && known.distributions ? known.distributions.frequency : '—', headers: ['Ex-Date', 'Amount'], rows: [] },
        holdings: { pages: [], pageSize: parsed.rows.length, totalRows: parsed.rows.length, asOfDate: parsed.repPdDate || 'uploaded' },
        history: known && fundMetaCache.get(ticker) ? fundMetaCache.get(ticker).history : { pages: [], pageSize: 0, totalRows: 0, asOfDate: '—' },
        uploaded: true,
      });

      setDropzoneState('loaded', `${uploadedFunds.size} fund${uploadedFunds.size === 1 ? '' : 's'} uploaded`);
      setStatus(`Loaded ${ticker} (${parsed.seriesName || 'N-PORT'}): ${parsed.rows.length} holdings${parsed.repPdDate ? ` as of ${parsed.repPdDate}` : ''}. Uploads live for this session.`, 'info');
      fitTableHeight();
      render();
    } catch (error) {
      console.error('Failed to parse uploaded file:', error);
      setDropzoneState('error', 'Invalid N-PORT XML');
      window.setTimeout(() => setDropzoneState(null, 'Upload / Drop N-PORT XML'), 2200);
    }
  };
  reader.readAsText(file);
}

function bindEvents(): void {
  el.themeToggle.addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark);
  });

  el.searchInput.addEventListener('input', () => {
    setCurrentQuery(el.searchInput.value.trim());
    updateSearchClearBtn();
    render();
  });

  // 1-click clear: clears the active tab's filter from memory and storage,
  // clears the input, refocuses it and re-renders the current view.
  el.searchClearBtn.addEventListener('click', () => {
    el.searchInput.value = '';
    delete state.queryByTab[state.activeTab];
    persistSearches();
    updateSearchClearBtn();
    if (typeof el.searchInput.focus === 'function') el.searchInput.focus();
    render();
  });

  // N-PORT dropzone (iShares dropzone parity)
  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (event: Event) => {
      event.preventDefault();
      dropzone.classList.add('dz-active');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dz-active'));
    dropzone.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      dropzone.classList.remove('dz-active');
      if (event.dataTransfer && event.dataTransfer.files.length) handleUploadedFile(event.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (event: Event) => {
      const target: any = event.target;
      if (target && target.files && target.files.length) handleUploadedFile(target.files[0]);
    });
  }

  bindColumnFilterEvents();
  el.copyBtn.addEventListener('click', copyTickers);
  el.exportCsvBtn.addEventListener('click', exportCsv);
  el.exportTxtBtn.addEventListener('click', exportTxt);
  el.resetBtn.addEventListener('click', clearSelectionAndSearch);

  el.blacklistBtn.addEventListener('click', () => {
    const visible = el.blacklistPanel.classList.toggle('is-visible');
    el.blacklistBtn.setAttribute('aria-expanded', String(visible));
    renderBlacklistPanel();
    fitTableHeight();
  });
  el.blacklistAddBtn.addEventListener('click', submitBlacklistInput);
  el.blacklistInput.addEventListener('keydown', (event: any) => {
    if (event.key === 'Enter') submitBlacklistInput();
  });
  el.blacklistClearBtn.addEventListener('click', clearBlacklist);

  // Paginated sheets: append more rows as the sentinel scrolls into view.
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) maybeLoadMoreRows();
      },
      { root: el.tableScroll, rootMargin: '600px 0px' },
    );
    observer.observe(el.staticLoadSentinel);
  }
  el.staticLoadSentinel.addEventListener('click', () => maybeLoadMoreRows());
  el.tableScroll.addEventListener('scroll', () => {
    if (state.activeTab === 'watchlist') {
      // Chunked Watchlist: scrolling near the bottom extends the rendered
      // 250-row chunk; the full deduplicated set is never mounted at once.
      const distanceToBottom = el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight;
      if (distanceToBottom < 600) growWatchlistChunk();
      return;
    }
    const sheet = activeSheetTab();
    if (!sheet || !state.activeFundTicker) return;
    const entry = sheetState.get(sheetKey(sheet));
    if (!entry || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
    const distanceToBottom = el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight;
    if (distanceToBottom < 600) void loadNextSheetPage(sheet);
  }, { passive: true });

  // Keep only the table scrolling: refit on viewport changes and whenever
  // the content above the table (wrapping toolbar, panels) changes height.
  window.addEventListener('resize', fitTableHeight);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => fitTableHeight()).observe(document.body);
  }
}

function init(): void {
  restoreSelectedEtfs();
  restoreBlacklist();
  restoreColumnFilters();
  const siteState = restoreSiteState();
  if (siteState.activeTab) state.activeTab = siteState.activeTab;
  restoreSearches(siteState.sheetFilter);
  restoreTabSorts();
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
  bindEvents();
  syncSearchInput();
  fitTableHeight();
  renderSubtitle();
  void loadCatalog().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    el.tickerCount.textContent = 'Error';
    setStatusRow(`Unable to load api/themes/index.json: ${message}. Run bun ./scripts/update-data.ts and serve the folder (for example bunx serve . -p 1234).`, 'error');
  });
}
