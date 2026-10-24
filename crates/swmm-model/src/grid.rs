//! Tabular views of a section (one row per line, one column per field) and the edits
//! they make: many cells in one transaction (paste from a spreadsheet), and the raw
//! text of a section.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use swmm_inp::{InpFile, Line, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::schema::{self, Context, FieldType};
use crate::{Network, ObjKind};

/// Sections offered in the tabular editor, with the kind of object their lines describe.
pub const GRID_SECTIONS: &[(SectionKind, ObjKind)] = &[
    (SectionKind::Junctions, ObjKind::Node),
    (SectionKind::Outfalls, ObjKind::Node),
    (SectionKind::Dividers, ObjKind::Node),
    (SectionKind::Storage, ObjKind::Node),
    (SectionKind::Conduits, ObjKind::Link),
    (SectionKind::Pumps, ObjKind::Link),
    (SectionKind::Orifices, ObjKind::Link),
    (SectionKind::Weirs, ObjKind::Link),
    (SectionKind::Outlets, ObjKind::Link),
    (SectionKind::Xsections, ObjKind::Link),
    (SectionKind::Losses, ObjKind::Link),
    (SectionKind::Subcatchments, ObjKind::Subcatchment),
    (SectionKind::Subareas, ObjKind::Subcatchment),
    (SectionKind::Infiltration, ObjKind::Subcatchment),
    (SectionKind::Raingages, ObjKind::Gage),
    (SectionKind::Inflows, ObjKind::Node),
    (SectionKind::Dwf, ObjKind::Node),
    (SectionKind::Rdii, ObjKind::Node),
    (SectionKind::Coordinates, ObjKind::Node),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GridColumn {
    pub key: String,
    pub name: String,
    pub unit: String,
    #[serde(flatten)]
    pub ty: FieldType,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GridRow {
    /// Tokens identifying the line (object ID, plus the constituent for inflows).
    pub key: Vec<String>,
    /// One cell per column; `None` where the field does not apply to this line.
    pub cells: Vec<Option<String>>,
    /// Network object of the line.
    pub object: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Grid {
    pub section: String,
    pub object_kind: ObjKind,
    pub columns: Vec<GridColumn>,
    pub rows: Vec<GridRow>,
}

fn body<'a>(kind: &SectionKind, t: &'a [&'a str]) -> &'a [&'a str] {
    // The trailing infiltration method of SWMM 5.2 is not a field of the layout.
    if *kind == SectionKind::Infiltration
        && t.len() > 1
        && t.last().is_some_and(|s| schema::INFILTRATION_METHODS.iter().any(|m| m.eq_ignore_ascii_case(s)))
    {
        &t[..t.len() - 1]
    } else {
        t
    }
}

/// Rows of a section, with the union of the field layouts of its lines as columns.
pub fn grid(inp: &InpFile, net: &Network, kind: &SectionKind) -> Option<Grid> {
    let object_kind = GRID_SECTIONS.iter().find(|(k, _)| k == kind)?.1;
    let ctx = Context::of(inp);
    let flow = inp.flow_units();
    let klen = schema::key_len(kind);
    let mut columns: Vec<GridColumn> = Vec::new();
    let mut seen: HashSet<Vec<&'static str>> = HashSet::new();
    let mut add = |defs: &[schema::FieldDef], columns: &mut Vec<GridColumn>| {
        if !seen.insert(defs.iter().map(|d| d.key).collect()) {
            return;
        }
        // A new field goes right after the column of the field before it.
        let mut prev: Option<usize> = None;
        for d in defs {
            let c = match columns.iter().position(|c| c.key == d.key) {
                Some(c) => c,
                None => {
                    let at = prev.map_or(columns.len(), |p| p + 1);
                    let unit = d.unit.label(flow).to_string();
                    columns.insert(
                        at,
                        GridColumn { key: d.key.to_string(), name: d.name.to_string(), unit, ty: d.ty.clone() },
                    );
                    at
                }
            };
            prev = Some(c);
        }
    };
    add(&schema::layout(kind, &[""], &ctx)?, &mut columns);
    for l in inp.rows(kind) {
        let t: Vec<&str> = l.tokens().collect();
        if let Some(defs) = schema::layout(kind, &t, &ctx) {
            add(&defs, &mut columns);
        }
    }
    let col: HashMap<&str, usize> = columns.iter().enumerate().map(|(i, c)| (c.key.as_str(), i)).collect();
    let mut rows = Vec::new();
    for l in inp.rows(kind) {
        let t: Vec<&str> = l.tokens().collect();
        let Some(defs) = schema::layout(kind, &t, &ctx) else { continue };
        let b = body(kind, &t);
        let mut cells = vec![None; columns.len()];
        for (i, d) in defs.iter().enumerate() {
            cells[col[d.key]] = Some(b.get(i).map_or(String::new(), |s| s.to_string()));
        }
        let object = t.first().and_then(|id| net.find(object_kind, id));
        rows.push(GridRow { key: t.iter().take(klen).map(|s| s.to_string()).collect(), cells, object });
    }
    Some(Grid { section: kind.name().to_string(), object_kind, columns, rows })
}

/// One cell to set: the line (by its key tokens) and the field (by its key).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Cell {
    pub key: Vec<String>,
    pub field: String,
    pub value: String,
}

/// Sets many cells of a section in one transaction. Fails (and nothing changes) at the
/// first invalid value. Returns how many lines changed.
pub fn set_cells(tx: &mut Tx, kind: &SectionKind, cells: &[Cell]) -> EditResult<usize> {
    let klen = schema::key_len(kind);
    let mut index: HashMap<Vec<String>, (usize, usize)> = HashMap::new();
    for (si, s) in tx.inp().sections().iter().enumerate().filter(|(_, s)| s.kind() == kind) {
        for (li, l) in s.data() {
            let k: Vec<String> = l.tokens().take(klen).map(|t| t.to_ascii_uppercase()).collect();
            index.entry(k).or_insert((si, li));
        }
    }
    let ctx = Context::of(tx.inp());
    let mut n = 0;
    for c in cells {
        let k: Vec<String> = c.key.iter().map(|t| t.to_ascii_uppercase()).collect();
        let &at = index.get(&k).ok_or_else(|| format!("no line {} in [{}]", c.key.join(" "), kind.name()))?;
        let line = tx.inp().sections()[at.0].lines()[at.1].clone();
        let t: Vec<&str> = line.tokens().collect();
        let defs = schema::layout(kind, &t, &ctx).ok_or_else(|| format!("[{}] cannot be edited here", kind.name()))?;
        let Some(field) = defs.iter().position(|d| d.key == c.field) else {
            return Err(format!("{}: no field {} on this line", c.key.join(" "), c.field));
        };
        if field == 0 {
            return Err("names are changed with Rename".into());
        }
        let before = line.text().to_string();
        crate::ops::set_field_at(tx, kind, at, field, &c.value).map_err(|e| format!("{}: {e}", c.key.join(" ")))?;
        n += (tx.inp().sections()[at.0].lines()[at.1].text() != before) as usize;
    }
    Ok(n)
}

/// Text of the lines of the first section of a kind (without its header), as written.
pub fn section_text(inp: &InpFile, kind: &SectionKind) -> Option<String> {
    let s = inp.sections().iter().find(|s| s.kind() == kind)?;
    let mut out = String::new();
    for l in s.lines() {
        out.push_str(l.text());
        out.push('\n');
    }
    Some(out)
}

/// Replaces the lines of the first section of a kind (created if missing) with `text`;
/// only the lines that differ are spliced, so unchanged lines keep their bytes.
pub fn set_section_text(tx: &mut Tx, kind: &SectionKind, text: &str) -> EditResult<()> {
    let ending = tx.inp().line_ending();
    let free = kind.is_free_text();
    let mut new: Vec<Line> =
        text.split('\n').map(|s| s.strip_suffix('\r').unwrap_or(s)).map(|s| Line::from_text(s, ending, free)).collect();
    if text.ends_with('\n') || text.is_empty() {
        new.pop();
    }
    if let Some(bad) = new.iter().find(|l| l.kind() == swmm_inp::LineKind::Header) {
        return Err(format!("a section header cannot be added here: {}", bad.text().trim()));
    }
    let s = tx.ensure_section(kind);
    let old = tx.inp().sections()[s].lines();
    // Keep the original line endings of unchanged lines (compared by text).
    let same = |a: &Line, b: &Line| a.text() == b.text();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| same(a, b)).count();
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = old.iter().rev().zip(new.iter().rev()).take(max_suffix).take_while(|(a, b)| same(a, b)).count();
    let remove = old.len() - prefix - suffix;
    let insert: Vec<Line> = new.drain(prefix..new.len() - suffix).collect();
    // The section's last line keeps a terminator so the next header stays on its own line.
    let last_old_ending = old.last().map(|l| l.ending());
    tx.splice(s, prefix, remove, insert);
    if let (Some(e), Some(last)) = (last_old_ending, tx.inp().sections()[s].lines().last().cloned()) {
        if last.ending() != e && suffix == 0 {
            let mut l = last;
            l.set_ending(e);
            let at = tx.inp().sections()[s].lines().len() - 1;
            tx.replace_line(s, at, l);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::History;

    const SRC: &str = "\
[OPTIONS]
FLOW_UNITS LPS
[OUTFALLS]
;;name elev type
O1 97 FIXED 98.2 NO
O2 96 FREE NO
[INFLOWS]
J1 FLOW TS1 FLOW 1 1
J1 TSS TS2 CONCEN 1 1
[JUNCTIONS]
J1 100 2.5
[POLLUTANTS]
TSS MG/L 0 0 0 0 0 NO * 0 0
";

    #[test]
    fn grid_columns_and_rows() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let g = grid(&inp, &net, &SectionKind::Outfalls).unwrap();
        let names: Vec<&str> = g.columns.iter().map(|c| c.key.as_str()).collect();
        // The fixed stage column sits between the type and the flap gate.
        assert_eq!(names, ["id", "elev", "type", "stage", "gated", "route"]);
        assert_eq!(g.rows[0].cells[3].as_deref(), Some("98.2"));
        assert_eq!(g.rows[1].cells[3], None);
        assert_eq!(g.rows[1].cells[4].as_deref(), Some("NO"));
        assert_eq!(g.rows[1].object, Some(2));
        let f = grid(&inp, &net, &SectionKind::Inflows).unwrap();
        assert_eq!(f.rows[1].key, ["J1", "TSS"]);
        assert!(grid(&inp, &net, &SectionKind::Pollutants).is_none());
    }

    #[test]
    fn cells_and_text() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let cells = [
            Cell { key: vec!["o2".into()], field: "elev".into(), value: "95.5".into() },
            Cell { key: vec!["O1".into()], field: "stage".into(), value: "99".into() },
            Cell { key: vec!["J1".into(), "TSS".into()], field: "sfactor".into(), value: "2".into() },
        ];
        h.edit(&mut inp, "c", |tx| {
            set_cells(tx, &SectionKind::Outfalls, &cells[..2])?;
            set_cells(tx, &SectionKind::Inflows, &cells[2..])
        })
        .unwrap();
        let text = inp.to_string_lossy();
        assert!(
            text.contains("O2 95.5 FREE NO")
                && text.contains("O1 97 FIXED 99 NO")
                && text.contains("J1 TSS TS2 CONCEN 1 2"),
            "{text}"
        );
        let bad = [Cell { key: vec!["O2".into()], field: "elev".into(), value: "x".into() }];
        assert!(h.edit(&mut inp, "c", |tx| set_cells(tx, &SectionKind::Outfalls, &bad)).is_err());
        let bad = [Cell { key: vec!["O2".into()], field: "stage".into(), value: "1".into() }];
        assert!(h.edit(&mut inp, "c", |tx| set_cells(tx, &SectionKind::Outfalls, &bad)).is_err());
        // Raw text: unchanged text is a no-op, an edit splices only the changed line.
        let t = section_text(&inp, &SectionKind::Pollutants).unwrap();
        assert_eq!(t, "TSS MG/L 0 0 0 0 0 NO * 0 0\n");
        let a = h.edit(&mut inp, "t", |tx| set_section_text(tx, &SectionKind::Pollutants, &t)).unwrap();
        assert!(a.changes.is_empty());
        h.edit(&mut inp, "t", |tx| {
            set_section_text(tx, &SectionKind::Pollutants, "TSS MG/L 1 0 0 0 0 NO * 0 0\r\nBOD MG/L 0\n")
        })
        .unwrap();
        assert!(inp.to_string_lossy().ends_with("TSS MG/L 1 0 0 0 0 NO * 0 0\nBOD MG/L 0\n"));
        assert!(h.edit(&mut inp, "t", |tx| set_section_text(tx, &SectionKind::Pollutants, "[JUNCTIONS]\n")).is_err());
        h.undo(&mut inp);
        h.undo(&mut inp);
        h.undo(&mut inp);
        assert_eq!(inp.to_string_lossy(), SRC);
    }
}
