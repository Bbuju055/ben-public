# Synthetic CSV export fixture

A local Node.js ES module that exports filtered records as CSV. No real
records, dependencies, external services, or remote repository.

`exportCsv(records, filters = {})` returns a CSV string with the header
`id,name,status,region`. Only those four columns are exported; `internalNotes`
and any other record fields are never included. Optional `status` and `region`
filters match exactly and combine with AND; omitted filters include all
records. Input order is kept and inputs are not mutated. Cells containing a
comma, quote, CR, or LF are quoted (embedded quotes doubled), and every line,
including the last, ends with CRLF. With no matches, the output is just the
header line.

## Usage

```js
import { exportCsv } from './export-csv.mjs';

const records = [
  { id: '1', name: 'Smith, Jane', status: 'active', region: 'eu', internalNotes: 'private' },
  { id: '2', name: 'Bob', status: 'inactive', region: 'us', internalNotes: 'private' },
];

exportCsv(records, { status: 'active', region: 'eu' });
// 'id,name,status,region\r\n1,"Smith, Jane",active,eu\r\n'
```

## Tests

```sh
node --test export-csv.test.mjs
```

## Limitation: formula injection

Spreadsheet formula injection is not neutralized. Cells beginning with `=`,
`+`, `-`, `@`, etc. are written unchanged, so the output is not safe to open
as an untrusted spreadsheet. Invalid input handling, streaming, and file
output are also out of scope.
