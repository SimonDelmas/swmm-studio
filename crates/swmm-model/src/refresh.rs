//! Keeping the network in step with the edits of the file.

use super::*;

impl Network {
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
                // The objects, in file order and as written: a reorder changes the indices
                // and a change of case the names shown.
                let ids = |lines: &[Line]| -> Vec<String> {
                    lines.iter().filter(|l| l.is_data()).map(|l| l.token(pos[0]).unwrap_or("").to_string()).collect()
                };
                if ids(&c.removed) != ids(&c.inserted) {
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
}
