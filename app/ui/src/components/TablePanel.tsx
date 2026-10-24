import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { edit } from "../edit";
import { exportTable } from "../exporting";
import { notify, setState, useStore } from "../store";
import type { Grid, GridCell } from "../types";

const ROW_H = 22;

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

type Cell = { r: number; c: number };

/** Spreadsheet-like editor of one section: one row per line, one column per field. */
export function TablePanel() {
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const [section, setSection] = useState("CONDUITS");
  const [grid, setGrid] = useState<Grid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selOnly, setSelOnly] = useState(false);
  const [sort, setSort] = useState<{ col: number; asc: boolean } | null>(null);
  const [active, setActive] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const box = useRef<HTMLDivElement>(null);
  // Keyboard focus lives in a hidden text area: clipboard events always reach an
  // editable element (a focused div gets none when nothing is selected).
  const keys = useRef<HTMLTextAreaElement>(null);
  const focusKeys = () => {
    const k = keys.current;
    if (!k) return;
    k.focus({ preventScroll: true });
    k.select();
  };
  const revision = model?.revision ?? 0;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [grid !== null]);

  useEffect(() => {
    if (!model) return;
    const t = setTimeout(() => {
      api
        .grid(section)
        .then((g) => (setGrid(g), setError(null)))
        .catch((e) => setError(errorText(e)));
    }, 120);
    return () => clearTimeout(t);
  }, [section, revision, model?.path]);

  useEffect(() => {
    setActive(null);
    setAnchor(null);
    setEditing(null);
    setSort(null);
  }, [section]);

  // Rows shown: filtered (text, selection) and sorted.
  const view = useMemo(() => {
    if (!grid) return [];
    const f = filter.trim().toLowerCase();
    const sel = selOnly ? new Set(selection.filter((o) => o.kind === grid.object_kind).map((o) => o.index)) : null;
    let idx = grid.rows.map((_, i) => i);
    if (sel) idx = idx.filter((i) => grid.rows[i].object !== null && sel.has(grid.rows[i].object!));
    if (f) idx = idx.filter((i) => grid.rows[i].cells.some((c) => c !== null && c.toLowerCase().includes(f)));
    if (sort) {
      const c = sort.col;
      const key = (i: number) => grid.rows[i].cells[c] ?? "";
      const allNum = idx.every((i) => key(i) === "" || Number.isFinite(Number(key(i))));
      idx.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const d = allNum ? (x === "" ? Infinity : Number(x)) - (y === "" ? Infinity : Number(y)) || 0 : x.localeCompare(y, undefined, { numeric: true });
        return sort.asc ? d : -d;
      });
    }
    return idx;
  }, [grid, filter, selOnly, selection, sort]);

  const selected = useMemo(() => {
    if (!grid) return new Set<number>();
    return new Set(selection.filter((o) => o.kind === grid.object_kind).map((o) => o.index));
  }, [grid, selection]);

  if (!model) return <div className="panel-empty">Open a model first.</div>;

  const ncol = grid?.columns.length ?? 0;
  const inRange = (r: number, c: number) => {
    if (!active) return false;
    const a = anchor ?? active;
    return r >= Math.min(a.r, active.r) && r <= Math.max(a.r, active.r) && c >= Math.min(a.c, active.c) && c <= Math.max(a.c, active.c);
  };
  const rowOf = (r: number) => grid!.rows[view[r]];
  const scrollTo = (r: number) => {
    const el = box.current;
    if (!el) return;
    const top = (r + 1) * ROW_H;
    if (top < el.scrollTop + ROW_H) el.scrollTop = top - ROW_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };
  const move = (dr: number, dc: number, extend: boolean) => {
    if (!active) return;
    const next = { r: Math.max(0, Math.min(view.length - 1, active.r + dr)), c: Math.max(0, Math.min(ncol - 1, active.c + dc)) };
    if (!extend) setAnchor(null);
    else if (!anchor) setAnchor(active);
    setActive(next);
    scrollTo(next.r);
  };
  /** Edits cells; the table shows the new values at once (the reload that follows confirms them). */
  const setCells = async (cells: GridCell[]) => {
    if (!grid) return;
    const o = await edit({ op: "set_cells", section: grid.section, cells });
    if (!o) return;
    const col = new Map(grid.columns.map((c, i) => [c.key, i]));
    const byKey = new Map<string, GridCell[]>();
    for (const c of cells) {
      const k = c.key.join(" ").toUpperCase();
      byKey.set(k, [...(byKey.get(k) ?? []), c]);
    }
    setGrid((g) => {
      if (!g || g.section !== grid.section) return g;
      const rows = g.rows.map((r) => {
        const mine = byKey.get(r.key.join(" ").toUpperCase());
        if (!mine) return r;
        const out = [...r.cells];
        for (const c of mine) {
          const i = col.get(c.field);
          if (i !== undefined && out[i] !== null) out[i] = c.value;
        }
        return { ...r, cells: out };
      });
      return { ...g, rows };
    });
  };
  const commit = async (value: string, then?: () => void) => {
    setEditing(null);
    if (!grid || !active) return;
    const row = rowOf(active.r);
    const col = grid.columns[active.c];
    if (row.cells[active.c] === null || row.cells[active.c] === value) return then?.();
    await setCells([{ key: row.key, field: col.key, value }]);
    then?.();
    focusKeys();
  };
  // Clipboard events (Ctrl+C / Ctrl+V on the focused table) need no permission, unlike
  // navigator.clipboard, which WebView2 does not grant.
  const onCopy = (e: React.ClipboardEvent) => {
    if (!grid || !active || editing !== null) return;
    e.preventDefault();
    const a = anchor ?? active;
    const lines: string[] = [];
    for (let r = Math.min(a.r, active.r); r <= Math.max(a.r, active.r); r++) {
      const cells: string[] = [];
      for (let c = Math.min(a.c, active.c); c <= Math.max(a.c, active.c); c++) cells.push(rowOf(r).cells[c] ?? "");
      lines.push(cells.join("\t"));
    }
    e.clipboardData.setData("text/plain", lines.join("\r\n"));
    notify(`Copied ${lines.length} row(s)`);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing !== null) return;
    e.preventDefault();
    paste(e.clipboardData.getData("text/plain"));
  };
  const paste = async (text: string) => {
    if (!grid || !active || !text) return;
    const data = text.replace(/\r?\n$/, "").split(/\r?\n/).map((l) => l.split("\t"));
    const cells: GridCell[] = [];
    let skipped = 0;
    data.forEach((line, i) =>
      line.forEach((v, j) => {
        const r = active.r + i;
        const c = active.c + j;
        if (r >= view.length || c >= ncol) return void skipped++;
        const row = rowOf(r);
        if (c === 0 || row.cells[c] === null) return void skipped++;
        if (row.cells[c] !== v.trim()) cells.push({ key: row.key, field: grid.columns[c].key, value: v.trim() });
      }),
    );
    if (cells.length === 0) return notify(skipped ? `Nothing pasted: ${skipped} cell(s) cannot be edited here` : "Nothing changed");
    await setCells(cells);
    if (skipped) notify(`${skipped} cell(s) skipped (names, fields that do not apply, outside the table)`);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    // Keys stay in the table (arrows would move the timeline, Delete delete objects),
    // except undo, redo and save.
    if (!(ctrl && ["z", "y", "s"].includes(k.toLowerCase()))) e.stopPropagation();
    if (editing !== null || !active) return;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
    if (moves[k]) {
      e.preventDefault();
      return move(moves[k][0], moves[k][1], e.shiftKey && k !== "Tab");
    }
    if (k === "PageDown" || k === "PageUp") {
      e.preventDefault();
      return move((k === "PageDown" ? 1 : -1) * Math.floor(height / ROW_H), 0, e.shiftKey);
    }
    const editable = active.c > 0 && rowOf(active.r)?.cells[active.c] !== null;
    if ((k === "Enter" || k === "F2") && editable) {
      e.preventDefault();
      return setEditing(rowOf(active.r).cells[active.c] ?? "");
    }
    if (k.length === 1 && !ctrl && !e.altKey && editable) {
      e.preventDefault();
      setEditing(k);
    }
  };
  const clickCell = (r: number, c: number, e: React.MouseEvent) => {
    // Clicks in the cell being edited go to its input.
    if (editing !== null && active?.r === r && active?.c === c) return;
    // No default focus change: the keyboard target takes the focus now.
    e.preventDefault();
    if (e.shiftKey && active) {
      focusKeys();
      if (!anchor) setAnchor(active);
      setActive({ r, c });
      return;
    }
    focusKeys();
    setAnchor(null);
    setActive({ r, c });
    const obj = rowOf(r).object;
    if (c === 0 && obj !== null && grid) setState({ selection: [{ kind: grid.object_kind, index: obj }] });
  };
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 10);
  const last = Math.min(view.length, first + Math.ceil(height / ROW_H) + 20);
  const doExport = () =>
    grid &&
    exportTable(
      section.toLowerCase(),
      section,
      grid.columns.map((c) => (c.unit ? `${c.name} (${c.unit})` : c.name)),
      view.map((i) => grid.rows[i].cells),
    );
  const choices = active && grid && "options" in grid.columns[active.c] ? (grid.columns[active.c] as { options: string[] }).options : null;
  return (
    <div className="table-panel">
      <div className="panel-toolbar">
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          {GRID_SECTIONS.map(([s, t]) => (
            <option key={s} value={s}>
              {t}
            </option>
          ))}
        </select>
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          <input type="checkbox" checked={selOnly} onChange={(e) => setSelOnly(e.target.checked)} /> selected objects only
        </label>
        {grid && (
          <span className="muted">
            {view.length} / {grid.rows.length} rows
          </span>
        )}
        <span className="grow" />
        <span className="muted">Enter edits · Ctrl+C / Ctrl+V copy and paste with Excel · Shift+click selects a range</span>
        <button disabled={!grid} onClick={doExport}>
          Export
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {grid && (
        <div
          className="table-box grid-editor"
          ref={box}
          onKeyDown={onKey}
          onCopy={onCopy}
          onPaste={onPaste}
          onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}
        >
          <textarea ref={keys} className="grid-keys" value=" " onChange={() => {}} aria-label="Table keyboard" />
          <table className="grid">
            <thead>
              <tr>
                {grid.columns.map((c, i) => (
                  <th key={c.key} title={`${c.key}${c.unit ? ` (${c.unit})` : ""} – click to sort`} onClick={() => setSort(sort?.col === i ? { col: i, asc: !sort.asc } : { col: i, asc: true })}>
                    {c.name}
                    {c.unit && <span className="muted"> {c.unit}</span>}
                    {sort?.col === i ? (sort.asc ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ height: first * ROW_H }} />
              {view.slice(first, last).map((ri, k) => {
                const r = first + k;
                const row = grid.rows[ri];
                return (
                  <tr key={ri} className={row.object !== null && selected.has(row.object) ? "selected-row" : undefined}>
                    {row.cells.map((v, c) => {
                      const isActive = active?.r === r && active?.c === c;
                      const cls = [v === null ? "na" : "", inRange(r, c) ? "in-range" : "", isActive ? "active-cell" : "", c === 0 ? "id-cell" : ""].join(" ");
                      return (
                        <td key={c} className={cls} onMouseDown={(e) => clickCell(r, c, e)} onDoubleClick={() => c > 0 && v !== null && setEditing(v)}>
                          {isActive && editing !== null ? (
                            <input
                              autoFocus
                              className="cell-input"
                              list={choices ? "grid-choices" : undefined}
                              value={editing}
                              onChange={(e) => setEditing(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") commit(editing, () => move(1, 0, false));
                                else if (e.key === "Tab") (e.preventDefault(), commit(editing, () => move(0, e.shiftKey ? -1 : 1, false)));
                                else if (e.key === "Escape") (setEditing(null), focusKeys());
                              }}
                              onBlur={() => editing !== null && commit(editing)}
                            />
                          ) : (
                            (v ?? "")
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr style={{ height: (view.length - last) * ROW_H }} />
            </tbody>
          </table>
          {choices && (
            <datalist id="grid-choices">
              {choices.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          )}
        </div>
      )}
      {!grid && !error && <div className="panel-empty">Loading…</div>}
      {grid && grid.rows.length === 0 && <div className="panel-empty">No line in [{section}].</div>}
    </div>
  );
}
