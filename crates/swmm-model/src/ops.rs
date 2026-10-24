//! Editing operations: each runs inside a [`Tx`] and is undone as a whole.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use swmm_inp::{InpFile, Line, LineKind, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::refs::{self, RefLoc, Role};
use crate::schema::{self, check_id, Context, FieldType, RefKind};
use crate::tables::replace_object_lines;
use crate::{LinkType, Network, NodeType, ObjKind, ObjRef};

/// First data line of a section kind whose first tokens equal `key` (case-insensitive):
/// `(section index, line index)`.
pub fn find_line(inp: &InpFile, kind: &SectionKind, key: &[&str]) -> Option<(usize, usize)> {
    inp.sections().iter().enumerate().filter(|(_, s)| s.kind() == kind).find_map(|(si, s)| {
        s.data()
            .find(|(_, l)| key.iter().enumerate().all(|(i, k)| l.token(i).is_some_and(|t| t.eq_ignore_ascii_case(k))))
            .map(|(li, _)| (si, li))
    })
}

/// Index of the first line of each object of a section kind: upper-case first token →
/// `(section, line)`.
fn line_index(inp: &InpFile, kind: &SectionKind) -> HashMap<String, (usize, usize)> {
    let mut m = HashMap::new();
    for (si, s) in inp.sections().iter().enumerate().filter(|(_, s)| s.kind() == kind) {
        for (li, l) in s.data() {
            if let Some(t) = l.token(0) {
                m.entry(t.to_ascii_uppercase()).or_insert((si, li));
            }
        }
    }
    m
}

fn tokens_of(inp: &InpFile, at: (usize, usize)) -> Vec<String> {
    inp.sections()[at.0].lines()[at.1].to_vec()
}

/// Sets one field of the line at `at`, keeping the rest of the line's text when the
/// layout does not change.
pub(crate) fn set_field_at(
    tx: &mut Tx,
    kind: &SectionKind,
    at: (usize, usize),
    field: usize,
    value: &str,
) -> EditResult<()> {
    let ctx = Context::of(tx.inp());
    let old = tokens_of(tx.inp(), at);
    let t: Vec<&str> = old.iter().map(String::as_str).collect();
    let defs = schema::layout(kind, &t, &ctx).ok_or_else(|| format!("[{}] cannot be edited here", kind.name()))?;
    let def = defs.get(field).ok_or_else(|| format!("no field #{field} in [{}]", kind.name()))?;
    if field == 0 {
        return Err("rename the object instead".into());
    }
    let value = schema::validate(def, value)?;
    let new = schema::set_field(kind, &t, field, &value, &ctx).expect("layout exists");
    let mut line = tx.inp().sections()[at.0].lines()[at.1].clone();
    if new.len() == old.len() && new.iter().zip(&old).enumerate().all(|(i, (a, b))| i == field || a == b) {
        line.set_token(field, &new[field]);
    } else {
        line.set_tokens(&new);
    }
    tx.replace_line(at.0, at.1, line);
    Ok(())
}

/// Sets field `field` of the line identified by `key` in a section.
pub fn set_field(tx: &mut Tx, kind: &SectionKind, key: &[String], field: usize, value: &str) -> EditResult<()> {
    let k: Vec<&str> = key.iter().map(String::as_str).collect();
    let at = find_line(tx.inp(), kind, &k).ok_or_else(|| format!("no line {} in [{}]", key.join(" "), kind.name()))?;
    set_field_at(tx, kind, at, field, value)
}

/// Sets a field (by key) on the lines of many objects; objects without such a line are
/// skipped. Returns how many lines were edited.
pub fn set_field_bulk(
    tx: &mut Tx,
    kind: &SectionKind,
    ids: &[String],
    field_key: &str,
    value: &str,
) -> EditResult<usize> {
    let index = line_index(tx.inp(), kind);
    let ctx = Context::of(tx.inp());
    let mut n = 0;
    for id in ids {
        let Some(&at) = index.get(&id.to_ascii_uppercase()) else { continue };
        let old = tokens_of(tx.inp(), at);
        let t: Vec<&str> = old.iter().map(String::as_str).collect();
        let Some(field) = schema::layout(kind, &t, &ctx).and_then(|d| d.iter().position(|d| d.key == field_key)) else {
            continue;
        };
        set_field_at(tx, kind, at, field, value).map_err(|e| format!("{id}: {e}"))?;
        n += 1;
    }
    Ok(n)
}

