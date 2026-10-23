//! Named data objects edited as a whole: curves, time series, time patterns, unit
//! hydrographs (RDII) and transects. Values are kept as text so that untouched numbers
//! are written back as they were.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use swmm_inp::{InpFile, Line, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::refs;
use crate::schema::{check_id, RefKind};

pub const CURVE_TYPES: &[&str] = &[
    "STORAGE",
    "SHAPE",
    "DIVERSION",
    "TIDAL",
    "PUMP1",
    "PUMP2",
    "PUMP3",
    "PUMP4",
    "PUMP5",
    "RATING",
    "CONTROL",
    "WEIR",
];
pub const PATTERN_TYPES: &[&str] = &["MONTHLY", "DAILY", "HOURLY", "WEEKEND"];
pub const MONTHS: &[&str] =
    &["All", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
pub const RESPONSES: &[&str] = &["Short", "Medium", "Long"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Curve {
    pub name: String,
    /// `STORAGE`, `SHAPE`, `PUMP1`…
    pub curve_type: String,
    pub points: Vec<[String; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TsRow {
    /// Empty: same date as the previous row (or no dates at all).
    pub date: String,
    pub time: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Timeseries {
    pub name: String,
    /// External data file (`TS FILE path`); `rows` is then empty.
    pub file: Option<String>,
    pub rows: Vec<TsRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pattern {
    pub name: String,
    pub pattern_type: String,
    pub factors: Vec<String>,
}

/// One triangular unit hydrograph of an RDII group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UhRow {
    /// `All` or a month abbreviation.
    pub month: String,
    /// `Short`, `Medium` or `Long`.
    pub response: String,
    pub r: String,
    pub t: String,
    pub k: String,
    /// Initial abstraction: max depth, recovery rate, initial depth (optional, may be empty).
    pub dmax: String,
    pub drecov: String,
    pub dinit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hydrograph {
    pub name: String,
    pub gage: String,
    pub rows: Vec<UhRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transect {
    pub name: String,
    pub n_left: String,
    pub n_right: String,
    pub n_channel: String,
    pub x_left: String,
    pub x_right: String,
    /// Meander modifier.
    pub lfactor: String,
    /// Stations scale factor.
    pub wfactor: String,
    /// Elevation offset.
    pub eoffset: String,
    /// `[station, elevation]`.
    pub points: Vec<[String; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Table {
    Curve(Curve),
    Timeseries(Timeseries),
    Pattern(Pattern),
    Hydrograph(Hydrograph),
    Transect(Transect),
}

impl Table {
    pub fn name(&self) -> &str {
        match self {
            Table::Curve(c) => &c.name,
            Table::Timeseries(t) => &t.name,
            Table::Pattern(p) => &p.name,
            Table::Hydrograph(h) => &h.name,
            Table::Transect(t) => &t.name,
        }
    }

    pub fn ref_kind(&self) -> RefKind {
        match self {
            Table::Curve(_) => RefKind::Curve,
            Table::Timeseries(_) => RefKind::Timeseries,
            Table::Pattern(_) => RefKind::Pattern,
            Table::Hydrograph(_) => RefKind::Hydrograph,
            Table::Transect(_) => RefKind::Transect,
        }
    }

    /// An empty object of a kind.
    pub fn empty(kind: RefKind, name: &str) -> Option<Table> {
        let n = name.to_string();
        Some(match kind {
            RefKind::Curve => Table::Curve(Curve { name: n, curve_type: "STORAGE".into(), points: Vec::new() }),
            RefKind::Timeseries => Table::Timeseries(Timeseries { name: n, file: None, rows: Vec::new() }),
            RefKind::Pattern => {
                Table::Pattern(Pattern { name: n, pattern_type: "HOURLY".into(), factors: vec!["1.0".to_string(); 24] })
            }
            RefKind::Hydrograph => Table::Hydrograph(Hydrograph {
                name: n,
                gage: "*".into(),
                rows: RESPONSES
                    .iter()
                    .map(|r| UhRow {
                        month: "All".into(),
                        response: r.to_string(),
                        r: "0".into(),
                        t: "1".into(),
                        k: "2".into(),
                        dmax: String::new(),
                        drecov: String::new(),
                        dinit: String::new(),
                    })
                    .collect(),
            }),
            RefKind::Transect => Table::Transect(Transect {
                name: n,
                n_left: "0.03".into(),
                n_right: "0.03".into(),
                n_channel: "0.03".into(),
                x_left: "0".into(),
                x_right: "0".into(),
                lfactor: "0".into(),
                wfactor: "0".into(),
                eoffset: "0".into(),
                points: Vec::new(),
            }),
            _ => return None,
        })
    }
}

/// Section holding a kind of table.
pub fn section_of(kind: RefKind) -> Option<SectionKind> {
    Some(match kind {
        RefKind::Curve => SectionKind::Curves,
        RefKind::Timeseries => SectionKind::Timeseries,
        RefKind::Pattern => SectionKind::Patterns,
        RefKind::Hydrograph => SectionKind::Hydrographs,
        RefKind::Transect => SectionKind::Transects,
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
        Table::Transect(_) => unreachable!("transects are written as blocks"),
    }
    rows
}

fn num_check(label: &str, v: &str) -> EditResult<()> {
    if v.trim().parse::<f64>().map(f64::is_finite).unwrap_or(false) {
        Ok(())
    } else {
        Err(format!("{label}: {v:?} is not a number"))
    }
}

/// Checks the values of a table before writing it.
pub fn validate(t: &Table) -> EditResult<()> {
    check_id(t.name())?;
    match t {
        Table::Curve(c) => {
            if !CURVE_TYPES.contains(&c.curve_type.as_str()) {
                return Err(format!("unknown curve type {:?}", c.curve_type));
            }
            for (i, p) in c.points.iter().enumerate() {
                num_check(&format!("row {}", i + 1), &p[0])?;
                num_check(&format!("row {}", i + 1), &p[1])?;
            }
        }
        Table::Timeseries(ts) => {
            if let Some(f) = &ts.file {
                if f.trim().is_empty() {
                    return Err("the file name is empty".into());
                }
            }
            for (i, r) in ts.rows.iter().enumerate() {
                let row = format!("row {}", i + 1);
                if !r.date.trim().is_empty() && swmm_inp::datetime::parse_date(&r.date).is_none() {
                    return Err(format!("{row}: {:?} is not a date (MM/DD/YYYY)", r.date));
                }
                if swmm_inp::datetime::parse_time(&r.time).is_none() {
                    return Err(format!("{row}: {:?} is not a time (H:MM or decimal hours)", r.time));
                }
                num_check(&row, &r.value)?;
            }
        }
        Table::Pattern(p) => {
            let want = match p.pattern_type.as_str() {
                "MONTHLY" => 12,
                "DAILY" => 7,
                "HOURLY" | "WEEKEND" => 24,
                other => return Err(format!("unknown pattern type {other:?}")),
            };
            if p.factors.len() != want {
                return Err(format!("a {} pattern needs {want} factors, not {}", p.pattern_type, p.factors.len()));
            }
            for (i, v) in p.factors.iter().enumerate() {
                num_check(&format!("factor {}", i + 1), v)?;
            }
        }
        Table::Hydrograph(h) => {
            check_id(&h.gage).map_err(|e| format!("rain gage: {e}"))?;
            for r in &h.rows {
                if !MONTHS.iter().any(|m| m.eq_ignore_ascii_case(&r.month)) {
                    return Err(format!("unknown month {:?}", r.month));
                }
                if !RESPONSES.iter().any(|m| m.eq_ignore_ascii_case(&r.response)) {
                    return Err(format!("unknown response {:?}", r.response));
                }
                let row = format!("{} {}", r.month, r.response);
                for v in [&r.r, &r.t, &r.k] {
                    num_check(&row, v)?;
                }
                for v in [&r.dmax, &r.drecov, &r.dinit] {
                    if !v.trim().is_empty() {
                        num_check(&row, v)?;
                    }
                }
            }
        }
        Table::Transect(t) => {
            for (label, v) in [
                ("left bank roughness", &t.n_left),
                ("right bank roughness", &t.n_right),
                ("channel roughness", &t.n_channel),
                ("left bank station", &t.x_left),
                ("right bank station", &t.x_right),
                ("meander modifier", &t.lfactor),
                ("stations factor", &t.wfactor),
                ("elevation offset", &t.eoffset),
            ] {
                num_check(label, v)?;
            }
            for (i, p) in t.points.iter().enumerate() {
                num_check(&format!("station {}", i + 1), &p[0])?;
                num_check(&format!("station {}", i + 1), &p[1])?;
            }
        }
    }
    Ok(())
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
        fix_next_roughness(tx, &all, i, None);
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

// ---- transects ---------------------------------------------------------------

/// A transect and the lines it spans.
struct TransectBlock {
    t: Transect,
    section: usize,
    /// First line of the block (its own `NC` line, or `X1`).
    start: usize,
    /// One past its last `GR` line.
    end: usize,
    /// Has an `NC` line right before its `X1`.
    own_nc: bool,
}

fn parse_transects(inp: &InpFile) -> Vec<TransectBlock> {
    let mut out: Vec<TransectBlock> = Vec::new();
    for (si, s) in inp.sections().iter().enumerate().filter(|(_, s)| *s.kind() == SectionKind::Transects) {
        let mut nc = ["0.03".to_string(), "0.03".to_string(), "0.03".to_string()];
        let mut nc_line: Option<usize> = None;
        let mut current: Option<TransectBlock> = None;
        for (li, l) in s.data() {
            let key = l.token(0).unwrap_or("").to_ascii_uppercase();
            let g = |i: usize| l.token(i).unwrap_or("0").to_string();
            match key.as_str() {
                "NC" => {
                    out.extend(current.take());
                    nc = [g(1), g(2), g(3)];
                    nc_line = Some(li);
                }
                "X1" => {
                    out.extend(current.take());
                    let own_nc = nc_line.is_some();
                    current = Some(TransectBlock {
                        t: Transect {
                            name: g(1),
                            n_left: nc[0].clone(),
                            n_right: nc[1].clone(),
                            n_channel: nc[2].clone(),
                            x_left: g(3),
                            x_right: g(4),
                            lfactor: g(8),
                            wfactor: g(9),
                            eoffset: g(10),
                            points: Vec::new(),
                        },
                        section: si,
                        start: nc_line.unwrap_or(li),
                        end: li + 1,
                        own_nc,
                    });
                    nc_line = None;
                }
                "GR" => {
                    if let Some(c) = current.as_mut() {
                        let t: Vec<&str> = l.tokens().skip(1).collect();
                        // GR lists elevation then station.
                        c.t.points.extend(pairs(&t).into_iter().map(|[e, st]| [st, e]));
                        c.end = li + 1;
                    }
                }
                _ => {}
            }
        }
        out.extend(current.take());
    }
    out
}

fn transect_lines(t: &Transect, ending: swmm_inp::LineEnding) -> Vec<Line> {
    let mut lines = vec![
        Line::from_tokens(&["NC", &t.n_left, &t.n_right, &t.n_channel], None, ending),
        Line::from_tokens(
            &[
                "X1",
                &t.name,
                &t.points.len().to_string(),
                &t.x_left,
                &t.x_right,
                "0.0",
                "0.0",
                "0.0",
                &t.lfactor,
                &t.wfactor,
                &t.eoffset,
            ],
            None,
            ending,
        ),
    ];
    for chunk in t.points.chunks(5) {
        let mut r = vec!["GR".to_string()];
        for [st, e] in chunk {
            r.push(e.clone());
            r.push(st.clone());
        }
        lines.push(Line::from_tokens(&r, None, ending));
    }
    lines
}

/// Before transect `i` changes its roughness (or goes away), gives the next transect
/// its own `NC` line if it relied on the one of transect `i`.
fn fix_next_roughness(tx: &mut Tx, all: &[TransectBlock], i: usize, new_nc: Option<[&str; 3]>) {
    let Some(next) = all.get(i + 1).filter(|n| n.section == all[i].section && !n.own_nc) else {
        return;
    };
    let keep = [next.t.n_left.as_str(), next.t.n_right.as_str(), next.t.n_channel.as_str()];
    if new_nc == Some(keep) {
        return;
    }
    let ending = tx.inp().line_ending();
    tx.insert_line(next.section, next.start, Line::from_tokens(&["NC", keep[0], keep[1], keep[2]], None, ending));
}

fn write_transect(tx: &mut Tx, t: &Transect) -> EditResult<()> {
    let ending = tx.inp().line_ending();
    let all = parse_transects(tx.inp());
    let lines = transect_lines(t, ending);
    match all.iter().position(|b| b.t.name.eq_ignore_ascii_case(&t.name)) {
        Some(i) => {
            if all[i].t == *t {
                return Ok(());
            }
            fix_next_roughness(tx, &all, i, Some([&t.n_left, &t.n_right, &t.n_channel]));
            let b = &all[i];
            let data: Vec<usize> =
                (b.start..b.end).filter(|&li| tx.inp().sections()[b.section].lines()[li].is_data()).collect();
            let (section, start) = (b.section, b.start);
            for &li in data.iter().rev() {
                tx.remove_line(section, li);
            }
            tx.splice(section, start, 0, lines);
        }
        None => {
            let s = tx.ensure_section(&SectionKind::Transects);
            let at = tx.inp().sections()[s].append_index();
            tx.splice(s, at, 0, lines);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::History;

    const SRC: &str = "\
[CURVES]
;;Name Type X Y
SC1 STORAGE 0 10 1 20
SC1 2 30
PC1 PUMP2 0 1

[TIMESERIES]
TS1 01/01/2000 0:00 0 1:00 2.5
TS1 2:00 1
TS2 FILE \"rain.dat\"

[PATTERNS]
P1 DAILY 1 1 1 1 1 1
P1 0.5

[HYDROGRAPHS]
UH1 RG1
UH1 All Short 0.01 1 2
UH1 All Medium 0.02 3 2 1 0.1 0

[TRANSECTS]
NC 0.03 0.03 0.015
X1 T1 3 10 20 0.0 0.0 0.0 0 0 0
GR 5 0 1 10 5 20
X1 T2 2 0 1 0.0 0.0 0.0 0 0 0
GR 3 0 3 1
";

    #[test]
    fn reads_tables() {
        let inp = InpFile::parse_str(SRC);
        let Some(Table::Curve(c)) = read(&inp, RefKind::Curve, "sc1") else { panic!() };
        assert_eq!(c.curve_type, "STORAGE");
        assert_eq!(c.points.len(), 3);
        let Some(Table::Timeseries(ts)) = read(&inp, RefKind::Timeseries, "TS1") else { panic!() };
        assert_eq!(ts.rows.len(), 3);
        assert_eq!(ts.rows[0].date, "01/01/2000");
        assert_eq!(
            (ts.rows[1].date.as_str(), ts.rows[1].time.as_str(), ts.rows[1].value.as_str()),
            ("", "1:00", "2.5")
        );
        let Some(Table::Timeseries(f)) = read(&inp, RefKind::Timeseries, "TS2") else { panic!() };
        assert_eq!(f.file.as_deref(), Some("rain.dat"));
        let Some(Table::Pattern(p)) = read(&inp, RefKind::Pattern, "P1") else { panic!() };
        assert_eq!((p.pattern_type.as_str(), p.factors.len()), ("DAILY", 7));
        let Some(Table::Hydrograph(h)) = read(&inp, RefKind::Hydrograph, "UH1") else { panic!() };
        assert_eq!(h.gage, "RG1");
        assert_eq!(h.rows[1].dmax, "1");
        let Some(Table::Transect(t)) = read(&inp, RefKind::Transect, "T2") else { panic!() };
        assert_eq!(t.n_channel, "0.015");
        assert_eq!(t.points, vec![["0".to_string(), "3".to_string()], ["1".to_string(), "3".to_string()]]);
        assert!(read(&inp, RefKind::Curve, "nope").is_none());
    }

    #[test]
    fn writes_with_minimal_changes() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let Some(Table::Curve(mut c)) = read(&inp, RefKind::Curve, "SC1") else { panic!() };
        // Same content: nothing changes.
        h.edit(&mut inp, "same", |tx| write(tx, &Table::Curve(c.clone()))).unwrap();
        assert!(h.undo_label().is_none());
        c.points.push(["3".into(), "45".into()]);
        h.edit(&mut inp, "curve", |tx| write(tx, &Table::Curve(c.clone()))).unwrap();
        let text = inp.to_string_lossy();
        assert!(text.contains(";;Name Type X Y\nSC1              STORAGE    0          10\nSC1              1          20\nSC1              2          30\nSC1              3          45\nPC1 PUMP2 0 1\n"), "{text}");
        // New pattern appended; invalid one refused.
        let mut p = Table::empty(RefKind::Pattern, "P2").unwrap();
        h.edit(&mut inp, "p", |tx| write(tx, &p)).unwrap();
        assert!(inp.to_string_lossy().contains("P2               HOURLY     1.0"));
        if let Table::Pattern(pp) = &mut p {
            pp.factors.pop();
        }
        assert!(h.edit(&mut inp, "p", |tx| write(tx, &p)).is_err());
        h.undo(&mut inp);
        h.undo(&mut inp);
        assert_eq!(inp.to_string_lossy(), SRC);
    }

    #[test]
    fn transect_roughness_stays_with_the_next_one() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let Some(Table::Transect(mut t1)) = read(&inp, RefKind::Transect, "T1") else { panic!() };
        t1.n_channel = "0.02".into();
        t1.points.push(["30".into(), "6".into()]);
        h.edit(&mut inp, "t1", |tx| write(tx, &Table::Transect(t1.clone()))).unwrap();
        let Some(Table::Transect(t2)) = read(&inp, RefKind::Transect, "T2") else { panic!() };
        assert_eq!(t2.n_channel, "0.015");
        let Some(Table::Transect(again)) = read(&inp, RefKind::Transect, "T1") else { panic!() };
        assert_eq!(again, t1);
        let text = inp.to_string_lossy();
        assert!(text.contains("X1               T1         4"), "{text}");
        // Deleting T1 keeps T2's roughness too.
        h.undo(&mut inp);
        h.edit(&mut inp, "del", |tx| delete(tx, RefKind::Transect, "T1")).unwrap();
        let Some(Table::Transect(t2)) = read(&inp, RefKind::Transect, "T2") else { panic!() };
        assert_eq!(t2.n_channel, "0.015");
        assert!(read(&inp, RefKind::Transect, "T1").is_none());
        h.undo(&mut inp);
        assert_eq!(inp.to_string_lossy(), SRC);
    }

    #[test]
    fn delete_refuses_used_objects() {
        let src = format!("{SRC}\n[STORAGE]\nST1 0 5 0 TABULAR SC1 0 0\n");
        let mut inp = InpFile::parse_str(&src);
        let mut h = History::default();
        let e = h.edit(&mut inp, "d", |tx| delete(tx, RefKind::Curve, "SC1")).unwrap_err();
        assert!(e.contains("ST1 [STORAGE]"), "{e}");
        h.edit(&mut inp, "d", |tx| delete(tx, RefKind::Curve, "PC1")).unwrap();
        assert!(read(&inp, RefKind::Curve, "PC1").is_none());
    }
}
