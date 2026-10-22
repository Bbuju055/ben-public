// Export filtered records to CSV. Only the columns listed in COLUMNS are ever
// emitted; internalNotes and any other record fields are never read.
// Note: spreadsheet formula injection is NOT neutralized (see README.md).

const COLUMNS = ['id', 'name', 'status', 'region'];

const NEEDS_QUOTING = /[",\r\n]/;

function escapeCell(value) {
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toLine(cells) {
  return cells.map(escapeCell).join(',') + '\r\n';
}

export function exportCsv(records, filters = {}) {
  const { status, region } = filters;
  const matching = records.filter(
    (record) =>
      (status === undefined || record.status === status) &&
      (region === undefined || record.region === region),
  );

  let csv = toLine(COLUMNS);
  for (const record of matching) {
    csv += toLine(COLUMNS.map((column) => record[column]));
  }
  return csv;
}
