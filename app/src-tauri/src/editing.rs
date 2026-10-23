//! Model editing on a [`Session`]: edits, undo / redo, save, new model. Map
//! coordinates come in display space (longitude/latitude, or cartesian offsets) and are
//! converted back to the model's coordinate system before they are written.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use swmm_inp::SectionKind;
use swmm_model::edit::Change;
use swmm_model::ops::{self, DeletePlan};
use swmm_model::schema::RefKind;
use swmm_model::tables::{self, Table};
use swmm_model::{LinkType, NodeType, ObjKind, ObjRef, Refresh};

use crate::session::{GeometryPatch, ModelInfo, Res, Session, Space};

/// An edit asked by the UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditRequest {
    /// Sets one field of the line `key` of a section.
    SetField {
        section: String,
        key: Vec<String>,
        field: usize,
        value: String,
    },
    /// Sets a field (by key) on the lines of many objects.
    SetFieldBulk {
        objects: Vec<ObjRef>,
        section: String,
        field: String,
        value: String,
    },
    AddLine {
        section: String,
        key: Vec<String>,
    },
    RemoveLine {
        section: String,
        key: Vec<String>,
    },
    Rename {
        kind: RefKind,
        old: String,
        new: String,
    },
    AddNode {
        node_type: NodeType,
        xy: [f64; 2],
    },
    AddLink {
        link_type: LinkType,
        from: u32,
        to: u32,
        vertices: Vec<[f64; 2]>,
    },
    AddSubcatchment {
        polygon: Vec<[f64; 2]>,
    },
    AddGage {
        xy: [f64; 2],
    },
    Delete {
        objects: Vec<ObjRef>,
    },
    /// New map geometry: the point of a node or gage, the interior vertices of a link,
    /// the outline of a subcatchment.
    SetGeometry {
        object: ObjRef,
        points: Vec<[f64; 2]>,
    },
    /// Moves objects by an offset in display coordinates.
    Translate {
        objects: Vec<ObjRef>,
        dx: f64,
        dy: f64,
    },
    Reconnect {
        link: u32,
        end: LinkEnd,
        node: u32,
    },
    SetOptions {
        values: Vec<(String, String)>,
    },
    SetTitle {
        text: String,
    },
    /// Writes a table; `old_name` renames it first (with every reference).
    SetTable {
        table: Table,
        old_name: Option<String>,
    },
    AddTable {
        kind: RefKind,
    },
    DeleteTable {
        kind: RefKind,
        name: String,
    },
    AssignRdii {
        nodes: Vec<u32>,
        hydrograph: String,
        area: Option<String>,
    },
    RemoveRdii {
        nodes: Vec<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkEnd {
    From,
    To,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditOutcome {
    /// Label of the edit (shown as "Undo <label>").
    pub label: String,
    pub info: ModelInfo,
    /// The map geometry changed: the UI fetches it again.
    pub geometry: bool,
    /// Or only these objects changed: the UI updates them in place.
    pub patch: Option<GeometryPatch>,
    /// Objects were added, removed or renamed: indices changed.
    pub rebuilt: bool,
    /// Selection after the edit.
    pub selection: Vec<ObjRef>,
    /// Message for the status bar.
    pub message: Option<String>,
    /// Name created by the edit (new table).
    pub created: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionsDto {
    pub values: Vec<(String, String)>,
    pub title: String,
}

fn section(name: &str) -> Res<SectionKind> {
    match SectionKind::from_name(name) {
        SectionKind::Unknown(n) => Err(format!("unknown section [{n}]")),
        k => Ok(k),
    }
}

fn node_word(t: NodeType) -> &'static str {
    match t {
        NodeType::Junction => "junction",
        NodeType::Outfall => "outfall",
        NodeType::Divider => "divider",
        NodeType::Storage => "storage unit",
    }
}

fn link_word(t: LinkType) -> &'static str {
    match t {
        LinkType::Conduit => "conduit",
        LinkType::Pump => "pump",
        LinkType::Orifice => "orifice",
        LinkType::Weir => "weir",
        LinkType::Outlet => "outlet",
    }
}

fn table_word(k: RefKind) -> &'static str {
    match k {
        RefKind::Curve => "curve",
        RefKind::Timeseries => "time series",
        RefKind::Pattern => "pattern",
        RefKind::Hydrograph => "unit hydrograph",
        RefKind::Transect => "transect",
        _ => "object",
    }
}

fn table_prefix(k: RefKind) -> &'static str {
    match k {
        RefKind::Curve => "Curve",
        RefKind::Timeseries => "TS",
        RefKind::Pattern => "Pat",
        RefKind::Hydrograph => "UH",
        RefKind::Transect => "Tr",
        _ => "X",
    }
}

