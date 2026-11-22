//! Named data objects edited as a whole: curves, time series, time patterns, unit
//! hydrographs (RDII), transects, aquifers and snow packs. Values are kept as text so that untouched numbers
//! are written back as they were.

use std::collections::HashSet;

use swmm_inp::{InpFile, Line, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::refs;
use crate::schema::RefKind;

mod transect;

use transect::{fix_next_roughness, parse_transects, write_transect};

mod types;
mod validate;

pub use types::*;
pub use validate::validate;

/// Section holding a kind of table.
pub fn section_of(kind: RefKind) -> Option<SectionKind> {
    Some(match kind {
        RefKind::Curve => SectionKind::Curves,
        RefKind::Timeseries => SectionKind::Timeseries,
        RefKind::Pattern => SectionKind::Patterns,
        RefKind::Hydrograph => SectionKind::Hydrographs,
        RefKind::Transect => SectionKind::Transects,
        RefKind::Aquifer => SectionKind::Aquifers,
        RefKind::Snowpack => SectionKind::Snowpacks,
        _ => return None,
    })
}

fn is_number(s: &str) -> bool {
    s.parse::<f64>().is_ok()
}

fn pairs(t: &[&str]) -> Vec<[String; 2]> {
    t.chunks(2).filter(|c| c.len() == 2).map(|c| [c[0].to_string(), c[1].to_string()]).collect()
}

/// Data lines of an object, in file order: `(section index, line index)`.
fn object_lines(inp: &InpFile, kind: &SectionKind, id: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for (si, s) in inp.sections().iter().enumerate().filter(|(_, s)| s.kind() == kind) {
        for (li, l) in s.data() {
            if l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(id)) {
                out.push((si, li));
            }
        }
    }
    out
}

/// Reads one object.
pub fn read(inp: &InpFile, kind: RefKind, name: &str) -> Option<Table> {
    if kind == RefKind::Transect {
        return parse_transects(inp)
            .into_iter()
            .find(|t| t.t.name.eq_ignore_ascii_case(name))
            .map(|t| Table::Transect(t.t));
    }
    let section = section_of(kind)?;
    let lines: Vec<&Line> =
        object_lines(inp, &section, name).into_iter().map(|(s, l)| &inp.sections()[s].lines()[l]).collect();
    let first = lines.first()?;
    let name = first.token(0)?.to_string();
    fn toks<'a>(l: &&'a Line) -> Vec<&'a str> {
        l.tokens().skip(1).collect()
    }
    Some(match kind {
        RefKind::Curve => {
            let mut c = Curve { name, curve_type: String::new(), points: Vec::new() };
            for (i, l) in lines.iter().enumerate() {
                let mut t = toks(l);
                if i == 0 && t.first().is_some_and(|s| !is_number(s)) {
                    c.curve_type = t.remove(0).to_ascii_uppercase();
                }
                c.points.extend(pairs(&t));
            }
            Table::Curve(c)
        }
        RefKind::Timeseries => {
            let mut ts = Timeseries { name, file: None, rows: Vec::new() };
            for l in &lines {
                let t = toks(l);
                if t.first().is_some_and(|s| s.eq_ignore_ascii_case("FILE")) {
                    ts.file = Some(t.get(1).unwrap_or(&"").to_string());
                    continue;
                }
                let mut i = 0;
                while i + 1 < t.len() {
                    let mut date = String::new();
                    if swmm_inp::datetime::parse_date(t[i]).is_some() && i + 2 < t.len() {
                        date = t[i].to_string();
                        i += 1;
                    }
                    ts.rows.push(TsRow { date, time: t[i].to_string(), value: t[i + 1].to_string() });
                    i += 2;
                }
            }
            Table::Timeseries(ts)
        }
        RefKind::Pattern => {
            let mut p = Pattern { name, pattern_type: String::new(), factors: Vec::new() };
            for (i, l) in lines.iter().enumerate() {
                let mut t = toks(l);
                if i == 0 && t.first().is_some_and(|s| !is_number(s)) {
                    p.pattern_type = t.remove(0).to_ascii_uppercase();
                }
                p.factors.extend(t.iter().map(|s| s.to_string()));
            }
            Table::Pattern(p)
        }
        RefKind::Hydrograph => {
            let mut h = Hydrograph { name, gage: String::new(), rows: Vec::new() };
            for l in &lines {
                let t = toks(l);
                if t.len() == 1 {
                    h.gage = t[0].to_string();
                } else if t.len() >= 5 {
                    let g = |i: usize| t.get(i).map_or(String::new(), |s| s.to_string());
                    h.rows.push(UhRow {
                        month: g(0),
                        response: g(1),
                        r: g(2),
                        t: g(3),
                        k: g(4),
                        dmax: g(5),
                        drecov: g(6),
                        dinit: g(7),
                    });
                }
            }
            Table::Hydrograph(h)
        }
        RefKind::Aquifer => {
            let t = toks(first);
            let mut values = defaults(RefKind::Aquifer, "");
            values.truncate(12);
            for (v, s) in values.iter_mut().zip(&t) {
                *v = s.to_string();
            }
            Table::Aquifer(Aquifer { name, values, pattern: t.get(12).map_or(String::new(), |s| s.to_string()) })
        }
        RefKind::Snowpack => {
            let Some(Table::Snowpack(mut p)) = Table::empty(RefKind::Snowpack, &name) else { unreachable!() };
            for l in &lines {
                let t = toks(l);
                let Some(surface) = t.first().map(|s| s.to_ascii_uppercase()) else { continue };
                let target = match surface.as_str() {
                    "PLOWABLE" => &mut p.plowable,
                    "IMPERVIOUS" => &mut p.impervious,
                    "PERVIOUS" => &mut p.pervious,
                    "REMOVAL" => {
                        p.subcatchment = t.get(7).map_or(String::new(), |s| s.to_string());
                        &mut p.removal
                    }
                    _ => continue,
                };
                for (v, s) in target.iter_mut().zip(&t[1..]) {
                    *v = s.to_string();
                }
            }
            Table::Snowpack(p)
        }
        _ => return None,
    })
}

