//! New objects and their map geometry.

use swmm_inp::SectionKind;

use crate::edit::{EditResult, Tx};
use crate::refs;
use crate::schema::{self, Context, RefKind};
use crate::tables::replace_object_lines;
use crate::{LinkType, Network, NodeType, ObjKind, ObjRef};

pub(super) fn fmt_coord(x: f64, decimals: usize) -> String {
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

pub(super) fn new_tokens(tx: &Tx, kind: &SectionKind, key: &[&str]) -> Vec<String> {
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
