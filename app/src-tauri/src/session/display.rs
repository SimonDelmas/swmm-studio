//! Map geometry of the network in display coordinates (longitude / latitude with a
//! coordinate system, cartesian offsets without), its spatial index and the binary
//! buffer sent to the map.

use serde::Serialize;
use swmm_geo::{mercator, Crs, Hit, SpatialIndex};
use swmm_model::{LinkType, Network, NodeType, ObjKind, ObjRef, Refresh};

/// Coordinates sent to the map.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Space {
    /// Model coordinates minus `origin` (no CRS: plain cartesian view).
    Cartesian { origin: [f64; 2] },
    /// WGS 84 longitude / latitude.
    LonLat,
}

pub(crate) struct Display {
    pub(crate) space: Space,
    nodes: Vec<[f64; 2]>,
    link_starts: Vec<u32>,
    link_pts: Vec<[f64; 2]>,
    sub_starts: Vec<u32>,
    sub_pts: Vec<[f64; 2]>,
    gages: Vec<[f64; 2]>,
    /// Built in index space: Web Mercator metres (lon/lat) or model units (cartesian).
    index: SpatialIndex,
    pub(crate) bounds: Option<[f64; 4]>,
    /// Points that could not be reprojected.
    pub(crate) unprojected: usize,
}

/// Model coordinates → display coordinates, in place.
fn project(space: Space, crs: Option<&Crs>, pts: &mut [[f64; 2]]) {
    match (crs, space) {
        (Some(c), _) => c.to_lonlat(pts),
        (None, Space::Cartesian { origin }) => pts.iter_mut().for_each(|p| *p = [p[0] - origin[0], p[1] - origin[1]]),
        (None, Space::LonLat) => {}
    }
}

/// Outline of a subcatchment as a closed ring (empty when it has fewer than 3 points).
fn closed_ring(polygon: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if polygon.len() < 3 {
        return Vec::new();
    }
    let mut ring = polygon.to_vec();
    if ring.first() != ring.last() {
        ring.push(ring[0]);
    }
    ring
}

fn layer(kind: ObjKind) -> u8 {
    kind as u8
}

fn kind_of_layer(l: u8) -> ObjKind {
    ObjKind::ALL[l as usize]
}

impl Display {
    /// `origin`: keep the cartesian origin of the previous display (edits must not
    /// shift the view); `None` centres it on the network.
    pub(crate) fn build(net: &Network, crs: Option<&Crs>, origin: Option<[f64; 2]>) -> Display {
        let nan = [f64::NAN; 2];
        let mut nodes: Vec<[f64; 2]> = net.nodes.iter().map(|n| n.xy.unwrap_or(nan)).collect();
        let mut gages: Vec<[f64; 2]> = net.gages.iter().map(|g| g.xy.unwrap_or(nan)).collect();
        let mut link_starts = Vec::with_capacity(net.links.len() + 1);
        let mut link_pts = Vec::with_capacity(net.links.len() * 2);
        link_starts.push(0);
        for i in 0..net.links.len() {
            link_pts.extend(net.link_path(i));
            link_starts.push(link_pts.len() as u32);
        }
        let mut sub_starts = Vec::with_capacity(net.subcatchments.len() + 1);
        let mut sub_pts = Vec::new();
        sub_starts.push(0);
        for s in &net.subcatchments {
            sub_pts.extend(closed_ring(&s.polygon));
            sub_starts.push(sub_pts.len() as u32);
        }
        let space = match (crs, origin) {
            (Some(_), _) => Space::LonLat,
            (None, Some(origin)) => Space::Cartesian { origin },
            (None, None) => {
                let b = net.bounds().unwrap_or([0.0; 4]);
                Space::Cartesian { origin: [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0] }
            }
        };
        let finite = |a: &[[f64; 2]]| a.iter().filter(|p| p[0].is_finite()).count();
        let before = finite(&nodes) + finite(&gages) + finite(&link_pts) + finite(&sub_pts);
        for arr in [&mut nodes, &mut gages, &mut link_pts, &mut sub_pts] {
            project(space, crs, arr);
        }
        let after = finite(&nodes) + finite(&gages) + finite(&link_pts) + finite(&sub_pts);
        let mut d = Display {
            space,
            nodes,
            link_starts,
            link_pts,
            sub_starts,
            sub_pts,
            gages,
            index: SpatialIndex::builder().finish(),
            bounds: None,
            unprojected: before - after,
        };
        let all: Vec<[f64; 2]> = d.nodes.iter().chain(&d.gages).chain(&d.link_pts).chain(&d.sub_pts).copied().collect();
        d.bounds = swmm_geo::bounds(&all);
        let mut b = SpatialIndex::builder();
        for (i, p) in d.nodes.iter().enumerate() {
            b.point(layer(ObjKind::Node), i as u32, d.to_index(*p));
        }
        for (i, p) in d.gages.iter().enumerate() {
            b.point(layer(ObjKind::Gage), i as u32, d.to_index(*p));
        }
        for i in 0..net.links.len() {
            let pts: Vec<_> = d.link(i).iter().map(|p| d.to_index(*p)).collect();
            b.line(layer(ObjKind::Link), i as u32, &pts);
        }
        for i in 0..net.subcatchments.len() {
            let pts: Vec<_> = d.sub(i).iter().map(|p| d.to_index(*p)).collect();
            if pts.len() >= 3 {
                b.polygon(layer(ObjKind::Subcatchment), i as u32, &pts);
            }
        }
        d.index = b.finish();
        d
    }