/// Objects defined by inserted lines that were not there before (added or restored).
fn defined(changes: &[Change]) -> Vec<(ObjKind, String)> {
    let mut out = Vec::new();
    for c in changes {
        let k = match c.kind {
            SectionKind::Junctions | SectionKind::Outfalls | SectionKind::Dividers | SectionKind::Storage => {
                ObjKind::Node
            }
            SectionKind::Conduits
            | SectionKind::Pumps
            | SectionKind::Orifices
            | SectionKind::Weirs
            | SectionKind::Outlets => ObjKind::Link,
            SectionKind::Subcatchments => ObjKind::Subcatchment,
            SectionKind::Raingages => ObjKind::Gage,
            _ => continue,
        };
        let gone: HashSet<String> = c
            .removed
            .iter()
            .filter(|l| l.is_data())
            .filter_map(|l| l.token(0))
            .map(|t| t.to_ascii_uppercase())
            .collect();
        for l in c.inserted.iter().filter(|l| l.is_data()) {
            if let Some(id) = l.token(0).filter(|t| !gone.contains(&t.to_ascii_uppercase())) {
                out.push((k, id.to_string()));
            }
        }
    }
    out
}

/// Length of a polyline in metres from WGS 84 points (haversine).
fn geodesic_length(pts: &[[f64; 2]]) -> f64 {
    const R: f64 = 6_371_008.8;
    pts.windows(2)
        .map(|w| {
            let (p1, p2) = (w[0][1].to_radians(), w[1][1].to_radians());
            let dp = p2 - p1;
            let dl = (w[1][0] - w[0][0]).to_radians();
            let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
            2.0 * R * a.sqrt().asin()
        })
        .sum()
}

fn planar_length(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum()
}

fn shoelace(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum::<f64>().abs() / 2.0
}

/// Area in m² of a ring of WGS 84 points (local equirectangular projection).
fn geodesic_area(pts: &[[f64; 2]]) -> f64 {
    const R: f64 = 6_371_008.8;
    let lat0 = (pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64).to_radians();
    let m: Vec<[f64; 2]> = pts.iter().map(|p| [R * p[0].to_radians() * lat0.cos(), R * p[1].to_radians()]).collect();
    shoelace(&m)
}

impl Session {
    fn ids_of(&self, sel: &[ObjRef]) -> Vec<(ObjKind, String)> {
        sel.iter()
            .filter(|o| (o.index as usize) < self.net.len(o.kind))
            .map(|o| (o.kind, self.net.id(*o).to_string()))
            .collect()
    }

    fn refs_of(&self, ids: &[(ObjKind, String)]) -> Vec<ObjRef> {
        ids.iter().filter_map(|(k, id)| self.net.find_ref(*k, id)).collect()
    }

    fn id_at(&self, kind: ObjKind, index: u32) -> Res<String> {
        if (index as usize) < self.net.len(kind) {
            Ok(self.net.id(ObjRef { kind, index }).to_string())
        } else {
            Err(format!("no {} #{index}", kind.name()))
        }
    }

    /// Display coordinates → model coordinates.
    fn to_model(&self, pts: &[[f64; 2]]) -> Res<Vec<[f64; 2]>> {
        self.display.unproject(self.crs.as_ref(), pts).ok_or_else(|| "a point is outside the coordinate system".into())
    }

    /// Decimals written for coordinates: degrees need more than metres.
    fn decimals(&self) -> usize {
        match &self.crs {
            Some(c) if c.is_geographic() => 8,
            _ => 3,
        }
    }

    /// Length of a polyline in model coordinates, in the model's length unit.
    fn model_length(&self, pts: &[[f64; 2]]) -> f64 {
        match &self.crs {
            Some(c) => {
                let mut ll = pts.to_vec();
                c.to_lonlat(&mut ll);
                let m = geodesic_length(&ll);
                if self.inp.flow_units().is_metric() {
                    m
                } else {
                    m / 0.3048
                }
            }
            None => planar_length(pts),
        }
    }

    /// Area of a ring in model coordinates, in ha (SI) or acres (US).
    fn model_area(&self, ring: &[[f64; 2]]) -> f64 {
        let si = self.inp.flow_units().is_metric();
        match &self.crs {
            Some(c) => {
                let mut ll = ring.to_vec();
                c.to_lonlat(&mut ll);
                let m2 = geodesic_area(&ll);
                if si {
                    m2 / 10_000.0
                } else {
                    m2 / 4_046.856_422_4
                }
            }
            None => shoelace(ring) / if si { 10_000.0 } else { 43_560.0 },
        }
    }