/// Line tokens of a (non-transect) table.
fn table_rows(t: &Table) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    match t {
        Table::Curve(c) => {
            for (i, p) in c.points.iter().enumerate() {
                let mut r = vec![c.name.clone()];
                if i == 0 {
                    r.push(c.curve_type.clone());
                }
                r.extend(p.iter().cloned());
                rows.push(r);
            }
            if rows.is_empty() {
                rows.push(vec![c.name.clone(), c.curve_type.clone()]);
            }
        }
        Table::Timeseries(ts) => {
            if let Some(f) = &ts.file {
                rows.push(vec![ts.name.clone(), "FILE".into(), f.clone()]);
            }
            for r in &ts.rows {
                let mut v = vec![ts.name.clone()];
                if !r.date.trim().is_empty() {
                    v.push(r.date.trim().to_string());
                }
                v.push(r.time.trim().to_string());
                v.push(r.value.trim().to_string());
                rows.push(v);
            }
        }
        Table::Pattern(p) => {
            for (i, chunk) in p.factors.chunks(6).enumerate() {
                let mut r = vec![p.name.clone()];
                if i == 0 {
                    r.push(p.pattern_type.clone());
                }
                r.extend(chunk.iter().cloned());
                rows.push(r);
            }
            if rows.is_empty() {
                rows.push(vec![p.name.clone(), p.pattern_type.clone()]);
            }
        }
        Table::Hydrograph(h) => {
            rows.push(vec![h.name.clone(), h.gage.clone()]);
            for r in &h.rows {
                let mut v =
                    vec![h.name.clone(), r.month.clone(), r.response.clone(), r.r.clone(), r.t.clone(), r.k.clone()];
                let ia = [&r.dmax, &r.drecov, &r.dinit];
                if ia.iter().any(|s| !s.trim().is_empty()) {
                    v.extend(
                        ia.iter().map(|s| if s.trim().is_empty() { "0".to_string() } else { s.trim().to_string() }),
                    );
                }
                rows.push(v);
            }
        }
        Table::Aquifer(a) => {
            let mut r = vec![a.name.clone()];
            r.extend(a.values.iter().map(|v| v.trim().to_string()));
            if !a.pattern.trim().is_empty() {
                r.push(a.pattern.trim().to_string());
            }
            rows.push(r);
        }
        Table::Snowpack(p) => {
            for (surface, values) in
                [("PLOWABLE", &p.plowable), ("IMPERVIOUS", &p.impervious), ("PERVIOUS", &p.pervious)]
            {
                let mut r = vec![p.name.clone(), surface.to_string()];
                r.extend(values.iter().map(|v| v.trim().to_string()));
                rows.push(r);
            }
            let mut r = vec![p.name.clone(), "REMOVAL".to_string()];
            r.extend(p.removal.iter().map(|v| v.trim().to_string()));
            if !p.subcatchment.trim().is_empty() {
                r.push(p.subcatchment.trim().to_string());
            }
            rows.push(r);
        }
        Table::Transect(_) => unreachable!("transects are written as blocks"),
    }
    rows
}

