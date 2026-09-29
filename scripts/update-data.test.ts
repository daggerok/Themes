/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
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