    /// Updates everything derived from the file after a change.
    fn after_change(&mut self, changes: &[Change]) -> Refresh {
        self.revision += 1;
        let r = self.net.refresh(&self.inp, changes);
        if r.rebuilt {
            let origin = match self.display.space {
                Space::Cartesian { origin } => Some(origin),
                Space::LonLat => None,
            };
            self.display = crate::session::Display::build(&self.net, self.crs.as_ref(), origin);
            if let Some(lr) = &mut self.results {
                lr.remap(&self.net);
            }
        } else if r.geometry_changed() {
            self.display.update(&self.net, self.crs.as_ref(), &r);
        }
        r
    }

    fn outcome(
        &mut self,
        label: String,
        changes: Vec<Change>,
        keep: Vec<(ObjKind, String)>,
        focus: Option<Vec<(ObjKind, String)>>,
        message: Option<String>,
        created: Option<String>,
    ) -> EditOutcome {
        let r = self.after_change(&changes);
        let selection = match focus {
            Some(f) => self.refs_of(&f),
            None => self.refs_of(&keep),
        };
        let patch = (!r.rebuilt && r.geometry_changed()).then(|| self.display.patch(&self.net, &r)).flatten();
        EditOutcome {
            label,
            info: self.info(),
            geometry: r.geometry_changed() && patch.is_none(),
            patch,
            rebuilt: r.rebuilt,
            selection,
            message,
            created,
        }
    }