/// Adds the line of a section for an object (e.g. its `[RDII]` line) with defaults.
pub fn add_line(tx: &mut Tx, kind: &SectionKind, key: &[String]) -> EditResult<()> {
    let k: Vec<&str> = key.iter().map(String::as_str).collect();
    if find_line(tx.inp(), kind, &k).is_some() {
        return Err(format!("{} already has a [{}] line", key[0], kind.name()));
    }
    let ctx = Context::of(tx.inp());
    let tokens =
        schema::new_line_tokens(kind, &k, &ctx).ok_or_else(|| format!("[{}] cannot be added here", kind.name()))?;
    tx.append(kind, &tokens);
    Ok(())
}

pub fn remove_line(tx: &mut Tx, kind: &SectionKind, key: &[String]) -> EditResult<()> {
    let k: Vec<&str> = key.iter().map(String::as_str).collect();
    let (s, l) =
        find_line(tx.inp(), kind, &k).ok_or_else(|| format!("no line {} in [{}]", key.join(" "), kind.name()))?;
    tx.remove_line(s, l);
    Ok(())
}

/// Renames an object and every reference to it.
pub fn rename(tx: &mut Tx, kind: RefKind, old: &str, new: &str) -> EditResult<()> {
    let new = new.trim();
    check_id(new)?;
    if new == old {
        return Ok(());
    }
    let taken = refs::names(tx.inp(), kind).iter().any(|n| n.eq_ignore_ascii_case(new) && !n.eq_ignore_ascii_case(old));
    if taken {
        return Err(format!("the name {new} is already used"));
    }
    let ids: HashSet<String> = [old.to_ascii_uppercase()].into();
    let locs = refs::find_refs(tx.inp(), kind, &ids);
    if !locs.iter().any(|r| r.role == Role::Def) {
        return Err(format!("no object named {old}"));
    }
    for r in locs {
        let mut line = tx.inp().sections()[r.section].lines()[r.line].clone();
        line.set_token(r.token, new);
        tx.replace_line(r.section, r.line, line);
    }
    Ok(())
}

/// What deleting objects also removes or changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DeletePlan {
    pub nodes: Vec<String>,
    pub links: Vec<String>,
    pub subcatchments: Vec<String>,
    pub gages: Vec<String>,
    /// Links deleted because one of their nodes is.
    pub cascade_links: Vec<String>,
    /// References set to `*` or removed: `[section] object`.
    pub cleared: Vec<String>,
    /// Control rules that name a deleted object (left unchanged).
    pub rules: usize,
}

fn ref_kind(k: ObjKind) -> RefKind {
    match k {
        ObjKind::Node => RefKind::Node,
        ObjKind::Link => RefKind::Link,
        ObjKind::Subcatchment => RefKind::Subcatchment,
        ObjKind::Gage => RefKind::Gage,
    }
}