    /// Model coordinates → display coordinates, in place.
    pub(crate) fn project(&self, crs: Option<&Crs>, pts: &mut [[f64; 2]]) {
        project(self.space, crs, pts)
    }

    /// Display coordinates → model coordinates (`None` if a point cannot be converted).
    pub(crate) fn unproject(&self, crs: Option<&Crs>, pts: &[[f64; 2]]) -> Option<Vec<[f64; 2]>> {
        let mut v = pts.to_vec();
        match (crs, self.space) {
            (Some(c), _) => c.from_lonlat(&mut v),
            (None, Space::Cartesian { origin }) => v.iter_mut().for_each(|p| *p = [p[0] + origin[0], p[1] + origin[1]]),
            (None, Space::LonLat) => {}
        }
        v.iter().all(|p| p[0].is_finite() && p[1].is_finite()).then_some(v)
    }

    /// Display geometry of the objects an edit changed (for the map to update in place),
    /// or `None` when that would be larger than reloading everything.
    pub(crate) fn patch(&self, net: &Network, r: &Refresh) -> Option<GeometryPatch> {
        let pts: usize = r.links.iter().map(|&i| self.link(i as usize).len()).sum::<usize>()
            + r.subcatchments.iter().map(|&i| self.sub(i as usize).len()).sum::<usize>()
            + r.nodes.len()
            + r.gages.len();
        if pts > 20_000 {
            return None;
        }
        let end = |n: Option<u32>| n.unwrap_or(u32::MAX);
        Some(GeometryPatch {
            nodes: r.nodes.iter().map(|&i| (i, self.nodes[i as usize])).collect(),
            gages: r.gages.iter().map(|&i| (i, self.gages[i as usize])).collect(),
            links: r
                .links
                .iter()
                .map(|&i| {
                    let l = &net.links[i as usize];
                    (i, [end(l.from), end(l.to)], self.link(i as usize).to_vec())
                })
                .collect(),
            subcatchments: r
                .subcatchments
                .iter()
                .map(|&i| (i, outlet_of(&net.subcatchments[i as usize]), self.sub(i as usize).to_vec()))
                .collect(),
        })
    }

    /// Display point of a node, if it is drawn.
    pub(crate) fn node_point(&self, i: usize) -> Option<[f64; 2]> {
        self.nodes.get(i).copied().filter(|p| p[0].is_finite())
    }

    pub(crate) fn gage_point(&self, i: usize) -> Option<[f64; 2]> {
        self.gages.get(i).copied().filter(|p| p[0].is_finite())
    }

