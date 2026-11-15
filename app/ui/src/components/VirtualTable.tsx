import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useVirtualRows } from "../hooks/useVirtualRows";

export type CellValue = string | number | null;

export interface Column {
  title: string;
  /** Numbers are right-aligned and sorted numerically. */
  numeric?: boolean;
  format?: (v: CellValue, row: number) => ReactNode;
}

/** Virtualized table, sortable by clicking a header; renders only the rows in view. */
export function VirtualTable({
  columns,
  rows,
  onRow,
  active,
  rowClass,
  resetKey,
}: {
  columns: Column[];
  rows: CellValue[][];
  onRow?: (index: number) => void;
  /** Index (in `rows`) of the highlighted row. */
  active?: number | null;
  rowClass?: (index: number) => string | undefined;
  /** Sorting and scrolling are reset when it changes. */
  resetKey?: unknown;
}) {
  const [sort, setSort] = useState<{ col: number; asc: boolean } | null>(null);
  const { box, onScroll, toTop, rowsInView } = useVirtualRows();
  useEffect(() => {
    setSort(null);
    toTop();
  }, [resetKey]);
  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (!sort) return idx;
    const c = sort.col;
    const num = (v: CellValue) => (typeof v === "number" ? v : v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    idx.sort((a, b) => {
      const x = rows[a][c];
      const y = rows[b][c];
      const nx = num(x);
      const ny = num(y);
      let d: number;
      if (nx !== null && ny !== null) d = nx - ny;
      else if (nx !== null) d = -1;
      else if (ny !== null) d = 1;
      else d = String(x ?? "").localeCompare(String(y ?? ""));
      return sort.asc ? d : -d;
    });
    return idx;
  }, [rows, sort]);
  const { first, last, before, after } = rowsInView(order.length);
  return (
    <div className="table-box" ref={box} onScroll={onScroll}>
      <table className="grid">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} onClick={() => setSort(sort?.col === i ? { col: i, asc: !sort.asc } : { col: i, asc: !c.numeric })} title="Sort">
                {c.title}
                {sort?.col === i ? (sort.asc ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: before }} />
          {order.slice(first, last).map((ri) => (
            <tr
              key={ri}
              className={[onRow ? "link-row" : "", active === ri ? "active-row" : "", rowClass?.(ri) ?? ""].join(" ")}
              onClick={() => onRow?.(ri)}
            >
              {columns.map((c, j) => {
                const v = rows[ri][j];
                return (
                  <td key={j} className={c.numeric ? "num" : undefined}>
                    {c.format ? c.format(v, ri) : (v ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr style={{ height: after }} />
        </tbody>
      </table>
    </div>
  );
}
