// The data side of the section table: which rows are shown, and what copying, pasting
// and editing cells mean for a grid. No React here.

import type { Grid } from "../../analysisTypes";
import type { GridCell } from "../../types";

export const GRID_SECTIONS: [string, string][] = [
  ["JUNCTIONS", "Junctions"],
  ["OUTFALLS", "Outfalls"],
  ["DIVIDERS", "Dividers"],
  ["STORAGE", "Storage units"],
  ["CONDUITS", "Conduits"],
  ["PUMPS", "Pumps"],
  ["ORIFICES", "Orifices"],
  ["WEIRS", "Weirs"],
  ["OUTLETS", "Outlets"],
  ["XSECTIONS", "Cross-sections"],
  ["LOSSES", "Losses"],
  ["SUBCATCHMENTS", "Subcatchments"],
  ["SUBAREAS", "Subareas"],
  ["INFILTRATION", "Infiltration"],
  ["RAINGAGES", "Rain gages"],
  ["INFLOWS", "Direct inflows"],
  ["DWF", "Dry weather flows"],
  ["RDII", "RDII"],
  ["COORDINATES", "Node coordinates"],
];

/** A cell of the table as shown: row in the shown rows, column. */
export type Cell = { r: number; c: number };

export type Sort = { col: number; asc: boolean };

/**
 * Indices of the rows shown, in order: those of the objects in `only` (when given) that
 * contain the filter text, sorted by a column (as numbers when the column holds numbers).
 */
export function rowsShown(grid: Grid, filter: string, only: Set<number> | null, sort: Sort | null): number[] {
  const f = filter.trim().toLowerCase();
  let idx = grid.rows.map((_, i) => i);
  if (only) idx = idx.filter((i) => grid.rows[i].object !== null && only.has(grid.rows[i].object!));
  if (f) idx = idx.filter((i) => grid.rows[i].cells.some((c) => c !== null && c.toLowerCase().includes(f)));
  if (sort) {
    const key = (i: number) => grid.rows[i].cells[sort.col] ?? "";
    const allNum = idx.every((i) => key(i) === "" || Number.isFinite(Number(key(i))));
    idx.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const d = allNum ? (x === "" ? Infinity : Number(x)) - (y === "" ? Infinity : Number(y)) || 0 : x.localeCompare(y, undefined, { numeric: true });
      return sort.asc ? d : -d;
    });
  }
  return idx;
}

/** The grid with new values in some cells (cells that do not apply to their row stay empty). */
export function withCells(grid: Grid, cells: GridCell[]): Grid {
  const col = new Map(grid.columns.map((c, i) => [c.key, i]));
  const rowKey = (key: string[]) => key.join(" ").toUpperCase();
  const byRow = new Map<string, GridCell[]>();
  for (const c of cells) byRow.set(rowKey(c.key), [...(byRow.get(rowKey(c.key)) ?? []), c]);
  const rows = grid.rows.map((r) => {
    const mine = byRow.get(rowKey(r.key));
    if (!mine) return r;
    const out = [...r.cells];
    for (const c of mine) {
      const i = col.get(c.field);
      if (i !== undefined && out[i] !== null) out[i] = c.value;
    }
    return { ...r, cells: out };
  });
  return { ...grid, rows };
}

/** The cells between two corners as lines of tab-separated values, as spreadsheets exchange them. */
export function rangeLines(grid: Grid, shown: number[], a: Cell, b: Cell): string[] {
  const lines: string[] = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    const cells: string[] = [];
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) cells.push(grid.rows[shown[r]].cells[c] ?? "");
    lines.push(cells.join("\t"));
  }
  return lines;
}

/**
 * The edits that pasting tab-separated text at a cell makes, and how many pasted values
 * have no cell to go to (names, fields that do not apply to the row, outside the table).
 */
export function pastedCells(grid: Grid, shown: number[], at: Cell, text: string): { cells: GridCell[]; skipped: number } {
  const data = text.replace(/\r?\n$/, "").split(/\r?\n/).map((l) => l.split("\t"));
  const cells: GridCell[] = [];
  let skipped = 0;
  data.forEach((line, i) =>
    line.forEach((v, j) => {
      const r = at.r + i;
      const c = at.c + j;
      if (r >= shown.length || c >= grid.columns.length) return void skipped++;
      const row = grid.rows[shown[r]];
      if (c === 0 || row.cells[c] === null) return void skipped++;
      // Numbers copied from a spreadsheet set to a decimal comma.
      const column = grid.columns[c];
      const value = column.type === "real" ? v.trim().replace(",", ".") : v.trim();
      if (row.cells[c] !== value) cells.push({ key: row.key, field: column.key, value });
    }),
  );
  return { cells, skipped };
}