    /// Applies an edit. `selection` is kept (by name) unless the edit selects something
    /// else (a new object).
    pub fn edit(&mut self, req: EditRequest, selection: &[ObjRef]) -> Res<EditOutcome> {
        let keep = self.ids_of(selection);
        let decimals = self.decimals();
        let mut focus: Option<Vec<(ObjKind, String)>> = None;
        let mut message = None;
        let mut created = None;
        let (label, changes) = match req {
            EditRequest::SetField { section: s, key, field, value } => {
                let kind = section(&s)?;
                let label = format!("Edit {}", key.first().cloned().unwrap_or_default());
                let a = self.history.edit(&mut self.inp, label, |tx| ops::set_field(tx, &kind, &key, field, &value))?;
                (a.label, a.changes)
            }
            EditRequest::SetFieldBulk { objects, section: s, field, value } => {
                let kind = section(&s)?;
                let ids: Vec<String> = self.ids_of(&objects).into_iter().map(|(_, id)| id).collect();
                let a = self.history.edit(&mut self.inp, format!("Edit {} objects", ids.len()), |tx| {
                    ops::set_field_bulk(tx, &kind, &ids, &field, &value)
                })?;
                message = Some(format!("{} of {} objects changed", a.value, ids.len()));
                (a.label, a.changes)
            }
            EditRequest::AddLine { section: s, key } => {
                let kind = section(&s)?;
                let label = format!("Add [{}] to {}", kind.name(), key.first().cloned().unwrap_or_default());
                let a = self.history.edit(&mut self.inp, label, |tx| ops::add_line(tx, &kind, &key))?;
                (a.label, a.changes)
            }
            EditRequest::RemoveLine { section: s, key } => {
                let kind = section(&s)?;
                let label = format!("Remove [{}] of {}", kind.name(), key.first().cloned().unwrap_or_default());
                let a = self.history.edit(&mut self.inp, label, |tx| ops::remove_line(tx, &kind, &key))?;
                (a.label, a.changes)
            }
            EditRequest::Rename { kind, old, new } => {
                let new = new.trim().to_string();
                let a = self
                    .history
                    .edit(&mut self.inp, format!("Rename {old} to {new}"), |tx| ops::rename(tx, kind, &old, &new))?;
                // Keep the renamed object selected.
                focus = Some(
                    keep.iter()
                        .map(|(k, id)| (*k, if id.eq_ignore_ascii_case(&old) { new.clone() } else { id.clone() }))
                        .collect(),
                );
                (a.label, a.changes)
            }
            EditRequest::AddNode { node_type, xy } => {
                let p = self.to_model(&[xy])?[0];
                let net = &self.net;
                let a = self.history.edit(&mut self.inp, format!("Add {}", node_word(node_type)), |tx| {
                    ops::add_node(tx, net, node_type, p, decimals)
                })?;
                focus = Some(vec![(ObjKind::Node, a.value.clone())]);
                (format!("{} {}", a.label, a.value), a.changes)
            }
            EditRequest::AddLink { link_type, from, to, vertices } => {
                let (fid, tid) = (self.id_at(ObjKind::Node, from)?, self.id_at(ObjKind::Node, to)?);
                let v = self.to_model(&vertices)?;
                let mut path: Vec<[f64; 2]> = Vec::new();
                path.extend(self.net.nodes[from as usize].xy);
                path.extend_from_slice(&v);
                path.extend(self.net.nodes[to as usize].xy);
                let length = (path.len() >= 2).then(|| self.model_length(&path));
                let net = &self.net;
                let a = self.history.edit(&mut self.inp, format!("Add {}", link_word(link_type)), |tx| {
                    ops::add_link(tx, net, link_type, [&fid, &tid], &v, length, decimals)
                })?;
                focus = Some(vec![(ObjKind::Link, a.value.clone())]);
                (format!("{} {}", a.label, a.value), a.changes)
            }
            EditRequest::AddSubcatchment { polygon } => {
                let mut ring = self.to_model(&polygon)?;
                if ring.len() > 3 && ring.first() == ring.last() {
                    ring.pop();
                }
                let area = self.model_area(&ring);
                let c = [
                    ring.iter().map(|p| p[0]).sum::<f64>() / ring.len() as f64,
                    ring.iter().map(|p| p[1]).sum::<f64>() / ring.len() as f64,
                ];
                let outlet = self
                    .net
                    .nodes
                    .iter()
                    .filter_map(|n| n.xy.map(|p| ((p[0] - c[0]).hypot(p[1] - c[1]), n.id.clone())))
                    .min_by(|a, b| a.0.total_cmp(&b.0))
                    .map(|(_, id)| id);
                let net = &self.net;
                let a = self.history.edit(&mut self.inp, "Add subcatchment", |tx| {
                    ops::add_subcatchment(tx, net, &ring, outlet.as_deref(), Some(area), decimals)
                })?;
                focus = Some(vec![(ObjKind::Subcatchment, a.value.clone())]);
                (format!("{} {}", a.label, a.value), a.changes)
            }
            EditRequest::AddGage { xy } => {
                let p = self.to_model(&[xy])?[0];
                let net = &self.net;
                let a = self.history.edit(&mut self.inp, "Add rain gage", |tx| ops::add_gage(tx, net, p, decimals))?;
                focus = Some(vec![(ObjKind::Gage, a.value.clone())]);
                (format!("{} {}", a.label, a.value), a.changes)
            }
            EditRequest::Delete { objects } => {
                let n = objects.len();
                let net = &self.net;
                let label = if n == 1 {
                    format!("Delete {}", self.ids_of(&objects).first().map(|x| x.1.clone()).unwrap_or_default())
                } else {
                    format!("Delete {n} objects")
                };
                let a = self.history.edit(&mut self.inp, label, |tx| ops::delete(tx, net, &objects))?;
                let p = &a.value;
                let total = p.nodes.len() + p.links.len() + p.subcatchments.len() + p.gages.len();
                let mut m = format!("{total} object(s) deleted");
                if !p.cascade_links.is_empty() {
                    m += &format!(", with {} connected link(s)", p.cascade_links.len());
                }
                if p.rules > 0 {
                    m += &format!("; {} control rule line(s) still name them", p.rules);
                }
                message = Some(m);
                focus = Some(Vec::new());
                (a.label, a.changes)
            }
            EditRequest::SetGeometry { object, points } => {
                let id = self.id_at(object.kind, object.index)?;
                let mut pts = self.to_model(&points)?;
                if object.kind == ObjKind::Subcatchment && pts.len() > 3 && pts.first() == pts.last() {
                    pts.pop();
                }
                let label = match object.kind {
                    ObjKind::Node | ObjKind::Gage => format!("Move {id}"),
                    _ => format!("Reshape {id}"),
                };
                let a = self
                    .history
                    .edit(&mut self.inp, label, |tx| ops::set_geometry(tx, object.kind, &id, &pts, decimals))?;
                (a.label, a.changes)
            }
            EditRequest::Translate { objects, dx, dy } => {
                // Each object's display geometry, shifted, then converted back.
                let mut moves: Vec<(ObjKind, String, Vec<[f64; 2]>)> = Vec::new();
                for o in &objects {
                    let id = self.id_at(o.kind, o.index)?;
                    let shifted: Vec<[f64; 2]> =
                        self.display_points(*o).into_iter().map(|p| [p[0] + dx, p[1] + dy]).collect();
                    if shifted.is_empty() {
                        continue;
                    }
                    moves.push((o.kind, id, self.to_model(&shifted)?));
                }
                let label = if objects.len() == 1 {
                    format!("Move {}", moves.first().map_or("", |m| m.1.as_str()))
                } else {
                    format!("Move {} objects", objects.len())
                };
                let a = self.history.edit(&mut self.inp, label, |tx| {
                    for (k, id, pts) in &moves {
                        ops::set_geometry(tx, *k, id, pts, decimals)?;
                    }
                    Ok(())
                })?;
                (a.label, a.changes)
            }
            EditRequest::Reconnect { link, end, node } => {
                let lid = self.id_at(ObjKind::Link, link)?;
                let nid = self.id_at(ObjKind::Node, node)?;
                let l = &self.net.links[link as usize];
                let other = match end {
                    LinkEnd::From => l.to,
                    LinkEnd::To => l.from,
                };
                if other == Some(node) {
                    return Err("a link needs two different nodes".into());
                }
                let kind = l.kind.section();
                let field = if end == LinkEnd::From { 1 } else { 2 };
                let a = self.history.edit(&mut self.inp, format!("Reconnect {lid} to {nid}"), |tx| {
                    ops::set_field(tx, &kind, std::slice::from_ref(&lid), field, &nid)
                })?;
                (a.label, a.changes)
            }
            EditRequest::SetOptions { values } => {
                let a = self.history.edit(&mut self.inp, "Simulation options", |tx| ops::set_options(tx, &values))?;
                (a.label, a.changes)
            }
            EditRequest::SetTitle { text } => {
                let a = self.history.edit(&mut self.inp, "Title", |tx| ops::set_title(tx, &text))?;
                (a.label, a.changes)
            }
            EditRequest::SetTable { table, old_name } => {
                let kind = table.ref_kind();
                let label = format!("Edit {} {}", table_word(kind), table.name());
                let a = self.history.edit(&mut self.inp, label, |tx| {
                    if let Some(old) = old_name.as_deref().filter(|o| *o != table.name()) {
                        ops::rename(tx, kind, old, table.name())?;
                    }
                    tables::write(tx, &table)
                })?;
                created = Some(table.name().to_string());
                (a.label, a.changes)
            }
            EditRequest::AddTable { kind } => {
                let used = tables::used_names(&self.inp, kind);
                let prefix = table_prefix(kind);
                let name =
                    (1..).map(|n| format!("{prefix}{n}")).find(|n| !used.contains(&n.to_ascii_uppercase())).unwrap();
                let table = Table::empty(kind, &name).ok_or("not a table")?;
                let a = self
                    .history
                    .edit(&mut self.inp, format!("Add {} {name}", table_word(kind)), |tx| tables::write(tx, &table))?;
                created = Some(name);
                (a.label, a.changes)
            }
            EditRequest::DeleteTable { kind, name } => {
                let a = self.history.edit(&mut self.inp, format!("Delete {} {name}", table_word(kind)), |tx| {
                    tables::delete(tx, kind, &name)
                })?;
                (a.label, a.changes)
            }
            EditRequest::AssignRdii { nodes, hydrograph, area } => {
                let ids: Vec<String> = nodes.iter().map(|&n| self.id_at(ObjKind::Node, n)).collect::<Res<Vec<_>>>()?;
                let label = format!("Assign RDII to {} node(s)", ids.len());
                let a = self.history.edit(&mut self.inp, label, |tx| {
                    ops::assign_rdii(tx, &ids, hydrograph.trim(), area.as_deref().filter(|a| !a.trim().is_empty()))
                })?;
                message = Some(format!("{} node(s) assigned to {}", a.value, hydrograph.trim()));
                (a.label, a.changes)
            }
            EditRequest::RemoveRdii { nodes } => {
                let ids: Vec<String> = nodes.iter().map(|&n| self.id_at(ObjKind::Node, n)).collect::<Res<Vec<_>>>()?;
                let a = self.history.edit(&mut self.inp, "Remove RDII", |tx| Ok(ops::remove_rdii(tx, &ids)))?;
                message = Some(format!("RDII removed from {} node(s)", a.value));
                (a.label, a.changes)
            }
        };
        Ok(self.outcome(label, changes, keep, focus, message, created))
    }