/// Plans (and with `tx`, performs) the deletion of objects.
fn delete_impl(inp: &InpFile, net: &Network, objects: &[ObjRef]) -> (DeletePlan, Vec<RefLoc>) {
    let mut plan = DeletePlan::default();
    let mut sets: [HashSet<String>; 4] = Default::default();
    for o in objects {
        if (o.index as usize) < net.len(o.kind) {
            let id = net.id(*o).to_string();
            if sets[o.kind as usize].insert(id.to_ascii_uppercase()) {
                match o.kind {
                    ObjKind::Node => plan.nodes.push(id),
                    ObjKind::Link => plan.links.push(id),
                    ObjKind::Subcatchment => plan.subcatchments.push(id),
                    ObjKind::Gage => plan.gages.push(id),
                }
            }
        }
    }
    let nodes: HashSet<u32> = objects.iter().filter(|o| o.kind == ObjKind::Node).map(|o| o.index).collect();
    for l in &net.links {
        let attached = l.from.is_some_and(|n| nodes.contains(&n)) || l.to.is_some_and(|n| nodes.contains(&n));
        if attached && sets[ObjKind::Link as usize].insert(l.id.to_ascii_uppercase()) {
            plan.cascade_links.push(l.id.clone());
        }
    }
    let mut locs = Vec::new();
    for k in ObjKind::ALL {
        locs.extend(refs::find_refs(inp, ref_kind(k), &sets[k as usize]));
    }
    // Lines that go away entirely.
    let removed: HashSet<(usize, usize)> =
        locs.iter().filter(|r| matches!(r.role, Role::Def | Role::Owned)).map(|r| (r.section, r.line)).collect();
    // Links of deleted nodes are removed with their own lines.
    locs.retain(|r| !(r.role == Role::Ref && removed.contains(&(r.section, r.line))));
    for r in &locs {
        match r.role {
            Role::Ref | Role::List => {
                let s = &inp.sections()[r.section];
                let by = s.lines()[r.line].token(0).unwrap_or("");
                plan.cleared.push(format!("[{}] {by}", s.name()));
            }
            Role::Rule => plan.rules += 1,
            _ => {}
        }
    }
    plan.cleared.dedup();
    (plan, locs)
}

pub fn delete_plan(inp: &InpFile, net: &Network, objects: &[ObjRef]) -> DeletePlan {
    delete_impl(inp, net, objects).0
}

/// Deletes objects, the links attached to deleted nodes and every line that belongs to
/// them; references from other objects are set to `*` (lists lose the name).
pub fn delete(tx: &mut Tx, net: &Network, objects: &[ObjRef]) -> EditResult<DeletePlan> {
    let (plan, locs) = delete_impl(tx.inp(), net, objects);
    let mut by_line: std::collections::BTreeMap<(usize, usize), Vec<RefLoc>> = Default::default();
    for r in locs.into_iter().filter(|r| r.role != Role::Rule) {
        by_line.entry((r.section, r.line)).or_default().push(r);
    }
    // Bottom-up so that indices stay valid.
    for ((s, l), rs) in by_line.into_iter().rev() {
        if rs.iter().any(|r| matches!(r.role, Role::Def | Role::Owned)) {
            tx.remove_line(s, l);
            continue;
        }
        let line = tx.inp().sections()[s].lines()[l].clone();
        let kind = tx.inp().sections()[s].kind().clone();
        let mut tokens: Vec<Option<String>> = line.tokens().map(|t| Some(t.to_string())).collect();
        for r in &rs {
            let last = r.token + 1 == tokens.len();
            let optional_tail =
                last && matches!(kind, SectionKind::Outfalls | SectionKind::Labels | SectionKind::Groundwater);
            if r.role == Role::List || optional_tail {
                tokens[r.token] = None;
            } else {
                tokens[r.token] = Some("*".into());
            }
        }
        let kept: Vec<String> = tokens.into_iter().flatten().collect();
        if kept.len() <= 1 && kind == SectionKind::Report {
            tx.remove_line(s, l);
        } else {
            let mut nl = line;
            nl.set_tokens(&kept);
            tx.replace_line(s, l, nl);
        }
    }
    Ok(plan)
}

fn fmt_coord(x: f64, decimals: usize) -> String {
    format!("{x:.decimals$}")
}

/// Section holding the map geometry of a kind of object.
pub fn geometry_section(kind: ObjKind) -> SectionKind {
    match kind {
        ObjKind::Node => SectionKind::Coordinates,
        ObjKind::Link => SectionKind::Vertices,
        ObjKind::Subcatchment => SectionKind::Polygons,
        ObjKind::Gage => SectionKind::Symbols,
    }
}

