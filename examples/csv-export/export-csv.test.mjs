import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportCsv } from './export-csv.mjs';

const HEADER = 'id,name,status,region\r\n';

function sampleRecords() {
  return [
    { id: '1', name: 'Ada', status: 'active', region: 'eu', internalNotes: 'secret-a' },
    { id: '2', name: 'Bob', status: 'inactive', region: 'us', internalNotes: 'secret-b' },
    { id: '3', name: 'Cy', status: 'active', region: 'us', internalNotes: 'secret-c' },
    { id: '4', name: 'Di', status: 'active', region: 'eu', internalNotes: 'secret-d' },
    { id: '5', name: 'Ed', status: 'inactive', region: 'eu', internalNotes: 'secret-e' },
  ];
}

function ids(csv) {
  return csv
    .split('\r\n')
    .slice(1, -1)
    .map((line) => line.split(',')[0]);
}

// C1: filtering, no-filter, AND, input order

test('C1: no filters (default argument) includes all records in input order', () => {
  assert.deepEqual(ids(exportCsv(sampleRecords())), ['1', '2', '3', '4', '5']);
});

test('C1: empty filters object includes all records in input order', () => {
  assert.deepEqual(ids(exportCsv(sampleRecords(), {})), ['1', '2', '3', '4', '5']);
});

test('C1: status filter matches exactly and keeps input order', () => {
  assert.deepEqual(ids(exportCsv(sampleRecords(), { status: 'active' })), ['1', '3', '4']);
  assert.deepEqual(ids(exportCsv(sampleRecords(), { status: 'activ' })), []);
  assert.deepEqual(ids(exportCsv(sampleRecords(), { status: 'Active' })), []);
});

test('C1: region filter matches exactly and keeps input order', () => {
  assert.deepEqual(ids(exportCsv(sampleRecords(), { region: 'eu' })), ['1', '4', '5']);
});

test('C1: combined status and region filters use AND', () => {
  assert.deepEqual(
    ids(exportCsv(sampleRecords(), { status: 'active', region: 'eu' })),
    ['1', '4'],
  );
  assert.deepEqual(
    ids(exportCsv(sampleRecords(), { status: 'inactive', region: 'us' })),
    ['2'],
  );
});

test('C1: input order is retained even when not sorted by id', () => {
  const records = [
    { id: 'z', name: 'Zed', status: 'active', region: 'eu', internalNotes: '' },
    { id: 'a', name: 'Al', status: 'active', region: 'eu', internalNotes: '' },
    { id: 'm', name: 'Mo', status: 'active', region: 'eu', internalNotes: '' },
  ];
  assert.deepEqual(ids(exportCsv(records, { status: 'active', region: 'eu' })), ['z', 'a', 'm']);
});

// C2: explicit safe column projection

test('C2: header is exactly id,name,status,region', () => {
  assert.ok(exportCsv(sampleRecords()).startsWith(HEADER));
});

test('C2: internalNotes and extra fields never appear in output', () => {
  const records = [
    {
      region: 'eu',
      internalNotes: 'TOP-SECRET, do not export',
      extra: 'EXTRA-FIELD',
      status: 'active',
      name: 'Ada',
      id: '1',
      password: 'hunter2',
    },
  ];
  const csv = exportCsv(records);
  assert.equal(csv, HEADER + '1,Ada,active,eu\r\n');
  assert.ok(!csv.includes('TOP-SECRET'));
  assert.ok(!csv.includes('internalNotes'));
  assert.ok(!csv.includes('EXTRA-FIELD'));
  assert.ok(!csv.includes('hunter2'));
});

test('C2: each row has the four fields in header order', () => {
  const csv = exportCsv(sampleRecords(), { status: 'active', region: 'us' });
  assert.equal(csv, HEADER + '3,Cy,active,us\r\n');
});

// C3: CSV escaping and CRLF

test('C3: comma delimiter and CRLF after every record including the last', () => {
  const csv = exportCsv(sampleRecords(), { region: 'us' });
  assert.equal(csv, HEADER + '2,Bob,inactive,us\r\n3,Cy,active,us\r\n');
  assert.ok(csv.endsWith('\r\n'));
});