    /// Points of an object in display coordinates (for moves): node or gage point, link
    /// interior vertices, subcatchment outline (without the closing point).
    fn display_points(&self, o: ObjRef) -> Vec<[f64; 2]> {
        let i = o.index as usize;
        let d = &self.display;
        match o.kind {
            ObjKind::Node => d.node_point(i).into_iter().collect(),
            ObjKind::Gage => d.gage_point(i).into_iter().collect(),
            ObjKind::Link => {
                let l = &self.net.links[i];
                let mut v = self.to_display(&l.vertices);
                v.retain(|p| p[0].is_finite());
                v
            }
            ObjKind::Subcatchment => {
                let mut v = self.to_display(&self.net.subcatchments[i].polygon);
                v.retain(|p| p[0].is_finite());
                v
            }
        }
    }

    fn to_display(&self, pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
        let mut v = pts.to_vec();
        self.display.project(self.crs.as_ref(), &mut v);
        v
    }

    pub fn undo(&mut self, selection: &[ObjRef]) -> Res<EditOutcome> {
        let keep = self.ids_of(selection);
        let a = self.history.undo(&mut self.inp).ok_or("nothing to undo")?;
        let restored = defined(&a.changes);
        let focus = (!restored.is_empty()).then_some(restored);
        Ok(self.outcome(format!("Undo {}", a.label), a.changes, keep, focus, None, None))
    }