/// Sets the map geometry of an object in model coordinates: the point of a node or
/// gage, the interior vertices of a link, the outline of a subcatchment.
pub fn set_geometry(tx: &mut Tx, kind: ObjKind, id: &str, pts: &[[f64; 2]], decimals: usize) -> EditResult<()> {
    if pts.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
        return Err("a point is outside the coordinate system".into());
    }
    if matches!(kind, ObjKind::Node | ObjKind::Gage) && pts.len() != 1 {
        return Err("a node or gage has one point".into());
    }
    let rows: Vec<Vec<String>> =
        pts.iter().map(|p| vec![id.to_string(), fmt_coord(p[0], decimals), fmt_coord(p[1], decimals)]).collect();
    replace_object_lines(tx, &geometry_section(kind), id, rows);
    Ok(())
}

/// Next free name `<prefix><n>` among all network objects.
pub fn new_id(net: &Network, prefix: &str) -> String {
    let mut max = 0u64;
    for k in ObjKind::ALL {
        for i in 0..net.len(k) {
            let id = net.id(ObjRef { kind: k, index: i as u32 });
            if let Some(n) = id.strip_prefix(prefix).and_then(|r| r.parse::<u64>().ok()) {
                max = max.max(n);
            }
        }
    }
    let mut n = max + 1;
    loop {
        let id = format!("{prefix}{n}");
        if net.find_any(&id).is_none() {
            return id;
        }
        n += 1;
    }
}

pub fn node_prefix(t: NodeType) -> &'static str {
    match t {
        NodeType::Junction => "J",
        NodeType::Outfall => "Out",
        NodeType::Divider => "Div",
        NodeType::Storage => "SU",
    }
}

pub fn link_prefix(t: LinkType) -> &'static str {
    match t {
        LinkType::Conduit => "C",
        LinkType::Pump => "P",
        LinkType::Orifice => "OR",
        LinkType::Weir => "W",
        LinkType::Outlet => "OL",
    }
}

fn new_tokens(tx: &Tx, kind: &SectionKind, key: &[&str]) -> Vec<String> {
    schema::new_line_tokens(kind, key, &Context::of(tx.inp())).expect("section has a schema")
}

pub fn add_node(tx: &mut Tx, net: &Network, ty: NodeType, xy: [f64; 2], decimals: usize) -> EditResult<String> {
    let id = new_id(net, node_prefix(ty));
    let tokens = new_tokens(tx, &ty.section(), &[&id]);
    tx.append(&ty.section(), &tokens);
    set_geometry(tx, ObjKind::Node, &id, &[xy], decimals)?;
    Ok(id)
}

pub fn add_link(
    tx: &mut Tx,
    net: &Network,
    ty: LinkType,
    [from, to]: [&str; 2],
    vertices: &[[f64; 2]],
    length: Option<f64>,
    decimals: usize,
) -> EditResult<String> {
    if from.eq_ignore_ascii_case(to) {
        return Err("a link needs two different nodes".into());
    }
    let id = new_id(net, link_prefix(ty));
    let mut tokens = new_tokens(tx, &ty.section(), &[&id, from, to]);
    if let (LinkType::Conduit, Some(len)) = (ty, length) {
        tokens[3] = format!("{:.2}", len.max(0.01));
    }
    tx.append(&ty.section(), &tokens);
    let xsection: Option<&[&str]> = match ty {
        LinkType::Conduit => Some(&["CIRCULAR", "1", "0", "0", "0", "1"]),
        LinkType::Orifice => Some(&["CIRCULAR", "1", "0", "0", "0"]),
        LinkType::Weir => Some(&["RECT_OPEN", "1", "1", "0", "0"]),
        _ => None,
    };
    if let Some(x) = xsection {
        let mut t = vec![id.as_str()];
        t.extend_from_slice(x);
        tx.append(&SectionKind::Xsections, &t);
    }
    if !vertices.is_empty() {
        set_geometry(tx, ObjKind::Link, &id, vertices, decimals)?;
    }
    Ok(id)
}

