/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data.ts';

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
  expect(readConfig(resolveControls({ MAX_RETRIES: 0 })).maxRetries).toBe(0);
});

test('scheduled path (empty inputs and advanced) equals config defaults', () => {
  const defaults = file();
  const scheduled = resolveControls(defaults, JSON.parse('{}'), {}, {});
  expect(scheduled).toEqual(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])));
});

test('resolver rejects invalid JSON shapes, unknown keys, non-scalars and newlines', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['BOTT'] }, { TICKERS: {} }, null, []]) {
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
  expect(config.secUserAgent).toBe('');
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