test('C3: cells with comma, quote, CR, or LF are quoted with quotes doubled', () => {
  const records = [
    { id: '1', name: 'Smith, Jane', status: 'active', region: 'eu', internalNotes: 'x' },
    { id: '2', name: 'Robert "Bobby" Tables', status: 'active', region: 'eu', internalNotes: 'x' },
    { id: '3', name: 'Line one\nLine two', status: 'active', region: 'eu', internalNotes: 'x' },
    { id: '4', name: 'Old Mac\rline', status: 'active', region: 'eu', internalNotes: 'x' },
    { id: '5', name: 'Windows\r\nline', status: 'active', region: 'eu', internalNotes: 'x' },
    { id: '6', name: '"Acme, Inc."\r\nDept "R&D"', status: 'active', region: 'eu', internalNotes: 'x' },
    { id: '7', name: 'Plain Name', status: 'active', region: 'eu', internalNotes: 'x' },
  ];
  const csv = exportCsv(records);
  assert.equal(
    csv,
    HEADER +
      '1,"Smith, Jane",active,eu\r\n' +
      '2,"Robert ""Bobby"" Tables",active,eu\r\n' +
      '3,"Line one\nLine two",active,eu\r\n' +
      '4,"Old Mac\rline",active,eu\r\n' +
      '5,"Windows\r\nline",active,eu\r\n' +
      '6,"""Acme, Inc.""\r\nDept ""R&D""",active,eu\r\n' +
      '7,Plain Name,active,eu\r\n',
  );
});

test('C3: escaping applies to every column together with combined filters', () => {
  const records = [
    { id: 'a,1', name: 'Q"uote', status: 'on, hold', region: 'north\nwest', internalNotes: 'n' },
    { id: 'b', name: 'Skip', status: 'on, hold', region: 'south', internalNotes: 'n' },
    { id: 'c', name: 'Skip', status: 'active', region: 'north\nwest', internalNotes: 'n' },
  ];
  const csv = exportCsv(records, { status: 'on, hold', region: 'north\nwest' });
  assert.equal(csv, HEADER + '"a,1","Q""uote","on, hold","north\nwest"\r\n');
});

// C4: empty results

test('C4: empty input returns only the header plus CRLF', () => {
  assert.equal(exportCsv([]), HEADER);
  assert.equal(exportCsv([], { status: 'active', region: 'eu' }), HEADER);
});

test('C4: filters matching nothing return only the header plus CRLF', () => {
  assert.equal(exportCsv(sampleRecords(), { status: 'archived' }), HEADER);
  assert.equal(exportCsv(sampleRecords(), { status: 'inactive', region: 'apac' }), HEADER);
});

// C5: non-mutation

test('C5: records array, record objects, and filters are not mutated', () => {
  const records = [
    ...sampleRecords(),
    { id: '6', name: 'Quote "Q", Inc.\r\n', status: 'active', region: 'eu', internalNotes: 'n,"x"' },
  ];
  const filters = { status: 'active', region: 'eu' };
  const recordsBefore = structuredClone(records);
  const filtersBefore = structuredClone(filters);
  const recordRefs = [...records];

  exportCsv(records, filters);

  assert.deepEqual(records, recordsBefore);
  assert.deepEqual(filters, filtersBefore);
  assert.equal(records.length, recordRefs.length);
  records.forEach((record, i) => assert.equal(record, recordRefs[i]));
});

test('C5: works with deeply frozen inputs (no writes attempted)', () => {
  const records = Object.freeze(sampleRecords().map((record) => Object.freeze(record)));
  const filters = Object.freeze({ status: 'active' });
  assert.doesNotThrow(() => exportCsv(records, filters));
  assert.deepEqual(ids(exportCsv(records, filters)), ['1', '3', '4']);
});

// C6: README

test('C6: README has an exportCsv usage example and the formula-injection limitation', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(readme, /import \{ exportCsv \} from '\.\/export-csv\.mjs'/);
  assert.match(readme, /exportCsv\(/);
  assert.match(readme, /formula\s+injection/i);
  assert.match(readme, /not\s+neutralized/i);
  assert.match(readme, /not\s+safe\s+to\s+open\s+as\s+an\s+untrusted\s+spreadsheet/i);
});