/// Adds a subcatchment; `area` is in the model's area units (ha or ac).
pub fn add_subcatchment(
    tx: &mut Tx,
    net: &Network,
    polygon: &[[f64; 2]],
    outlet: Option<&str>,
    area: Option<f64>,
    decimals: usize,
) -> EditResult<String> {
    if polygon.len() < 3 {
        return Err("a subcatchment outline needs at least 3 points".into());
    }
    let id = new_id(net, "S");
    let gage = net.gages.first().map_or("*", |g| g.id.as_str()).to_string();
    let mut tokens = new_tokens(tx, &SectionKind::Subcatchments, &[&id, &gage, outlet.unwrap_or("*")]);
    if let Some(a) = area.filter(|a| *a > 0.0) {
        let per_area = if tx.inp().flow_units().is_metric() { 10_000.0 } else { 43_560.0 };
        tokens[3] = format!("{a:.4}");
        tokens[5] = format!("{:.1}", (a * per_area).sqrt());
    }
    tx.append(&SectionKind::Subcatchments, &tokens);
    let t = new_tokens(tx, &SectionKind::Subareas, &[&id]);
    tx.append(&SectionKind::Subareas, &t);
    let t = new_tokens(tx, &SectionKind::Infiltration, &[&id]);
    tx.append(&SectionKind::Infiltration, &t);
    set_geometry(tx, ObjKind::Subcatchment, &id, polygon, decimals)?;
    Ok(id)
}

pub fn add_gage(tx: &mut Tx, net: &Network, xy: [f64; 2], decimals: usize) -> EditResult<String> {
    let id = new_id(net, "RG");
    let ts = refs::names(tx.inp(), RefKind::Timeseries).into_iter().next().unwrap_or_else(|| "*".into());
    let mut tokens = new_tokens(tx, &SectionKind::Raingages, &[&id]);
    if let Some(last) = tokens.last_mut() {
        *last = ts;
    }
    tx.append(&SectionKind::Raingages, &tokens);
    set_geometry(tx, ObjKind::Gage, &id, &[xy], decimals)?;
    Ok(id)
}

/// Sets `[OPTIONS]` values; an empty value removes the option.
pub fn set_options(tx: &mut Tx, values: &[(String, String)]) -> EditResult<()> {
    for (key, value) in values {
        let key = key.trim().to_ascii_uppercase();
        let value = value.trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            return Err(format!("invalid option name {key:?}"));
        }
        if value.contains('"') {
            return Err(format!("{key}: double quotes are not allowed"));
        }
        // The last line wins, as in InpFile::option.
        let at = tx.inp().sections().iter().enumerate().filter(|(_, s)| *s.kind() == SectionKind::Options).fold(
            None,
            |acc, (si, s)| {
                s.data()
                    .filter(|(_, l)| l.token(0).is_some_and(|k| k.eq_ignore_ascii_case(&key)))
                    .last()
                    .map(|(li, _)| (si, li))
                    .or(acc)
            },
        );
        match (at, value.is_empty()) {
            (Some((s, l)), true) => tx.remove_line(s, l),
            (Some((s, l)), false) => {
                let mut line = tx.inp().sections()[s].lines()[l].clone();
                if line.to_vec()[1..].join(" ") == value {
                    continue;
                }
                if line.len() == 2 && !value.contains(' ') {
                    line.set_token(1, value);
                } else {
                    let k = line.token(0).unwrap_or(&key).to_string();
                    let mut t = vec![k];
                    t.extend(value.split_whitespace().map(str::to_string));
                    line.set_tokens(&t);
                }
                tx.replace_line(s, l, line);
            }
            (None, true) => {}
            (None, false) => {
                let mut t = vec![key.clone()];
                t.extend(value.split_whitespace().map(str::to_string));
                tx.append(&SectionKind::Options, &t);
            }
        }
    }
    Ok(())
}

