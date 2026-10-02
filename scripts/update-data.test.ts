/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CONTROL_NAMES,
  calculateReturn,
  createRequestGate,
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
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['BOTT'] }, { TICKERS: {} }, null, []]) {
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
  expect(viaAdvanced.sort()).toEqual(['HISTORY_RANGE', 'SEC_UA', 'SEC_YIELD', 'VERBOSE']);
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
});