    /// Updates the objects whose geometry changed after an edit (same object set).
    pub(crate) fn update(&mut self, net: &Network, crs: Option<&Crs>, r: &Refresh) {
        let nan = [f64::NAN; 2];
        for &i in &r.nodes {
            let mut p = [net.nodes[i as usize].xy.unwrap_or(nan)];
            self.project(crs, &mut p);
            self.nodes[i as usize] = p[0];
            let q = self.to_index(p[0]);
            self.index.set_point(layer(ObjKind::Node), i, q);
        }
        for &i in &r.gages {
            let mut p = [net.gages[i as usize].xy.unwrap_or(nan)];
            self.project(crs, &mut p);
            self.gages[i as usize] = p[0];
            let q = self.to_index(p[0]);
            self.index.set_point(layer(ObjKind::Gage), i, q);
        }
        if !r.links.is_empty() {
            let changed: std::collections::HashSet<u32> = r.links.iter().copied().collect();
            let mut starts = Vec::with_capacity(self.link_starts.len());
            let mut pts = Vec::with_capacity(self.link_pts.len() + 8);
            starts.push(0);
            for i in 0..net.links.len() {
                if changed.contains(&(i as u32)) {
                    let mut p = net.link_path(i);
                    self.project(crs, &mut p);
                    pts.extend(p);
                } else {
                    pts.extend_from_slice(self.link(i));
                }
                starts.push(pts.len() as u32);
            }
            (self.link_starts, self.link_pts) = (starts, pts);
            for &i in &r.links {
                let ip: Vec<_> = self.link(i as usize).iter().map(|p| self.to_index(*p)).collect();
                self.index.set_line(layer(ObjKind::Link), i, &ip);
            }
        }
        if !r.subcatchments.is_empty() {
            let changed: std::collections::HashSet<u32> = r.subcatchments.iter().copied().collect();
            let mut starts = Vec::with_capacity(self.sub_starts.len());
            let mut pts = Vec::with_capacity(self.sub_pts.len() + 8);
            starts.push(0);
            for (i, s) in net.subcatchments.iter().enumerate() {
                if changed.contains(&(i as u32)) {
                    let mut p = closed_ring(&s.polygon);
                    self.project(crs, &mut p);
                    pts.extend(p);
                } else {
                    pts.extend_from_slice(self.sub(i));
                }
                starts.push(pts.len() as u32);
            }
            (self.sub_starts, self.sub_pts) = (starts, pts);
            for &i in &r.subcatchments {
                let ip: Vec<_> = self.sub(i as usize).iter().map(|p| self.to_index(*p)).collect();
                self.index.set_polygon(layer(ObjKind::Subcatchment), i, &ip);
            }
        }
        let all: Vec<[f64; 2]> =
            self.nodes.iter().chain(&self.gages).chain(&self.link_pts).chain(&self.sub_pts).copied().collect();
        self.bounds = swmm_geo::bounds(&all);
    }

    fn link(&self, i: usize) -> &[[f64; 2]] {
        &self.link_pts[self.link_starts[i] as usize..self.link_starts[i + 1] as usize]
    }

    fn sub(&self, i: usize) -> &[[f64; 2]] {
        &self.sub_pts[self.sub_starts[i] as usize..self.sub_starts[i + 1] as usize]
    }

    /// Display coordinates → index space.
    fn to_index(&self, p: [f64; 2]) -> [f64; 2] {
        match self.space {
            Space::LonLat if p[0].is_finite() => mercator::from_lonlat(p),
            _ => p,
        }
    }
}

/// New display geometry of some objects (NaN coordinates are sent as `null`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GeometryPatch {
    pub nodes: Vec<(u32, [f64; 2])>,
    pub gages: Vec<(u32, [f64; 2])>,
    /// Link index, from/to node indices (`u32::MAX` when unknown), path.
    pub links: Vec<(u32, [u32; 2], Vec<[f64; 2]>)>,
    /// Subcatchment index, outlet (see [`outlet_of`]), closed ring (empty when the
    /// subcatchment has no outline).
    pub subcatchments: Vec<(u32, [u32; 2], Vec<[f64; 2]>)>,
}

/// Outlet of a subcatchment as (kind, index): kind 0 for a node, 1 for a subcatchment;
/// `u32::MAX` for both when it has none.
pub(crate) fn outlet_of(s: &swmm_model::Subcatchment) -> [u32; 2] {
    match s.outlet {
        Some(ObjRef { kind: ObjKind::Node, index }) => [0, index],
        Some(ObjRef { kind: ObjKind::Subcatchment, index }) => [1, index],
        _ => [u32::MAX; 2],
    }
}