/// Text of the `[TITLE]` section (comment lines excluded).
pub fn title(inp: &InpFile) -> String {
    inp.section(&SectionKind::Title)
        .map(|s| s.data().map(|(_, l)| l.text().to_string()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// Replaces the text lines of `[TITLE]`, keeping its comment lines.
pub fn set_title(tx: &mut Tx, text: &str) -> EditResult<()> {
    if text.lines().any(|l| l.trim_start().starts_with('[')) {
        return Err("a title line cannot start with '['".into());
    }
    let s = tx.ensure_section(&SectionKind::Title);
    let ending = tx.inp().line_ending();
    let old: Vec<usize> = tx.inp().sections()[s].data().map(|(i, _)| i).collect();
    let at = old.first().copied().unwrap_or_else(|| {
        // After the leading comments.
        let lines = tx.inp().sections()[s].lines();
        lines.iter().position(|l| l.kind() != LineKind::Comment).unwrap_or(lines.len())
    });
    for &i in old.iter().rev() {
        tx.remove_line(s, i);
    }
    let lines: Vec<Line> =
        text.lines().filter(|l| !l.trim().is_empty()).map(|l| Line::from_text(l.trim_end(), ending, true)).collect();
    tx.splice(s, at, 0, lines);
    Ok(())
}

/// Assigns a unit hydrograph (and optionally a sewershed area) to nodes, adding their
/// `[RDII]` line where missing. Returns the number of nodes changed.
pub fn assign_rdii(tx: &mut Tx, nodes: &[String], hydrograph: &str, area: Option<&str>) -> EditResult<usize> {
    check_id(hydrograph).map_err(|e| format!("unit hydrograph: {e}"))?;
    if let Some(a) = area {
        let x: f64 = a.trim().parse().map_err(|_| format!("sewershed area: {a:?} is not a number"))?;
        if x.is_nan() || x < 0.0 {
            return Err("the sewershed area must be positive".into());
        }
    }
    let index = line_index(tx.inp(), &SectionKind::Rdii);
    let mut n = 0;
    for node in nodes {
        match index.get(&node.to_ascii_uppercase()) {
            Some(&at) => {
                set_field_at(tx, &SectionKind::Rdii, at, 1, hydrograph)?;
                if let Some(a) = area {
                    set_field_at(tx, &SectionKind::Rdii, at, 2, a)?;
                }
            }
            None => {
                tx.append(&SectionKind::Rdii, &[node.as_str(), hydrograph, area.unwrap_or("0").trim()]);
            }
        }
        n += 1;
    }
    Ok(n)
}

/// Removes the `[RDII]` lines of nodes. Returns how many were removed.
pub fn remove_rdii(tx: &mut Tx, nodes: &[String]) -> usize {
    let set: HashSet<String> = nodes.iter().map(|n| n.to_ascii_uppercase()).collect();
    let mut at = Vec::new();
    for (si, s) in tx.inp().sections().iter().enumerate().filter(|(_, s)| *s.kind() == SectionKind::Rdii) {
        for (li, l) in s.data() {
            if l.token(0).is_some_and(|t| set.contains(&t.to_ascii_uppercase())) {
                at.push((si, li));
            }
        }
    }
    for &(s, l) in at.iter().rev() {
        tx.remove_line(s, l);
    }
    at.len()
}

/// Whether a field type refers to an object kind (for "used by" and pickers).
pub fn field_ref(ty: &FieldType) -> Option<RefKind> {
    match ty {
        FieldType::Ref { to } => Some(*to),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::History;

    const SRC: &str = "\
[OPTIONS]
FLOW_UNITS LPS
INFILTRATION HORTON

[RAINGAGES]
RG1 INTENSITY 0:05 1.0 TIMESERIES TS1

[SUBCATCHMENTS]
S1 RG1 J1 2.5 60 150 1.5 0

[SUBAREAS]
S1 0.013 0.15 1.5 5 25 OUTLET

[JUNCTIONS]
;;Name Elev
J1   100.0   2.5   0 0 0
J2   99.0    2.5   0 0 0

[OUTFALLS]
O1 97 FREE NO

[CONDUITS]
C1 J1 J2 120 0.013 0 0
C2 J2 O1 50 0.013 0 0

[XSECTIONS]
C1 CIRCULAR 0.4 0 0 0 1
C2 CIRCULAR 0.5 0 0 0 1

[DWF]
J1 FLOW 1.5

[RDII]
J2 UH1 10

[REPORT]
NODES J1 J2

[TAGS]
Node J1 main

[COORDINATES]
J1 0 0
J2 10 0
O1 20 0

[VERTICES]
C2 15 1
";

    fn run<T>(inp: &mut InpFile, h: &mut History, f: impl FnOnce(&mut Tx) -> EditResult<T>) -> EditResult<T> {
        h.edit(inp, "t", f).map(|a| a.value)
    }

    #[test]
    fn field_edits_keep_spacing() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        run(&mut inp, &mut h, |tx| set_field(tx, &SectionKind::Junctions, &["j1".into()], 1, "101.5")).unwrap();
        assert!(inp.to_string_lossy().contains("J1   101.5   2.5   0 0 0\n"));
        let e = run(&mut inp, &mut h, |tx| set_field(tx, &SectionKind::Junctions, &["J1".into()], 2, "-1"));
        assert!(e.is_err());
        run(&mut inp, &mut h, |tx| set_field(tx, &SectionKind::Outfalls, &["O1".into()], 2, "fixed")).unwrap();
        assert!(inp.to_string_lossy().contains("O1               97         FIXED      0          NO\n"));
        let n = run(&mut inp, &mut h, |tx| {
            set_field_bulk(tx, &SectionKind::Conduits, &["C1".into(), "C2".into(), "X".into()], "n", "0.015")
        })
        .unwrap();
        assert_eq!(n, 2);
        assert!(inp.to_string_lossy().contains("C2 J2 O1 50 0.015 0 0"));
        run(&mut inp, &mut h, |tx| add_line(tx, &SectionKind::Rdii, &["J1".into()])).unwrap();
        assert!(inp.to_string_lossy().contains("J1               *          0\n"));
        run(&mut inp, &mut h, |tx| remove_line(tx, &SectionKind::Dwf, &["J1".into(), "FLOW".into()])).unwrap();
        assert!(!inp.to_string_lossy().contains("J1 FLOW 1.5"));
        while h.undo(&mut inp).is_some() {}
        assert_eq!(inp.to_string_lossy(), SRC);
    }

    #[test]
    fn rename_updates_references() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "J1", "N1")).unwrap();
        let t = inp.to_string_lossy();
        for s in ["S1 RG1 N1", "N1   100.0", "C1 N1 J2", "N1 FLOW 1.5", "NODES N1 J2", "Node N1 main", "N1 0 0"] {
            assert!(t.contains(s), "{s} in {t}");
        }
        assert!(run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "N1", "j2")).unwrap_err().contains("already"));
        assert!(run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "N1", "a b")).is_err());
    }

    #[test]
    fn delete_cascades() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let net = Network::from_inp(&inp);
        let j2 = net.find_ref(ObjKind::Node, "J2").unwrap();
        let plan = delete_plan(&inp, &net, &[j2]);
        assert_eq!(plan.nodes, ["J2"]);
        assert_eq!(plan.cascade_links, ["C1", "C2"]);
        assert_eq!(plan.cleared, ["[REPORT] NODES"]);
        run(&mut inp, &mut h, |tx| delete(tx, &net, &[j2])).unwrap();
        let t = inp.to_string_lossy();
        assert!(!t.contains("J2"), "{t}");
        assert!(!t.contains("C1 ") && !t.contains("C2 "), "{t}");
        assert!(t.contains("NODES            J1\n"), "{t}");
        // Deleting the outlet node of a subcatchment clears the reference.
        let net = Network::from_inp(&inp);
        let j1 = net.find_ref(ObjKind::Node, "J1").unwrap();
        run(&mut inp, &mut h, |tx| delete(tx, &net, &[j1])).unwrap();
        let t = inp.to_string_lossy();
        assert!(t.contains("S1               RG1        *          2.5"), "{t}");
        assert!(!t.contains("[REPORT]\nNODES"), "{t}");
        while h.undo(&mut inp).is_some() {}
        assert_eq!(inp.to_string_lossy(), SRC);
    }

    #[test]
    fn add_objects() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let net = Network::from_inp(&inp);
        let j = run(&mut inp, &mut h, |tx| add_node(tx, &net, NodeType::Junction, [5.0, 5.0], 3)).unwrap();
        assert_eq!(j, "J3");
        let net = Network::from_inp(&inp);
        let c = run(&mut inp, &mut h, |tx| {
            add_link(tx, &net, LinkType::Conduit, ["J3", "O1"], &[[7.0, 6.0]], Some(18.234), 3)
        })
        .unwrap();
        assert_eq!(c, "C3");
        let net = Network::from_inp(&inp);
        let s = run(&mut inp, &mut h, |tx| {
            add_subcatchment(tx, &net, &[[0.0, 10.0], [10.0, 10.0], [10.0, 20.0]], Some("J3"), Some(0.005), 3)
        })
        .unwrap();
        let g = run(&mut inp, &mut h, |tx| add_gage(tx, &net, [1.0, 1.0], 3)).unwrap();
        assert_eq!((s.as_str(), g.as_str()), ("S2", "RG2"));
        let t = inp.to_string_lossy();
        for want in [
            "J3               0          0          0          0          0\n",
            "C3               J3         O1         18.23      0.01       0          0          0          0\n",
            "C3               CIRCULAR   1          0          0          0          1\n",
            "C3               7.000      6.000\n",
            "S2               RG1        J3         0.0050     25         7.1        0.5        0\n",
            "S2               0.01       0.1        0.05       0.05       25         OUTLET     100\n",
            "S2               3          0.5        4          7          0\n",
            "J3               5.000      5.000\n",
            "RG2              INTENSITY  1:00       1.0        TIMESERIES *\n",
            "[SYMBOLS]\nRG2              1.000      1.000\n",
        ] {
            assert!(t.contains(want), "{want:?} not in\n{t}");
        }
        let net = Network::from_inp(&inp);
        assert_eq!(net.nodes.len(), 4);
        assert_eq!(net.links[2].vertices, vec![[7.0, 6.0]]);
        assert!(run(&mut inp, &mut h, |tx| add_link(tx, &net, LinkType::Pump, ["J3", "j3"], &[], None, 3)).is_err());
    }

    #[test]
    fn geometry_options_title_rdii() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        run(&mut inp, &mut h, |tx| set_geometry(tx, ObjKind::Link, "C2", &[[12.0, 2.0], [16.0, 2.5]], 2)).unwrap();
        assert!(inp
            .to_string_lossy()
            .contains("[VERTICES]\nC2               12.00      2.00\nC2               16.00      2.50\n"));
        run(&mut inp, &mut h, |tx| set_geometry(tx, ObjKind::Link, "C2", &[], 2)).unwrap();
        assert!(!inp.to_string_lossy().contains("C2               12.00"));
        run(&mut inp, &mut h, |tx| {
            set_options(
                tx,
                &[
                    ("flow_units".into(), "CMS".into()),
                    ("INFILTRATION".into(), "".into()),
                    ("THREADS".into(), "4".into()),
                ],
            )
        })
        .unwrap();
        assert_eq!(inp.option("FLOW_UNITS").as_deref(), Some("CMS"));
        assert_eq!(inp.option("INFILTRATION"), None);
        assert_eq!(inp.option("THREADS").as_deref(), Some("4"));
        run(&mut inp, &mut h, |tx| set_title(tx, "My model\nsecond line\n")).unwrap();
        assert_eq!(title(&inp), "My model\nsecond line");
        assert!(inp.to_string_lossy().starts_with("[TITLE]\nMy model\nsecond line\n\n[OPTIONS]"));
        let n = run(&mut inp, &mut h, |tx| assign_rdii(tx, &["J1".into(), "J2".into()], "UH9", Some("2.5"))).unwrap();
        assert_eq!(n, 2);
        let t = inp.to_string_lossy();
        assert!(t.contains("J2 UH9 2.5\n") && t.contains("J1               UH9        2.5\n"), "{t}");
        assert_eq!(run(&mut inp, &mut h, |tx| Ok(remove_rdii(tx, &["J2".into()]))).unwrap(), 1);
        while h.undo(&mut inp).is_some() {}
        assert_eq!(inp.to_string_lossy(), SRC);
    }
}
