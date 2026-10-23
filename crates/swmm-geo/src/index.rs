//! R-tree over points, polylines and polygons, for exact selection queries.
//!
//! Each shape belongs to a *layer* (an object category chosen by the caller, e.g. nodes,
//! links, subcatchments) and carries the caller's object index.

use rstar::primitives::{GeomWithData, Rectangle};
use rstar::{RTree, AABB};

type P = [f64; 2];

/// An object found by a query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hit {
    pub layer: u8,
    pub index: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShapeKind {
    Point,
    Line,
    Polygon,
}

#[derive(Debug, Clone, Copy)]
struct Shape {
    hit: Hit,
    kind: ShapeKind,
    start: u32,
    len: u32,
}

/// Collects shapes, then builds the tree in one bulk load.
#[derive(Default)]
pub struct IndexBuilder {
    coords: Vec<P>,
    shapes: Vec<Shape>,
}

impl IndexBuilder {
    fn push(&mut self, layer: u8, index: u32, kind: ShapeKind, pts: &[P]) {
        let pts: Vec<P> = pts.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
        if pts.is_empty() {
            return;
        }
        let start = self.coords.len() as u32;
        self.coords.extend_from_slice(&pts);
        self.shapes.push(Shape { hit: Hit { layer, index }, kind, start, len: pts.len() as u32 });
    }

    pub fn point(&mut self, layer: u8, index: u32, p: P) {
        self.push(layer, index, ShapeKind::Point, &[p]);
    }

    pub fn line(&mut self, layer: u8, index: u32, pts: &[P]) {
        self.push(layer, index, ShapeKind::Line, pts);
    }

    pub fn polygon(&mut self, layer: u8, index: u32, ring: &[P]) {
        self.push(layer, index, ShapeKind::Polygon, ring);
    }

    pub fn finish(self) -> SpatialIndex {
        let entries = self
            .shapes
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let pts = &self.coords[s.start as usize..(s.start + s.len) as usize];
                let b = crate::bounds(pts).expect("shapes have finite points");
                GeomWithData::new(Rectangle::from_corners([b[0], b[1]], [b[2], b[3]]), i as u32)
            })
            .collect();
        SpatialIndex { coords: self.coords, shapes: self.shapes, tree: RTree::bulk_load(entries) }
    }
}

pub struct SpatialIndex {
    coords: Vec<P>,
    shapes: Vec<Shape>,
    tree: RTree<GeomWithData<Rectangle<P>, u32>>,
}

impl SpatialIndex {
    pub fn builder() -> IndexBuilder {
        IndexBuilder::default()
    }

    pub fn len(&self) -> usize {
        self.shapes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.shapes.is_empty()
    }

    fn pts(&self, s: &Shape) -> &[P] {
        &self.coords[s.start as usize..(s.start + s.len) as usize]
    }

    fn candidates(&self, min: P, max: P) -> impl Iterator<Item = &Shape> + '_ {
        self.tree.locate_in_envelope_intersecting(AABB::from_corners(min, max)).map(|e| &self.shapes[e.data as usize])
    }

    /// Objects touching the rectangle, sorted by layer and index.
    pub fn in_rect(&self, a: P, b: P) -> Vec<Hit> {
        let min = [a[0].min(b[0]), a[1].min(b[1])];
        let max = [a[0].max(b[0]), a[1].max(b[1])];
        let rect = [min, [max[0], min[1]], max, [min[0], max[1]]];
        let inside = |p: &P| p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
        let mut out: Vec<Hit> = self
            .candidates(min, max)
            .filter(|s| self.pts(s).iter().any(inside) || self.touches_polygon(s, &rect))
            .map(|s| s.hit)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Objects touching the (lasso) polygon, sorted by layer and index.
    pub fn in_polygon(&self, ring: &[P]) -> Vec<Hit> {
        let Some(b) = crate::bounds(ring) else {
            return Vec::new();
        };
        if ring.len() < 3 {
            return Vec::new();
        }
        let mut out: Vec<Hit> = self
            .candidates([b[0], b[1]], [b[2], b[3]])
            .filter(|s| self.touches_polygon(s, ring))
            .map(|s| s.hit)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    fn touches_polygon(&self, s: &Shape, ring: &[P]) -> bool {
        let pts = self.pts(s);
        if pts.iter().any(|p| point_in_ring(*p, ring)) {
            return true;
        }
        match s.kind {
            ShapeKind::Point => false,
            ShapeKind::Line => segments(pts, false).any(|(a, b)| segments(ring, true).any(|(c, d)| cross(a, b, c, d))),
            ShapeKind::Polygon => {
                point_in_ring(ring[0], pts)
                    || segments(pts, true).any(|(a, b)| segments(ring, true).any(|(c, d)| cross(a, b, c, d)))
            }
        }
    }

    /// Closest object within `tol` of `p`. Points win over lines, lines over polygons
    /// (a polygon is hit when `p` is inside it).
    pub fn nearest(&self, p: P, tol: f64) -> Option<Hit> {
        let mut best: Option<(u8, f64, Hit)> = None;
        for s in self.candidates([p[0] - tol, p[1] - tol], [p[0] + tol, p[1] + tol]) {
            let pts = self.pts(s);
            let (rank, d) = match s.kind {
                ShapeKind::Point => (0, dist(p, pts[0])),
                ShapeKind::Line => {
                    let d = if pts.len() == 1 {
                        dist(p, pts[0])
                    } else {
                        segments(pts, false).map(|(a, b)| seg_dist(p, a, b)).fold(f64::INFINITY, f64::min)
                    };
                    (1, d)
                }
                ShapeKind::Polygon => (2, if point_in_ring(p, pts) { 0.0 } else { f64::INFINITY }),
            };
            if d <= tol && best.is_none_or(|(r, bd, _)| (rank, d) < (r, bd)) {
                best = Some((rank, d, s.hit));
            }
        }
        best.map(|(_, _, h)| h)
    }
}

fn segments(pts: &[P], closed: bool) -> impl Iterator<Item = (P, P)> + '_ {
    let n = pts.len();
    let m = if closed && n > 2 { n } else { n.saturating_sub(1) };
    (0..m).map(move |i| (pts[i], pts[(i + 1) % n]))
}