fn hit_ref(h: Hit) -> ObjRef {
    ObjRef { kind: kind_of_layer(h.layer), index: h.index }
}

/// Picking and selection, in display coordinates.
impl Display {
    /// Closest object to a point, within `tol` index units (Web Mercator metres or
    /// model units).
    pub(crate) fn pick(&self, p: [f64; 2], tol: f64) -> Option<ObjRef> {
        self.index.nearest(self.to_index(p), tol).map(hit_ref)
    }

    pub(crate) fn in_rect(&self, a: [f64; 2], b: [f64; 2]) -> Vec<ObjRef> {
        self.index.in_rect(self.to_index(a), self.to_index(b)).into_iter().map(hit_ref).collect()
    }

    pub(crate) fn in_polygon(&self, ring: &[[f64; 2]]) -> Vec<ObjRef> {
        let ring: Vec<_> = ring.iter().map(|p| self.to_index(*p)).collect();
        self.index.in_polygon(&ring).into_iter().map(hit_ref).collect()
    }
}

/// Magic number of the geometry buffer; the UI checks it (`decodeGeometry`).
const GEOMETRY_MAGIC: &[u8; 4] = b"SWG2";

impl Display {
    /// Geometry for the map, as one little-endian buffer:
    ///
    /// ```text
    /// 0   "SWG2"
    /// 4   u32 space (0 cartesian, 1 lon/lat)
    /// 8   f64 origin x, f64 origin y
    /// 24  u32 nodes, links, link points, subcatchments, subcatchment points, gages
    /// 48  padding to 64
    /// 64  f64 xy: nodes, link points, subcatchment points (closed rings), gages
    ///     u32 link starts (links + 1), subcatchment starts (subcatchments + 1)
    ///     u32 link end nodes (from, to per link; u32::MAX when unknown)
    ///     u32 subcatchment outlets (kind, index per subcatchment; see `outlet_of`)
    ///     u8 node types, link types
    /// ```
    pub(crate) fn encode(&self, net: &Network) -> Vec<u8> {
        let d = self;
        let mut b = Vec::with_capacity(64 + 16 * (d.nodes.len() + d.link_pts.len() + d.sub_pts.len()));
        b.extend_from_slice(GEOMETRY_MAGIC);
        let (space, origin) = match d.space {
            Space::Cartesian { origin } => (0u32, origin),
            Space::LonLat => (1, [0.0, 0.0]),
        };
        b.extend_from_slice(&space.to_le_bytes());
        b.extend_from_slice(&origin[0].to_le_bytes());
        b.extend_from_slice(&origin[1].to_le_bytes());
        for n in [
            d.nodes.len(),
            d.link_starts.len() - 1,
            d.link_pts.len(),
            d.sub_starts.len() - 1,
            d.sub_pts.len(),
            d.gages.len(),
        ] {
            b.extend_from_slice(&(n as u32).to_le_bytes());
        }
        b.resize(64, 0);
        for p in d.nodes.iter().chain(&d.link_pts).chain(&d.sub_pts).chain(&d.gages) {
            b.extend_from_slice(&p[0].to_le_bytes());
            b.extend_from_slice(&p[1].to_le_bytes());
        }
        for s in d.link_starts.iter().chain(&d.sub_starts) {
            b.extend_from_slice(&s.to_le_bytes());
        }
        for l in &net.links {
            b.extend_from_slice(&l.from.unwrap_or(u32::MAX).to_le_bytes());
            b.extend_from_slice(&l.to.unwrap_or(u32::MAX).to_le_bytes());
        }
        for o in net.subcatchments.iter().flat_map(outlet_of) {
            b.extend_from_slice(&o.to_le_bytes());
        }
        b.extend(net.nodes.iter().map(|n| match n.kind {
            NodeType::Junction => 0u8,
            NodeType::Outfall => 1,
            NodeType::Divider => 2,
            NodeType::Storage => 3,
        }));
        b.extend(net.links.iter().map(|l| match l.kind {
            LinkType::Conduit => 0u8,
            LinkType::Pump => 1,
            LinkType::Orifice => 2,
            LinkType::Weir => 3,
            LinkType::Outlet => 4,
        }));
        b
    }
}
