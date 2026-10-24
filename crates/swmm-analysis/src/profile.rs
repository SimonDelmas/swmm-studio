//! Longitudinal profiles: the path between nodes and the elevations along it.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use serde::Serialize;
use swmm_inp::{InpFile, SectionKind};
use swmm_model::{attribute, LinkType, Network, ObjKind};

/// Weight of a link without length (pumps, orifices…): a short hop.
const HOP: f64 = 1e-3;

/// Length of every link used as the profile distance (conduit length; 0 for other links).
pub fn link_lengths(inp: &InpFile, net: &Network) -> Vec<f64> {
    let len = attribute(inp, net, ObjKind::Link, "length").unwrap_or_default();
    net.links
        .iter()
        .enumerate()
        .map(|(i, l)| match (l.kind, len.get(i)) {
            (LinkType::Conduit, Some(&v)) if v.is_finite() && v > 0.0 => v as f64,
            _ => 0.0,
        })
        .collect()
}

/// Shortest path between two nodes, ignoring flow direction: `(link, forward)` where
/// `forward` means the link is walked from its "from" node to its "to" node.
pub fn shortest_path(net: &Network, lengths: &[f64], from: u32, to: u32) -> Option<Vec<(u32, bool)>> {
    let n = net.nodes.len();
    if from as usize >= n || to as usize >= n {
        return None;
    }
    if from == to {
        return Some(Vec::new());
    }
    let mut adj: Vec<Vec<(u32, u32, bool)>> = vec![Vec::new(); n];
    for (i, l) in net.links.iter().enumerate() {
        if let (Some(a), Some(b)) = (l.from, l.to) {
            adj[a as usize].push((b, i as u32, true));
            adj[b as usize].push((a, i as u32, false));
        }
    }
    let mut dist = vec![f64::INFINITY; n];
    let mut prev: Vec<Option<(u32, u32, bool)>> = vec![None; n];
    // Distances as ordered integers (nanometres) for the heap.
    let key = |d: f64| (d * 1e9) as u64;
    let mut heap = BinaryHeap::new();
    dist[from as usize] = 0.0;
    heap.push(Reverse((0u64, from)));
    while let Some(Reverse((dk, u))) = heap.pop() {
        if u == to {
            break;
        }
        if dk > key(dist[u as usize]) {
            continue;
        }
        for &(v, link, fwd) in &adj[u as usize] {
            let w = lengths.get(link as usize).copied().unwrap_or(0.0).max(0.0) + HOP;
            let d = dist[u as usize] + w;
            if d < dist[v as usize] {
                dist[v as usize] = d;
                prev[v as usize] = Some((u, link, fwd));
                heap.push(Reverse((key(d), v)));
            }
        }
    }
    if !dist[to as usize].is_finite() {
        return None;
    }
    let mut path = Vec::new();
    let mut at = to;
    while at != from {
        let (p, link, fwd) = prev[at as usize]?;
        path.push((link, fwd));
        at = p;
    }
    path.reverse();
    Some(path)
}