    pub fn redo(&mut self, selection: &[ObjRef]) -> Res<EditOutcome> {
        let keep = self.ids_of(selection);
        let a = self.history.redo(&mut self.inp).ok_or("nothing to redo")?;
        let restored = defined(&a.changes);
        let focus = (!restored.is_empty()).then_some(restored);
        Ok(self.outcome(format!("Redo {}", a.label), a.changes, keep, focus, None, None))
    }

    pub fn delete_plan(&self, objects: &[ObjRef]) -> DeletePlan {
        ops::delete_plan(&self.inp, &self.net, objects)
    }

    /// Names of the objects of a kind (for pickers).
    pub fn names(&self, kind: RefKind) -> Vec<String> {
        swmm_model::refs::names(&self.inp, kind)
    }

    pub fn table(&self, kind: RefKind, name: &str) -> Res<Table> {
        tables::read(&self.inp, kind, name).ok_or_else(|| format!("no {} named {name}", table_word(kind)))
    }

    pub fn options(&self) -> OptionsDto {
        let values = self
            .inp
            .rows(&SectionKind::Options)
            .filter_map(|l| Some((l.token(0)?.to_ascii_uppercase(), l.tokens().skip(1).collect::<Vec<_>>().join(" "))))
            .collect();
        OptionsDto { values, title: ops::title(&self.inp) }
    }

    /// Saves the model (to `path` for "save as", which also moves the project file).
    pub fn save(&mut self, path: Option<&Path>) -> Res<()> {
        let target = path.map(Path::to_path_buf).unwrap_or_else(|| self.inp_path.clone());
        let bytes = self.inp.to_bytes().map_err(|e| e.to_string())?;
        // Write next to the target, then replace it, so a failure never leaves half a file.
        let tmp = target.with_extension("inp.saving");
        std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{}: {e}", target.display())
        })?;
        if target != self.inp_path {
            self.inp_path = target;
            self.save_project()?;
        }
        self.history.mark_saved();
        Ok(())
    }
}

