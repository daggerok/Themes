/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const app = readFileSync(join(root, 'app.tsx'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

describe('Themes sibling-parity source substitutions', () => {
  test('uses only the Themes static API paths and local-storage namespace', () => {
    expect(app).toContain("const INDEX_URL = './api/themes/index.json';");
    expect(app).toContain("const THEME_KEY = 'themes-theme';");
    expect(app).toContain('`./api/themes/funds/${encodeURIComponent(ticker)}/meta.json`');
    expect(html).toContain('href="./api/themes/index.json"');
    expect(`${app}\n${html}`).not.toMatch(/api\/neos|neosfunds\.com|neos-/i);
  });

  test('retains Themes official, SEC, and Yahoo provenance links in the rich panel', () => {
    expect(app).toContain('https://themesetfs.com/etfs');
    expect(app).toContain('Themes ETF Trust, CIK 0001976322 — holdings fallback only');
    expect(app).toContain('Yahoo Finance (daily price history and dividend events)');
    expect(html).toContain('https://themesetfs.com/etfs');
    expect(html).toContain('Themes ETF Trust holdings from EDGAR, CIK 0001976322');
  });

  test('keeps the shared None and Unknown frequency display behavior', () => {
    const functionBody = app.match(/function formatDividendFrequency\(value: unknown\): string \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(functionBody).toContain("return '00 - None';");
    expect(functionBody).toContain("return '00 - Unknown';");
    expect(functionBody).toContain("return '01 - Monthly';");
  });
});

describe('shared header presentation regression guard', () => {
  test('renders no visible summary for zero selections and alphabetic clickable ticker links otherwise', () => {
    const headerBody = app.match(/function renderHeaderSummary\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(headerBody).toContain('const selected = [...tickers].sort();');
    expect(headerBody).toContain('if (!selected.length) return;');
    expect(headerBody).toContain('link.dataset.headerFund = ticker;');
    expect(headerBody).toContain('ticker === activeTicker');
    expect(headerBody).toContain("event.preventDefault(); activate(ticker);");
  });

  test('retains the rich source panel and its pointer, keyboard, touch, and narrow-screen affordances', () => {
    expect(html).toContain('id="app-summary" role="region"');
    expect(html).toContain('aria-controls="app-summary"');
    expect(html).toContain('width: min(42rem, calc(100vw - 2rem))');
    expect(html).toContain("trigger.addEventListener('pointerenter'");
    expect(html).toContain("event.pointerType !== 'touch'");
    expect(html).toContain("panel.addEventListener('pointerenter'");
    expect(html).toContain("trigger.addEventListener('click'");
    expect(html).toContain("event.key !== 'Escape'");
    expect(html).toContain("addEventListener('resize'");
  });

  test('keeps selection exclusively on the Use checkboxes rather than row clicks', () => {
    expect(app).toContain('data-checkbox="${escapeHtml(fund.ticker)}"');
    expect(app).toContain("el.tableBody.querySelectorAll('input[data-checkbox]')");
    expect(app).not.toContain("tr.addEventListener('click', () => toggleFund");
  });
});
