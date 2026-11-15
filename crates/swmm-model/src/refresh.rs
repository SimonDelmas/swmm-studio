//! Keeping the network in step with the edits of the file.

use std::collections::{HashMap, HashSet};

use swmm_inp::{InpFile, Line, SectionKind};

use crate::{coord, edit, ops, Network, ObjKind, Refresh};

/// Names (in upper case) of objects, one set per [`ObjKind`].
type Names = [HashSet<String>; 4];

/// What an edit asks of the network, when it can be updated in place.
#[derive(Default)]
struct Touched {
    /// Objects whose connections changed (the ends of a link, the gage and outlet of a
    /// subcatchment).
    reconnected: Names,
    /// Objects whose points changed.
    geometry: Names,
}

fn upper(l: &Line, i: usize) -> String {
    l.token(i).unwrap_or("").to_ascii_uppercase()
}

/// Kind of the objects a section gives the points of.
fn geometry_of(section: &SectionKind) -> Option<ObjKind> {
    match section {
        SectionKind::Coordinates => Some(ObjKind::Node),
        SectionKind::Vertices => Some(ObjKind::Link),
        SectionKind::Polygons => Some(ObjKind::Subcatchment),
        SectionKind::Symbols => Some(ObjKind::Gage),
        _ => None,
    }
}

/// The lines that hold values (not comments or blank lines).
fn data(lines: &[Line]) -> impl Iterator<Item = &Line> {
    lines.iter().filter(|l| l.is_data())
}

/// Reads what the changed lines touch; `None` when objects were added, removed, renamed
/// or reordered, which only a rebuild follows.
fn classify(changes: &[edit::Change]) -> Option<Touched> {
    let mut touched = Touched::default();
    for c in changes {
        if let Some(k) = ObjKind::defined_in(&c.kind) {
            // The objects, in file order and as written: a reorder changes the indices
            // and a change of case the names shown.
            let ids = |lines: &[Line]| data(lines).map(|l| l.token(0).unwrap_or("").to_string()).collect::<Vec<_>>();
            if ids(&c.removed) != ids(&c.inserted) {
                return None;
            }
            // The tokens that make the structure: the name and, for links and
            // subcatchments, what they are connected to.
            let n_tokens = match k {
                ObjKind::Node | ObjKind::Gage => 1,
                ObjKind::Link | ObjKind::Subcatchment => 3,
            };
            let key = |l: &Line| (0..n_tokens).map(|i| upper(l, i)).collect::<Vec<_>>();
            let before: HashSet<Vec<String>> = data(&c.removed).map(key).collect();
            touched.reconnected[k as usize]
                .extend(data(&c.inserted).map(key).filter(|v| !before.contains(v)).map(|v| v[0].clone()));
        }
        if let Some(k) = geometry_of(&c.kind) {
            touched.geometry[k as usize].extend(data(&c.removed).chain(data(&c.inserted)).map(|l| upper(l, 0)));
        }
    }
    Some(touched)
}

impl Network {
    /// Updates the network after an edit of `inp` that changed these lines.
    ///
    /// Value edits leave it as is; moved points, new vertices and reconnected links are
    /// updated in place; when objects are added, removed or renamed the network is
    /// rebuilt (indices may then change).
    pub fn refresh(&mut self, inp: &InpFile, changes: &[edit::Change]) -> Refresh {
        let Some(touched) = classify(changes) else {
            *self = Network::from_inp(inp);
            return Refresh { rebuilt: true, ..Refresh::default() };
        };
        let mut out = Refresh::default();
        self.reconnect_links(inp, &touched.reconnected[ObjKind::Link as usize], &mut out);
        self.reroute_subcatchments(inp, &touched.reconnected[ObjKind::Subcatchment as usize], &mut out);
        for k in ObjKind::ALL {
            self.reread_geometry(inp, k, &touched.geometry[k as usize], &mut out);
        }
        self.add_links_of_moved_nodes(&mut out);
        for v in [&mut out.nodes, &mut out.links, &mut out.subcatchments, &mut out.gages] {
            v.sort_unstable();
            v.dedup();
        }
        out
    }

    /// Reads again the end nodes of these links.
    fn reconnect_links(&mut self, inp: &InpFile, ids: &HashSet<String>, out: &mut Refresh) {
        for id in ids {
            let Some(i) = self.find(ObjKind::Link, id) else { continue };
            let section = self.links[i as usize].kind.section();
            let Some(l) = inp.rows(&section).find(|l| upper(l, 0) == *id) else { continue };
            let from = l.token(1).and_then(|n| self.find(ObjKind::Node, n));
            let to = l.token(2).and_then(|n| self.find(ObjKind::Node, n));
            let link = &mut self.links[i as usize];
            (link.from, link.to) = (from, to);
            out.links.push(i);
        }
    }

    /// Reads again the rain gage and the outlet of these subcatchments.
    fn reroute_subcatchments(&mut self, inp: &InpFile, ids: &HashSet<String>, out: &mut Refresh) {
        for id in ids {
            let Some(i) = self.find(ObjKind::Subcatchment, id) else { continue };
            let Some(l) = inp.rows(&SectionKind::Subcatchments).find(|l| upper(l, 0) == *id) else { continue };
            let gage = l.token(1).and_then(|g| self.find(ObjKind::Gage, g));
            let outlet = l
                .token(2)
                .and_then(|o| self.find_ref(ObjKind::Node, o).or_else(|| self.find_ref(ObjKind::Subcatchment, o)));
            let s = &mut self.subcatchments[i as usize];
            (s.gage, s.outlet) = (gage, outlet);
            out.subcatchments.push(i);
        }
    }

    /// Reads again the points of these objects of one kind.
    fn reread_geometry(&mut self, inp: &InpFile, k: ObjKind, ids: &HashSet<String>, out: &mut Refresh) {
        if ids.is_empty() {
            return;
        }
        let mut points: HashMap<String, Vec<[f64; 2]>> = ids.iter().map(|id| (id.clone(), Vec::new())).collect();
        for l in inp.rows(&ops::geometry_section(k)) {
            if let (Some(v), Some(p)) = (points.get_mut(&upper(l, 0)), coord(l, 1)) {
                v.push(p);
            }
        }
        for (id, p) in points {
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

    /// A link is drawn from its end nodes: it changes when one of them moves.
    fn add_links_of_moved_nodes(&self, out: &mut Refresh) {
        if out.nodes.is_empty() {
            return;
        }
        let moved: HashSet<u32> = out.nodes.iter().copied().collect();
        let is_moved = |n: Option<u32>| n.is_some_and(|n| moved.contains(&n));
        let links = self.links.iter().enumerate().filter(|(_, l)| is_moved(l.from) || is_moved(l.to));
        out.links.extend(links.map(|(i, _)| i as u32));
    }
}