fn dist(a: P, b: P) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 {
        return dist(p, a);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0);
    dist(p, [a[0] + t * dx, a[1] + t * dy])
}

fn orient(a: P, b: P, c: P) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Whether segments ab and cd intersect (touching counts).
fn cross(a: P, b: P, c: P, d: P) -> bool {
    let (d1, d2, d3, d4) = (orient(c, d, a), orient(c, d, b), orient(a, b, c), orient(a, b, d));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) {
        return true;
    }
    let on = |p: P, q: P, r: P| {
        orient(p, q, r) == 0.0
            && r[0] >= p[0].min(q[0])
            && r[0] <= p[0].max(q[0])
            && r[1] >= p[1].min(q[1])
            && r[1] <= p[1].max(q[1])
    };
    on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d)
}

/// Even-odd rule; points on the boundary may go either way.
pub fn point_in_ring(p: P, ring: &[P]) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SpatialIndex {
        let mut b = SpatialIndex::builder();
        b.point(0, 0, [0.0, 0.0]);
        b.point(0, 1, [10.0, 0.0]);
        b.point(0, 2, [f64::NAN, 1.0]); // unprojectable: ignored
        b.line(1, 0, &[[0.0, 0.0], [10.0, 0.0]]);
        b.line(1, 1, &[[0.0, 5.0], [5.0, 10.0], [10.0, 5.0]]);
        b.polygon(2, 0, &[[20.0, 0.0], [30.0, 0.0], [30.0, 10.0], [20.0, 10.0]]);
        b.finish()
    }

    #[test]
    fn rectangle_selection() {
        let idx = sample();
        assert_eq!(idx.len(), 5);
        let h = idx.in_rect([-1.0, -1.0], [1.0, 1.0]);
        assert_eq!(h, vec![Hit { layer: 0, index: 0 }, Hit { layer: 1, index: 0 }]);
        // A rectangle crossing the middle of a link without containing a vertex.
        let h = idx.in_rect([4.0, -1.0], [6.0, 1.0]);
        assert_eq!(h, vec![Hit { layer: 1, index: 0 }]);
        // Rectangle inside a polygon.
        let h = idx.in_rect([24.0, 4.0], [26.0, 6.0]);
        assert_eq!(h, vec![Hit { layer: 2, index: 0 }]);
        assert!(idx.in_rect([40.0, 40.0], [50.0, 50.0]).is_empty());
        // Objects on the boundary are included.
        assert_eq!(idx.in_rect([10.0, 0.0], [12.0, -3.0]).len(), 2);
    }

    #[test]
    fn lasso_selection() {
        let idx = sample();
        let lasso = [[8.0, -2.0], [12.0, -2.0], [12.0, 2.0], [8.0, 2.0]];
        let h = idx.in_polygon(&lasso);
        assert_eq!(h, vec![Hit { layer: 0, index: 1 }, Hit { layer: 1, index: 0 }]);
    }

    #[test]
    fn nearest_prefers_points() {
        let idx = sample();
        assert_eq!(idx.nearest([0.5, 0.2], 1.0), Some(Hit { layer: 0, index: 0 }));
        assert_eq!(idx.nearest([5.0, 0.3], 1.0), Some(Hit { layer: 1, index: 0 }));
        assert_eq!(idx.nearest([25.0, 5.0], 1.0), Some(Hit { layer: 2, index: 0 }));
        assert_eq!(idx.nearest([5.0, 3.0], 1.0), None);
    }
}