/// Writes a new, empty model with default options.
pub fn create_model(path: &Path, flow_units: &str) -> Res<()> {
    let units =
        swmm_inp::FlowUnits::from_name(flow_units).ok_or_else(|| format!("unknown flow units {flow_units:?}"))?;
    let today = chrono::Local::now().format("%m/%d/%Y").to_string();
    let text = TEMPLATE.replace("{units}", units.name()).replace("{today}", &today).replace('\n', "\r\n");
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

const TEMPLATE: &str = "[TITLE]
;;Project Title/Notes

[OPTIONS]
;;Option             Value
FLOW_UNITS           {units}
INFILTRATION         HORTON
FLOW_ROUTING         DYNWAVE
LINK_OFFSETS         DEPTH
MIN_SLOPE            0
ALLOW_PONDING        NO
SKIP_STEADY_STATE    NO

START_DATE           {today}
START_TIME           00:00:00
REPORT_START_DATE    {today}
REPORT_START_TIME    00:00:00
END_DATE             {today}
END_TIME             06:00:00
SWEEP_START          01/01
SWEEP_END            12/31
DRY_DAYS             0
REPORT_STEP          00:05:00
WET_STEP             00:01:00
DRY_STEP             00:05:00
ROUTING_STEP         0:00:10
RULE_STEP            00:00:00

INERTIAL_DAMPING     PARTIAL
NORMAL_FLOW_LIMITED  BOTH
FORCE_MAIN_EQUATION  H-W
VARIABLE_STEP        0.75
LENGTHENING_STEP     0
MIN_SURFAREA         1.167
MAX_TRIALS           8
HEAD_TOLERANCE       0.0015
SYS_FLOW_TOL         5
LAT_FLOW_TOL         5
MINIMUM_STEP         0.5
THREADS              1

[EVAPORATION]
;;Data Source    Parameters
CONSTANT         0.0
DRY_ONLY         NO

[REPORT]
;;Reporting Options
SUBCATCHMENTS ALL
NODES ALL
LINKS ALL
";

#[cfg(test)]
mod tests {
    use super::*;

    const TINY: &str = include_str!("../../../testdata/tiny.inp");

    fn open() -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("tiny.inp");
        std::fs::write(&inp, TINY).unwrap();
        let s = Session::open(&inp).unwrap();
        (dir, s)
    }

    fn node(s: &Session, id: &str) -> ObjRef {
        s.net.find_ref(ObjKind::Node, id).unwrap()
    }

    #[test]
    fn field_edit_undo_redo_save() {
        let (dir, mut s) = open();
        let j1 = node(&s, "J1");
        let o = s
            .edit(
                EditRequest::SetField {
                    section: "JUNCTIONS".into(),
                    key: vec!["J1".into()],
                    field: 1,
                    value: "100.5".into(),
                },
                &[j1],
            )
            .unwrap();
        assert!(!o.geometry && !o.rebuilt);
        assert_eq!(o.selection, vec![j1]);
        assert!(o.info.dirty);
        assert_eq!(o.info.undo.as_deref(), Some("Edit J1"));
        assert!(s.inp.to_string_lossy().contains("J1               100.5      2.5"));
        let bad = s.edit(
            EditRequest::SetField { section: "JUNCTIONS".into(), key: vec!["J1".into()], field: 2, value: "x".into() },
            &[],
        );
        assert!(bad.is_err());
        s.undo(&[]).unwrap();
        assert_eq!(s.inp.to_string_lossy(), TINY);
        assert!(!s.info().dirty);
        s.redo(&[]).unwrap();
        // Save as: new file and project, clean state.
        let copy = dir.path().join("copy.inp");
        s.save(Some(&copy)).unwrap();
        assert!(!s.info().dirty);
        assert!(std::fs::read_to_string(&copy).unwrap().contains("100.5"));
        assert!(crate::project::project_path(&copy).exists());
        assert_eq!(s.inp_path, copy);
    }

    #[test]
    fn add_move_reconnect_delete() {
        let (_dir, mut s) = open();
        s.set_crs(Some("EPSG:2154")).unwrap();
        // Add a junction next to J3 (display coordinates are lon/lat).
        let j3 = node(&s, "J3");
        let p = s.display.node_point(j3.index as usize).unwrap();
        let at = [p[0] + 0.0005, p[1] + 0.0003];
        let o = s.edit(EditRequest::AddNode { node_type: NodeType::Junction, xy: at }, &[]).unwrap();
        assert!(o.rebuilt && o.geometry);
        let j4 = o.selection[0];
        assert_eq!(s.net.id(j4), "J4");
        let xy = s.net.nodes[j4.index as usize].xy.unwrap();
        assert!((xy[0] - 651_457.0).abs() < 2.0 && (xy[1] - 6_862_014.0).abs() < 2.0, "{xy:?}");
        // A conduit J3 → J4: length from geometry (~49.5 m: 36.6 m east, 33.4 m north).
        let o = s
            .edit(
                EditRequest::AddLink { link_type: LinkType::Conduit, from: j3.index, to: j4.index, vertices: vec![] },
                &[],
            )
            .unwrap();
        let c4 = o.selection[0];
        let len: f64 = s.inp.rows(&SectionKind::Conduits).last().unwrap().token(3).unwrap().parse().unwrap();
        assert!((len - 49.5).abs() < 1.0, "{len}");
        // Move J4: incremental, the conduit follows.
        let o = s.edit(EditRequest::SetGeometry { object: j4, points: vec![[at[0] + 0.001, at[1]]] }, &[j4]).unwrap();
        assert!(!o.geometry && !o.rebuilt);
        // Patch: the node and its conduit.
        let p = o.patch.unwrap();
        assert_eq!((p.nodes.len(), p.links.len()), (1, 1));
        assert_eq!(p.links[0].1, [j3.index, j4.index]);
        assert_eq!(p.links[0].2.last(), Some(&p.nodes[0].1));
        assert_eq!(o.selection, vec![j4]);
        let picked = s.pick([at[0] + 0.001, at[1]], 1.0);
        assert_eq!(picked, Some(j4));
        assert_eq!(s.geometry(), fresh_geometry(&mut s));
        // Reconnect C4 to Out1, then delete J4.
        let out1 = node(&s, "Out1");
        s.edit(EditRequest::Reconnect { link: c4.index, end: LinkEnd::To, node: out1.index }, &[]).unwrap();
        assert_eq!(s.net.links[c4.index as usize].to, Some(out1.index));
        let plan = s.delete_plan(&[j4]);
        assert!(plan.cascade_links.is_empty());
        let o = s.edit(EditRequest::Delete { objects: vec![j4] }, &[j4]).unwrap();
        assert!(o.selection.is_empty() && o.rebuilt);
        assert_eq!(s.net.nodes.len(), 4);
        // Undo the delete: J4 comes back selected.
        let o = s.undo(&[]).unwrap();
        assert_eq!(o.selection.len(), 1);
        assert_eq!(s.net.id(o.selection[0]), "J4");
        while s.history.undo_label().is_some() {
            s.undo(&[]).unwrap();
        }
        assert_eq!(s.inp.to_string_lossy(), TINY);
        assert_eq!(s.geometry(), fresh_geometry(&mut s));
    }

    /// Geometry buffer with the display rebuilt from scratch.
    fn fresh_geometry(s: &mut Session) -> Vec<u8> {
        let fresh = crate::session::Display::build(&s.net, s.crs.as_ref(), None);
        let saved = std::mem::replace(&mut s.display, fresh);
        let g = s.geometry();
        s.display = saved;
        g
    }

    #[test]
    fn subcatchment_tables_options_rdii() {
        let (_dir, mut s) = open();
        // Cartesian display: offsets from the origin.
        let Space::Cartesian { origin } = s.display.space else { panic!() };
        let ring: Vec<[f64; 2]> =
            [[651_420.0, 6_861_900.0], [651_520.0, 6_861_900.0], [651_520.0, 6_861_800.0], [651_420.0, 6_861_800.0]]
                .iter()
                .map(|p| [p[0] - origin[0], p[1] - origin[1]])
                .collect();
        let o = s.edit(EditRequest::AddSubcatchment { polygon: ring }, &[]).unwrap();
        let line = s.inp.rows(&SectionKind::Subcatchments).last().unwrap().to_vec();
        // 1 ha, outlet = nearest node (Out1), gage RG1.
        assert_eq!(
            (line[0].as_str(), line[1].as_str(), line[2].as_str(), line[3].as_str()),
            ("S3", "RG1", "Out1", "1.0000")
        );
        assert_eq!(o.selection.len(), 1);
        // Tables.
        let o = s.edit(EditRequest::AddTable { kind: RefKind::Curve }, &[]).unwrap();
        assert_eq!(o.created.as_deref(), Some("Curve1"));
        let Table::Curve(mut c) = s.table(RefKind::Curve, "Curve1").unwrap() else { panic!() };
        c.name = "SC".into();
        c.points = vec![["0".into(), "10".into()], ["2".into(), "50".into()]];
        s.edit(EditRequest::SetTable { table: Table::Curve(c), old_name: Some("Curve1".into()) }, &[]).unwrap();
        assert!(s.names(RefKind::Curve) == ["SC"]);
        let e = s.edit(EditRequest::DeleteTable { kind: RefKind::Hydrograph, name: "UH1".into() }, &[]).unwrap_err();
        assert!(e.contains("J2 [RDII]"), "{e}");
        // Options and title.
        s.edit(EditRequest::SetOptions { values: vec![("ROUTING_STEP".into(), "0:00:05".into())] }, &[]).unwrap();
        assert!(s.options().values.contains(&("ROUTING_STEP".into(), "0:00:05".into())));
        s.edit(EditRequest::SetTitle { text: "New title".into() }, &[]).unwrap();
        assert_eq!(s.options().title, "New title");
        // RDII on J1 and J3.
        let (j1, j3) = (node(&s, "J1"), node(&s, "J3"));
        let o = s
            .edit(
                EditRequest::AssignRdii {
                    nodes: vec![j1.index, j3.index],
                    hydrograph: "UH1".into(),
                    area: Some("5".into()),
                },
                &[],
            )
            .unwrap();
        assert_eq!(o.message.as_deref(), Some("2 node(s) assigned to UH1"));
        assert_eq!(s.inp.rows(&SectionKind::Rdii).count(), 3);
        // Bulk edit of the conduits' roughness.
        let links: Vec<ObjRef> = (0..3).map(|index| ObjRef { kind: ObjKind::Link, index }).collect();
        let o = s
            .edit(
                EditRequest::SetFieldBulk {
                    objects: links,
                    section: "CONDUITS".into(),
                    field: "n".into(),
                    value: "0.015".into(),
                },
                &[],
            )
            .unwrap();
        assert_eq!(o.message.as_deref(), Some("3 of 3 objects changed"));
    }

    #[test]
    fn new_model_from_template() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("new.inp");
        create_model(&p, "cms").unwrap();
        let mut s = Session::open(&p).unwrap();
        assert_eq!(s.info().flow_units, "CMS");
        let o = s.edit(EditRequest::AddNode { node_type: NodeType::Outfall, xy: [10.0, 20.0] }, &[]).unwrap();
        assert_eq!(s.net.id(o.selection[0]), "Out1");
        assert_eq!(s.net.nodes[0].xy, Some([10.0, 20.0]));
        s.save(None).unwrap();
        let again = Session::open(&p).unwrap();
        assert_eq!(again.net.nodes.len(), 1);
    }
}
