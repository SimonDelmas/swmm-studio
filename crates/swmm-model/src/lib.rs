//! Network view of an EPA SWMM model, built from an [`InpFile`], and its editing.
//!
//! [`Network`] lists the visible objects (nodes, links, subcatchments, rain gages) with
//! their connectivity and map geometry in model coordinates. The `.inp` stays the
//! source of truth for attribute values: [`properties`] reads them from the file with
//! named fields, and [`attributes`] extracts numeric columns for thematic maps.
//!
//! Editing: [`edit`] (undoable transactions on the file), [`ops`] (operations such as
//! renaming or deleting with cascade), [`schema`] (field layouts, units, validation),
//! [`refs`] (where names are used), [`tables`] (curves, time series, patterns, unit
//! hydrographs, transects). After an edit, [`Network::refresh`] updates the network
//! from the changed lines.

mod attributes;
pub mod climate;
pub mod edit;
pub mod grid;
pub mod ops;
mod properties;
pub mod refs;
pub mod schema;
pub mod tables;
pub mod validate;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use swmm_inp::{InpFile, Line, SectionKind};

pub use attributes::{attribute, attribute_names};
pub use properties::{addable, properties, Addable, Field, PropertyGroup};

/// Category of a map object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjKind {
    Node,
    Link,
    Subcatchment,
    Gage,
}

impl ObjKind {
    pub const ALL: [ObjKind; 4] = [ObjKind::Node, ObjKind::Link, ObjKind::Subcatchment, ObjKind::Gage];

    pub fn name(self) -> &'static str {
        match self {
            ObjKind::Node => "node",
            ObjKind::Link => "link",
            ObjKind::Subcatchment => "subcatchment",
            ObjKind::Gage => "gage",
        }
    }

    pub fn from_name(s: &str) -> Option<ObjKind> {
        ObjKind::ALL.into_iter().find(|k| k.name().eq_ignore_ascii_case(s))
    }
}

/// An object of the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ObjRef {
    pub kind: ObjKind,
    pub index: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    Junction,
    Outfall,
    Divider,
    Storage,
}

