'use client';

import type { ReactNode } from 'react';

export interface DataTableColumn<Row> {
  /** Stable column id, used as the React key for header and cells. */
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  readonly caption: string;
  readonly columns: ReadonlyArray<DataTableColumn<Row>>;
  readonly rows: ReadonlyArray<Row>;
  readonly rowKey: (row: Row) => string;
  readonly emptyMessage?: string;
}

/**
 * House table for read-only listings. Rendering stays declarative: pages
 * describe columns, never map over rows in JSX themselves.
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  emptyMessage = 'Nothing to show yet.',
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return <p className="db-table-empty">{emptyMessage}</p>;
  }
  return (
    <table className="db-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.id} scope="col">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.id}>{column.cell(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
