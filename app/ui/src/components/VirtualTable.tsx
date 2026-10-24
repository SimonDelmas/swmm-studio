import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const ROW_H = 22;

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
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setSort(null);
    setScroll(0);
    if (box.current) box.current.scrollTop = 0;
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
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 10);
  const last = Math.min(order.length, first + Math.ceil(height / ROW_H) + 20);
  return (
    <div className="table-box" ref={box} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
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
          <tr style={{ height: first * ROW_H }} />
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
          <tr style={{ height: (order.length - last) * ROW_H }} />
        </tbody>
      </table>
    </div>
  );
}