/// Replaces the data lines of object `id` in a section by `rows` (first token = id).
/// Lines that keep the same tokens are left untouched; a new object is appended.
pub fn replace_object_lines(tx: &mut Tx, kind: &SectionKind, id: &str, rows: Vec<Vec<String>>) {
    let old = object_lines(tx.inp(), kind, id);
    let ending = tx.inp().line_ending();
    if old.len() == rows.len() {
        for ((s, i), r) in old.into_iter().zip(rows) {
            let line = &tx.inp().sections()[s].lines()[i];
            if !line.tokens().eq(r.iter().map(String::as_str)) {
                let mut l = line.clone();
                l.set_tokens(&r);
                tx.replace_line(s, i, l);
            }
        }
        return;
    }
    let (s, at) = match old.first() {
        Some(&(s, i)) => (s, i),
        None => {
            let s = tx.ensure_section(kind);
            (s, tx.inp().sections()[s].append_index())
        }
    };
    for &(si, li) in old.iter().rev() {
        tx.remove_line(si, li);
    }
    let lines: Vec<Line> = rows.iter().map(|r| Line::from_tokens(r, None, ending)).collect();
    tx.splice(s, at, 0, lines);
}

/// Removes every data line of an object in a section.
pub fn remove_object_lines(tx: &mut Tx, kind: &SectionKind, id: &str) {
    for (s, i) in object_lines(tx.inp(), kind, id).into_iter().rev() {
        tx.remove_line(s, i);
    }
}

/// Writes a table, replacing the object of the same name or adding it.
pub fn write(tx: &mut Tx, t: &Table) -> EditResult<()> {
    validate(t)?;
    if read(tx.inp(), t.ref_kind(), t.name()).as_ref() == Some(t) {
        return Ok(());
    }
    match t {
        Table::Transect(tr) => write_transect(tx, tr),
        _ => {
            let section = section_of(t.ref_kind()).expect("table section");
            replace_object_lines(tx, &section, t.name(), table_rows(t));
            Ok(())
        }
    }
}

/// Deletes a table that nothing refers to.
pub fn delete(tx: &mut Tx, kind: RefKind, name: &str) -> EditResult<()> {
    let users = refs::usages(tx.inp(), kind, name);
    if !users.is_empty() {
        let list: Vec<String> = users.iter().take(5).map(|u| format!("{} [{}]", u.by, u.section)).collect();
        let more = if users.len() > 5 { format!(" and {} more", users.len() - 5) } else { String::new() };
        return Err(format!("{name} is used by {}{more}", list.join(", ")));
    }
    if kind == RefKind::Transect {
        let all = parse_transects(tx.inp());
        let i = all.iter().position(|t| t.t.name.eq_ignore_ascii_case(name)).ok_or(format!("no transect {name}"))?;
        // A transect that follows relied on this one's roughness only if it has its own.
        if all[i].own_nc {
            fix_next_roughness(tx, &all, i, None);
        }
        let all = parse_transects(tx.inp());
        let b = &all[i];
        for li in (b.start..b.end).rev() {
            if tx.inp().sections()[b.section].lines()[li].is_data() {
                tx.remove_line(b.section, li);
            }
        }
        return Ok(());
    }
    let section = section_of(kind).ok_or("not a table")?;
    remove_object_lines(tx, &section, name);
    Ok(())
}

/// Names in use by any kind of table, upper case.
pub fn used_names(inp: &InpFile, kind: RefKind) -> HashSet<String> {
    refs::names(inp, kind).into_iter().map(|n| n.to_ascii_uppercase()).collect()
}

#[cfg(test)]
mod tests;