/// Shortest path through a list of nodes, in order.
pub fn path_through(net: &Network, lengths: &[f64], nodes: &[u32]) -> Option<Vec<(u32, bool)>> {
    let mut out = Vec::new();
    for w in nodes.windows(2) {
        out.extend(shortest_path(net, lengths, w[0], w[1])?);
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProfileNode {
    pub index: u32,
    pub id: String,
    /// Distance from the start of the profile.
    pub station: f64,
    pub invert: f64,
    /// Invert + max depth (NaN when the node has none, e.g. outfalls).
    pub rim: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProfileLink {
    pub index: u32,
    pub id: String,
    pub start: f64,
    pub end: f64,
    /// Bottom of the link at the start and end of its span on the profile.
    pub invert_start: f64,
    pub invert_end: f64,
    /// Full height (cross-section geom1; NaN for pumps and outlets).
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Profile {
    pub nodes: Vec<ProfileNode>,
    pub links: Vec<ProfileLink>,
}

fn num(s: Option<&str>) -> Option<f64> {
    s.and_then(|s| s.parse::<f64>().ok()).filter(|v| v.is_finite())
}

impl Profile {
    /// Profile along a path starting at node `start`.
    pub fn build(inp: &InpFile, net: &Network, lengths: &[f64], start: u32, path: &[(u32, bool)]) -> Profile {
        let f = |name: &str, kind| attribute(inp, net, kind, name).unwrap_or_default();
        let invert = f("invert_elevation", ObjKind::Node);
        let depth = f("max_depth", ObjKind::Node);
        let geom1 = f("geom1", ObjKind::Link);
        let elevation_offsets = inp.option("LINK_OFFSETS").is_some_and(|o| o.eq_ignore_ascii_case("ELEVATION"));
        // Inlet / outlet offsets of every link (raw tokens, `None` when absent).
        let mut offsets: Vec<(Option<String>, Option<String>)> = vec![(None, None); net.links.len()];
        for (section, a, b) in [
            (SectionKind::Conduits, Some(5), Some(6)),
            (SectionKind::Orifices, Some(4), None),
            (SectionKind::Weirs, Some(4), None),
            (SectionKind::Outlets, Some(3), None),
        ] {
            for l in inp.rows(&section) {
                if let Some(i) = l.token(0).and_then(|id| net.find(ObjKind::Link, id)) {
                    let t = |k: Option<usize>| k.and_then(|k| l.token(k)).map(str::to_string);
                    offsets[i as usize] = (t(a), t(b));
                }
            }
        }
        let node_inv = |n: Option<u32>| n.and_then(|n| invert.get(n as usize)).map_or(f64::NAN, |&v| v as f64);
        let end_invert = |off: &Option<String>, node: Option<u32>| {
            let z = node_inv(node);
            match (elevation_offsets, off.as_deref()) {
                (true, Some(s)) if s != "*" => num(Some(s)).unwrap_or(z),
                (true, _) => z,
                (false, s) => z + num(s).unwrap_or(0.0),
            }
        };
        let node = |i: u32, station: f64| ProfileNode {
            index: i,
            id: net.nodes[i as usize].id.clone(),
            station,
            invert: node_inv(Some(i)),
            rim: match (invert.get(i as usize), depth.get(i as usize)) {
                (Some(&z), Some(&d)) if d.is_finite() => (z + d) as f64,
                _ => f64::NAN,
            },
        };
        let mut nodes = vec![node(start, 0.0)];
        let mut links = Vec::new();
        let mut station = 0.0;
        for &(li, fwd) in path {
            let l = &net.links[li as usize];
            let b = if fwd { l.to } else { l.from };
            let len = lengths.get(li as usize).copied().unwrap_or(0.0);
            let (o1, o2) = &offsets[li as usize];
            let (z1, z2) = (end_invert(o1, l.from), end_invert(o2, l.to));
            let (za, zb) = if fwd { (z1, z2) } else { (z2, z1) };
            links.push(ProfileLink {
                index: li,
                id: l.id.clone(),
                start: station,
                end: station + len,
                invert_start: za,
                invert_end: zb,
                height: match l.kind {
                    LinkType::Pump | LinkType::Outlet => f64::NAN,
                    _ => geom1.get(li as usize).map_or(f64::NAN, |&v| v as f64),
                },
            });
            station += len;
            if let Some(b) = b {
                nodes.push(node(b, station));
            }
        }
        Profile { nodes, links }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "\
[OPTIONS]
FLOW_UNITS LPS
[JUNCTIONS]
A 100 3
B 99 3
C 98 2
D 99.5 2
E 101 1
[OUTFALLS]
O 97 FREE
[CONDUITS]
AB A B 100 0.013 0.5 0
BC B C 100 0.013 0 0
CO C O 50 0.013 0 0.2
BD D B 500 0.013 0 0
DC D C 100 0.013 0 0
[PUMPS]
P1 D E * ON
[XSECTIONS]
AB CIRCULAR 0.5 0 0 0 1
BC CIRCULAR 0.6 0 0 0 1
CO CIRCULAR 0.8 0 0 0 1
";

    #[test]
    fn shortest_path_and_profile() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let lengths = link_lengths(&inp, &net);
        let id = |s| net.find(ObjKind::Node, s).unwrap();
        let p = shortest_path(&net, &lengths, id("A"), id("O")).unwrap();
        let names: Vec<_> = p.iter().map(|&(l, f)| (net.links[l as usize].id.as_str(), f)).collect();
        assert_eq!(names, [("AB", true), ("BC", true), ("CO", true)]);
        // Against the flow: D → C is walked backwards from C.
        let back = shortest_path(&net, &lengths, id("B"), id("D")).unwrap();
        let l = |s| net.find(ObjKind::Link, s).unwrap();
        assert_eq!(back, [(l("BC"), true), (l("DC"), false)]);
        let through = path_through(&net, &lengths, &[id("A"), id("D"), id("E")]).unwrap();
        assert_eq!(through.len(), 3 + 1);
        let prof = Profile::build(&inp, &net, &lengths, id("A"), &p);
        let st: Vec<f64> = prof.nodes.iter().map(|n| n.station).collect();
        assert_eq!(st, [0.0, 100.0, 200.0, 250.0]);
        assert_eq!((prof.nodes[0].invert, prof.nodes[0].rim), (100.0, 103.0));
        assert!(prof.nodes[3].rim.is_nan());
        assert_eq!((prof.links[0].invert_start, prof.links[0].invert_end, prof.links[0].height), (100.5, 99.0, 0.5));
        assert!((prof.links[2].invert_end - 97.2).abs() < 1e-9);
        assert!(shortest_path(&net, &lengths, id("A"), 99).is_none());
    }
}
