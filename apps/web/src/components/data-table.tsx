'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

/**
 * The table every list screen uses.
 *
 * Built once because the screens that existed each hand-rolled their own, and
 * none of them sorted, aligned numbers, or told you a column was sortable. In
 * an operator tool the table *is* the product — it is where the work is.
 */

export interface Column<T> {
  key: string;
  header: string;
  /** Right-aligned and tabular by default; numbers must line up to be scanned. */
  numeric?: boolean;
  width?: string;
  /** Return a comparable value; omit to make the column unsortable. */
  sortBy?: (row: T) => string | number | null | undefined;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Shown in place of the table when there are no rows. */
  empty?: ReactNode;
  /** Column key to sort by initially. */
  defaultSort?: string;
  defaultDirection?: 'asc' | 'desc';
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  defaultSort,
  defaultDirection = 'desc',
}: DataTableProps<T>) {
  const [sort, setSort] = useState<string | undefined>(defaultSort);
  const [direction, setDirection] = useState<'asc' | 'desc'>(defaultDirection);

  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sort);
    if (!column?.sortBy) return rows;
    const factor = direction === 'asc' ? 1 : -1;

    return [...rows].sort((left, right) => {
      const a = column.sortBy!(left);
      const b = column.sortBy!(right);
      // Missing values sort last in both directions: a blank is not "smallest",
      // it is absent, and burying it under a descending sort hides rows.
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor;
      return String(a).localeCompare(String(b)) * factor;
    });
  }, [rows, columns, sort, direction]);

  function toggle(column: Column<T>) {
    if (!column.sortBy) return;
    if (sort === column.key) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(column.key);
      setDirection('desc');
    }
  }

  if (!rows.length && empty) return <>{empty}</>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => {
              const active = sort === column.key;
              const sortable = Boolean(column.sortBy);
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={`px-3 py-2 font-medium text-text-muted ${
                    column.numeric ? 'text-right' : 'text-left'
                  }`}
                >
                  {sortable ? (
                    <button
                      onClick={() => toggle(column)}
                      className={`inline-flex items-center gap-1 transition-colors duration-fast hover:text-text ${
                        column.numeric ? 'flex-row-reverse' : ''
                      } ${active ? 'text-text' : ''}`}
                    >
                      {column.header}
                      {active ? (
                        direction === 'asc' ? (
                          <ArrowUp size={12} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={12} aria-hidden="true" />
                        )
                      ) : (
                        // Always present, so a sortable column looks sortable
                        // before the pointer reaches it.
                        <ChevronsUpDown size={12} aria-hidden="true" className="opacity-40" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={`border-b border-border/60 last:border-0 ${
                onRowClick
                  ? 'cursor-pointer transition-colors duration-fast hover:bg-surface-sunken focus:bg-surface-sunken focus:outline-none'
                  : ''
              }`}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-3 py-2 align-middle ${
                    // Tabular figures keep digits in a column the same width, so
                    // the eye can compare magnitudes down the column.
                    column.numeric ? 'text-right tabular-nums' : 'text-left'
                  }`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