impl NodeType {
    pub fn section(self) -> SectionKind {
        match self {
            NodeType::Junction => SectionKind::Junctions,
            NodeType::Outfall => SectionKind::Outfalls,
            NodeType::Divider => SectionKind::Dividers,
            NodeType::Storage => SectionKind::Storage,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkType {
    Conduit,
    Pump,
    Orifice,
    Weir,
    Outlet,
}

impl LinkType {
    pub fn section(self) -> SectionKind {
        match self {
            LinkType::Conduit => SectionKind::Conduits,
            LinkType::Pump => SectionKind::Pumps,
            LinkType::Orifice => SectionKind::Orifices,
            LinkType::Weir => SectionKind::Weirs,
            LinkType::Outlet => SectionKind::Outlets,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: String,
    pub kind: NodeType,
    /// From `[COORDINATES]`; `None` if the node is not drawn.
    pub xy: Option<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub id: String,
    pub kind: LinkType,
    pub from: Option<u32>,
    pub to: Option<u32>,
    /// Intermediate points from `[VERTICES]`.
    pub vertices: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Subcatchment {
    pub id: String,
    /// Node or subcatchment receiving the runoff.
    pub outlet: Option<ObjRef>,
    pub gage: Option<u32>,
    /// Outline from `[POLYGONS]` (possibly empty).
    pub polygon: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gage {
    pub id: String,
    /// From `[SYMBOLS]`.
    pub xy: Option<[f64; 2]>,
}

/// What [`Network::refresh`] changed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Refresh {
    /// The network was rebuilt: indices may differ from before the edit.
    pub rebuilt: bool,
    /// Objects whose map geometry changed (links attached to moved nodes included,
    /// re-routed subcatchments: the map draws their outlet).
    pub nodes: Vec<u32>,
    pub links: Vec<u32>,
    pub subcatchments: Vec<u32>,
    pub gages: Vec<u32>,
}

impl Refresh {
    pub fn geometry_changed(&self) -> bool {
        self.rebuilt
            || !(self.nodes.is_empty()
                && self.links.is_empty()
                && self.subcatchments.is_empty()
                && self.gages.is_empty())
    }
}

/// Objects of the model, in `.inp` order within each category.
#[derive(Debug, Clone, Default)]
pub struct Network {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    pub subcatchments: Vec<Subcatchment>,
    pub gages: Vec<Gage>,
    ids: [HashMap<String, u32>; 4],
}

/// SWMM compares IDs without case.
fn key(id: &str) -> String {
    id.to_ascii_uppercase()
}

fn coord(l: &Line, i: usize) -> Option<[f64; 2]> {
    let x: f64 = l.token(i)?.parse().ok()?;
    let y: f64 = l.token(i + 1)?.parse().ok()?;
    (x.is_finite() && y.is_finite()).then_some([x, y])
}

impl Network {
    pub fn from_inp(inp: &InpFile) -> Network {
        let mut net = Network::default();
        for (kind, ty) in [
            (SectionKind::Junctions, NodeType::Junction),
            (SectionKind::Outfalls, NodeType::Outfall),
            (SectionKind::Dividers, NodeType::Divider),
            (SectionKind::Storage, NodeType::Storage),
        ] {
            for l in inp.rows(&kind) {
                if let Some(id) = l.token(0) {
                    if net.insert(ObjKind::Node, id) {
                        net.nodes.push(Node { id: id.to_string(), kind: ty, xy: None });
                    }
                }
            }
        }
        for (kind, ty) in [
            (SectionKind::Conduits, LinkType::Conduit),
            (SectionKind::Pumps, LinkType::Pump),
            (SectionKind::Orifices, LinkType::Orifice),
            (SectionKind::Weirs, LinkType::Weir),
            (SectionKind::Outlets, LinkType::Outlet),
        ] {
            for l in inp.rows(&kind) {
                if let Some(id) = l.token(0) {
                    if net.insert(ObjKind::Link, id) {
                        let from = l.token(1).and_then(|n| net.find(ObjKind::Node, n));
                        let to = l.token(2).and_then(|n| net.find(ObjKind::Node, n));
                        net.links.push(Link { id: id.to_string(), kind: ty, from, to, vertices: Vec::new() });
                    }
                }
            }
        }
        for l in inp.rows(&SectionKind::Raingages) {
            if let Some(id) = l.token(0) {
                if net.insert(ObjKind::Gage, id) {
                    net.gages.push(Gage { id: id.to_string(), xy: None });
                }
            }
        }
        let mut outlets = Vec::new();
        for l in inp.rows(&SectionKind::Subcatchments) {
            if let Some(id) = l.token(0) {
                if net.insert(ObjKind::Subcatchment, id) {
                    let gage = l.token(1).and_then(|g| net.find(ObjKind::Gage, g));
                    outlets.push(l.token(2).map(str::to_string));
                    net.subcatchments.push(Subcatchment {
                        id: id.to_string(),
                        outlet: None,
                        gage,
                        polygon: Vec::new(),
                    });
                }
            }
        }
        // Outlets may be subcatchments defined further down.
        for (i, o) in outlets.into_iter().enumerate() {
            net.subcatchments[i].outlet =
                o.and_then(|o| net.find_ref(ObjKind::Node, &o).or_else(|| net.find_ref(ObjKind::Subcatchment, &o)));
        }
        for l in inp.rows(&SectionKind::Coordinates) {
            if let (Some(i), Some(p)) = (l.token(0).and_then(|n| net.find(ObjKind::Node, n)), coord(l, 1)) {
                net.nodes[i as usize].xy = Some(p);
            }
        }
        for l in inp.rows(&SectionKind::Vertices) {
            if let (Some(i), Some(p)) = (l.token(0).and_then(|n| net.find(ObjKind::Link, n)), coord(l, 1)) {
                net.links[i as usize].vertices.push(p);
            }
        }
        for l in inp.rows(&SectionKind::Polygons) {
            if let (Some(i), Some(p)) = (l.token(0).and_then(|n| net.find(ObjKind::Subcatchment, n)), coord(l, 1)) {
                net.subcatchments[i as usize].polygon.push(p);
            }
        }
        for l in inp.rows(&SectionKind::Symbols) {
            if let (Some(i), Some(p)) = (l.token(0).and_then(|n| net.find(ObjKind::Gage, n)), coord(l, 1)) {
                net.gages[i as usize].xy = Some(p);
            }
        }
        net
    }

    /// Registers an ID; `false` if it is a duplicate (the first definition wins, like SWMM).
    fn insert(&mut self, kind: ObjKind, id: &str) -> bool {
        let n = self.len(kind) as u32;
        match self.ids[kind as usize].entry(key(id)) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(n);
                true
            }
        }
    }

    pub fn len(&self, kind: ObjKind) -> usize {
        match kind {
            ObjKind::Node => self.nodes.len(),
            ObjKind::Link => self.links.len(),
            ObjKind::Subcatchment => self.subcatchments.len(),
            ObjKind::Gage => self.gages.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        ObjKind::ALL.iter().all(|k| self.len(*k) == 0)
    }

    /// Index of an object by ID (case-insensitive).
    pub fn find(&self, kind: ObjKind, id: &str) -> Option<u32> {
        self.ids[kind as usize].get(&key(id)).copied()
    }

    pub fn find_ref(&self, kind: ObjKind, id: &str) -> Option<ObjRef> {
        self.find(kind, id).map(|index| ObjRef { kind, index })
    }

    /// Object of any kind with this ID (nodes first, then links, subcatchments, gages).
    pub fn find_any(&self, id: &str) -> Option<ObjRef> {
        ObjKind::ALL.into_iter().find_map(|k| self.find_ref(k, id))
    }

    pub fn id(&self, r: ObjRef) -> &str {
        let i = r.index as usize;
        match r.kind {
            ObjKind::Node => &self.nodes[i].id,
            ObjKind::Link => &self.links[i].id,
            ObjKind::Subcatchment => &self.subcatchments[i].id,
            ObjKind::Gage => &self.gages[i].id,
        }
    }

    /// Polyline of a link in model coordinates: start node, vertices, end node (nodes
    /// without coordinates are skipped).
    pub fn link_path(&self, i: usize) -> Vec<[f64; 2]> {
        let l = &self.links[i];
        let node_xy = |n: Option<u32>| n.and_then(|n| self.nodes[n as usize].xy);
        let mut path = Vec::with_capacity(l.vertices.len() + 2);
        path.extend(node_xy(l.from));
        path.extend_from_slice(&l.vertices);
        path.extend(node_xy(l.to));
        path
    }

    /// Bounding box of everything drawn, in model coordinates.
    pub fn bounds(&self) -> Option<[f64; 4]> {
        let pts = self
            .nodes
            .iter()
            .filter_map(|n| n.xy)
            .chain(self.gages.iter().filter_map(|g| g.xy))
            .chain(self.links.iter().flat_map(|l| l.vertices.iter().copied()))
            .chain(self.subcatchments.iter().flat_map(|s| s.polygon.iter().copied()));
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in pts {
            b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        }
        b[0].is_finite().then_some(b)
    }

    /// Updates the network after an edit of `inp` that changed these lines.
    ///
    /// Value edits leave it as is; moved points, new vertices and reconnected links are
    /// updated in place; when objects are added, removed or renamed the network is
    /// rebuilt (indices may then change).
    pub fn refresh(&mut self, inp: &InpFile, changes: &[edit::Change]) -> Refresh {
        let mut geo: [HashSet<String>; 4] = Default::default();
        let mut structural: [HashSet<String>; 4] = Default::default();
        let up = |l: &Line, i: usize| l.token(i).unwrap_or("").to_ascii_uppercase();
        for c in changes {
            let defining: Option<(ObjKind, &[usize])> = match c.kind {
                SectionKind::Junctions | SectionKind::Outfalls | SectionKind::Dividers | SectionKind::Storage => {
                    Some((ObjKind::Node, &[0]))
                }
                SectionKind::Conduits
                | SectionKind::Pumps
                | SectionKind::Orifices
                | SectionKind::Weirs
                | SectionKind::Outlets => Some((ObjKind::Link, &[0, 1, 2])),
                SectionKind::Subcatchments => Some((ObjKind::Subcatchment, &[0, 1, 2])),
                SectionKind::Raingages => Some((ObjKind::Gage, &[0])),
                _ => None,
            };
            if let Some((k, pos)) = defining {
                let key = |l: &Line| pos.iter().map(|&i| up(l, i)).collect::<Vec<_>>();
                let mut a: Vec<Vec<String>> = c.removed.iter().filter(|l| l.is_data()).map(key).collect();
                let mut b: Vec<Vec<String>> = c.inserted.iter().filter(|l| l.is_data()).map(key).collect();
                let mut ia: Vec<&String> = a.iter().map(|v| &v[0]).collect();
                let mut ib: Vec<&String> = b.iter().map(|v| &v[0]).collect();
                ia.sort();
                ib.sort();
                if ia != ib {
                    *self = Network::from_inp(inp);
                    return Refresh { rebuilt: true, ..Refresh::default() };
                }
                a.sort();
                b.sort();
                if a != b {
                    structural[k as usize].extend(b.iter().filter(|v| !a.contains(v)).map(|v| v[0].clone()));
                }
            }
            let geometry = match c.kind {
                SectionKind::Coordinates => Some(ObjKind::Node),
                SectionKind::Vertices => Some(ObjKind::Link),
                SectionKind::Polygons => Some(ObjKind::Subcatchment),
                SectionKind::Symbols => Some(ObjKind::Gage),
                _ => None,
            };
            if let Some(k) = geometry {
                geo[k as usize].extend(c.removed.iter().chain(&c.inserted).filter(|l| l.is_data()).map(|l| up(l, 0)));
            }
        }
        let mut out = Refresh::default();
        // Reconnected links and re-routed subcatchments.
        for id in &structural[ObjKind::Link as usize] {
            let Some(i) = self.find(ObjKind::Link, id) else { continue };
            let section = self.links[i as usize].kind.section();
            let ends = inp.rows(&section).find(|l| up(l, 0) == *id).map(|l| {
                (
                    l.token(1).and_then(|n| self.find(ObjKind::Node, n)),
                    l.token(2).and_then(|n| self.find(ObjKind::Node, n)),
                )
            });
            if let Some((from, to)) = ends {
                let link = &mut self.links[i as usize];
                (link.from, link.to) = (from, to);
                out.links.push(i);
            }
        }
        for id in &structural[ObjKind::Subcatchment as usize] {
            let Some(i) = self.find(ObjKind::Subcatchment, id) else { continue };
            if let Some(l) = inp.rows(&SectionKind::Subcatchments).find(|l| up(l, 0) == *id) {
                let gage = l.token(1).and_then(|g| self.find(ObjKind::Gage, g));
                let outlet = l
                    .token(2)
                    .and_then(|o| self.find_ref(ObjKind::Node, o).or_else(|| self.find_ref(ObjKind::Subcatchment, o)));
                let s = &mut self.subcatchments[i as usize];
                (s.gage, s.outlet) = (gage, outlet);
                out.subcatchments.push(i);
            }
        }
        // Geometry, re-read for the objects whose lines changed.
        for k in ObjKind::ALL {
            let ids = &geo[k as usize];
            if ids.is_empty() {
                continue;
            }
            let mut pts: HashMap<String, Vec<[f64; 2]>> = ids.iter().map(|id| (id.clone(), Vec::new())).collect();
            for l in inp.rows(&ops::geometry_section(k)) {
                if let (Some(v), Some(p)) = (pts.get_mut(&up(l, 0)), coord(l, 1)) {
                    v.push(p);
                }
            }
            for (id, p) in pts {
                let Some(i) = self.find(k, &id) else { continue };
                let iu = i as usize;
                match k {
                    ObjKind::Node => {
                        self.nodes[iu].xy = p.last().copied();
                        out.nodes.push(i);
                    }
                    ObjKind::Gage => {
                        self.gages[iu].xy = p.last().copied();
                        out.gages.push(i);
                    }
                    ObjKind::Link => {
                        self.links[iu].vertices = p;
                        out.links.push(i);
                    }
                    ObjKind::Subcatchment => {
                        self.subcatchments[iu].polygon = p;
                        out.subcatchments.push(i);
                    }
                }
            }
        }
        if !out.nodes.is_empty() {
            let moved: HashSet<u32> = out.nodes.iter().copied().collect();
            for (i, l) in self.links.iter().enumerate() {
                if l.from.is_some_and(|n| moved.contains(&n)) || l.to.is_some_and(|n| moved.contains(&n)) {
                    out.links.push(i as u32);
                }
            }
        }
        for v in [&mut out.nodes, &mut out.links, &mut out.subcatchments, &mut out.gages] {
            v.sort_unstable();
            v.dedup();
        }
        out
    }

    /// Links connected to a node.
    pub fn node_links(&self, node: u32) -> Vec<u32> {
        (0..self.links.len() as u32)
            .filter(|&i| {
                let l = &self.links[i as usize];
                l.from == Some(node) || l.to == Some(node)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const SRC: &str = "\
[OPTIONS]
FLOW_UNITS LPS
INFILTRATION GREEN_AMPT
[RAINGAGES]
RG1 INTENSITY 0:05 1.0 TIMESERIES TS1
[SUBCATCHMENTS]
S1 RG1 J1 2.5 60 150 1.5 0
S2 RG1 S1 1 10 50 1 0
S3 RG9 nowhere 1 10 50 1 0
[SUBAREAS]
S1 0.013 0.15 1.5 5 25 OUTLET
[INFILTRATION]
S1 110 3.5 0.25
[JUNCTIONS]
J1 100 2.5 0 0 0
j2 99 2.5 0 0 0 ;second
[OUTFALLS]
O1 97 FIXED 98.2 NO
J1 1 FREE NO
[STORAGE]
ST1 95 4 0 TABULAR SC1 0 0
[CONDUITS]
C1 J1 J2 120 0.013 0 0 0 0
C2 J2 O1 50 0.013 0 0.1
[PUMPS]
P1 ST1 O1 PC1 ON 1 0.5
[XSECTIONS]
C1 CIRCULAR 0.4 0 0 0 1
C2 CUSTOM 2 SH1 1
[COORDINATES]
J1 0 0
J2 10 0
O1 20 5
ST1 x y
[VERTICES]
C2 15 0
C2 18 2
[POLYGONS]
S1 -5 5
S1 5 5
S1 5 15
[SYMBOLS]
RG1 -10 10
";

    #[test]
    fn builds_network() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        assert_eq!((net.nodes.len(), net.links.len(), net.subcatchments.len(), net.gages.len()), (4, 3, 3, 1));
        // The duplicate outfall J1 is ignored; IDs are case-insensitive.
        assert_eq!(net.find(ObjKind::Node, "J2"), Some(1));
        assert_eq!(net.nodes[2].kind, NodeType::Outfall);
        assert_eq!(net.nodes[3].xy, None);
        let c2 = &net.links[1];
        assert_eq!((c2.from, c2.to, c2.vertices.len()), (Some(1), Some(2), 2));
        assert_eq!(net.link_path(1), vec![[10.0, 0.0], [15.0, 0.0], [18.0, 2.0], [20.0, 5.0]]);
        // Pump from a node without coordinates.
        assert_eq!(net.link_path(2), vec![[20.0, 5.0]]);
        assert_eq!(net.subcatchments[0].outlet, Some(ObjRef { kind: ObjKind::Node, index: 0 }));
        assert_eq!(net.subcatchments[1].outlet, Some(ObjRef { kind: ObjKind::Subcatchment, index: 0 }));
        assert_eq!(net.subcatchments[2].outlet, None);
        assert_eq!(net.subcatchments[2].gage, None);
        assert_eq!(net.subcatchments[0].polygon.len(), 3);
        assert_eq!(net.gages[0].xy, Some([-10.0, 10.0]));
        assert_eq!(net.bounds(), Some([-10.0, 0.0, 20.0, 15.0]));
        assert_eq!(net.find_any("c1"), Some(ObjRef { kind: ObjKind::Link, index: 0 }));
        assert_eq!(net.node_links(1), vec![0, 1]);
    }

    #[test]
    fn refresh_matches_a_rebuild() {
        let mut inp = InpFile::parse_str(SRC);
        let mut net = Network::from_inp(&inp);
        let mut h = edit::History::default();
        let mut check = |inp: &mut InpFile, net: &mut Network, f: &dyn Fn(&mut edit::Tx) -> edit::EditResult<()>| {
            let a = h.edit(inp, "t", f).unwrap();
            let r = net.refresh(inp, &a.changes);
            let fresh = Network::from_inp(inp);
            assert_eq!(net.nodes, fresh.nodes);
            assert_eq!(net.links, fresh.links);
            assert_eq!(net.subcatchments, fresh.subcatchments);
            assert_eq!(net.gages, fresh.gages);
            r
        };
        // Value edit: nothing to do.
        let r = check(&mut inp, &mut net, &|tx| ops::set_field(tx, &SectionKind::Conduits, &["C1".into()], 4, "0.02"));
        assert_eq!(r, Refresh::default());
        // Move a node: it and its links.
        let r = check(&mut inp, &mut net, &|tx| ops::set_geometry(tx, ObjKind::Node, "J2", &[[11.0, 1.0]], 1));
        assert_eq!((r.rebuilt, r.nodes.clone(), r.links.clone()), (false, vec![1], vec![0, 1]));
        // Vertices, reconnection, outlet change.
        let r = check(&mut inp, &mut net, &|tx| ops::set_geometry(tx, ObjKind::Link, "C1", &[[5.0, 5.0]], 1));
        assert_eq!(r.links, vec![0]);
        let r = check(&mut inp, &mut net, &|tx| ops::set_field(tx, &SectionKind::Conduits, &["C1".into()], 2, "O1"));
        assert_eq!((r.rebuilt, r.links.clone()), (false, vec![0]));
        let r =
            check(&mut inp, &mut net, &|tx| ops::set_field(tx, &SectionKind::Subcatchments, &["S2".into()], 2, "J2"));
        assert_eq!((r.rebuilt, r.subcatchments.clone()), (false, vec![1]));
        // Rename rebuilds.
        let r = check(&mut inp, &mut net, &|tx| ops::rename(tx, schema::RefKind::Node, "J2", "N2"));
        assert!(r.rebuilt);
        let r = check(&mut inp, &mut net, &|tx| ops::set_geometry(tx, ObjKind::Gage, "RG1", &[[0.0, 0.0]], 1));
        assert_eq!(r.gages, vec![0]);
    }
}
