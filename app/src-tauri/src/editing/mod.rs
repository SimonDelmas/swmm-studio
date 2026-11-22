//! Model editing on a [`Session`]: edits, undo / redo, save, new model. Map
//! coordinates come in display space (longitude/latitude, or cartesian offsets) and are
//! converted back to the model's coordinate system before they are written.

mod fields;
mod map_edits;
mod new_model;
mod request;
mod table_edits;

use std::collections::HashSet;
use std::path::Path;

use swmm_geo::measure;
use swmm_inp::SectionKind;
use swmm_model::edit::{Applied, Change};
use swmm_model::ops::{self, DeletePlan};
use swmm_model::schema::RefKind;
use swmm_model::tables::{self, Table};
use swmm_model::{LinkType, NodeType, ObjKind, ObjRef, Refresh};

use crate::session::{Display, Res, Session, Space};

pub use new_model::create_model;
pub use request::{EditOutcome, EditRequest, LinkEnd, OptionsDto};

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
        RefKind::Aquifer => "aquifer",
        RefKind::Snowpack => "snow pack",
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
        RefKind::Aquifer => "Aquifer",
        RefKind::Snowpack => "Snow",
        _ => "X",
    }
}

/// Objects defined by inserted lines that were not there before (added or restored).
fn defined(changes: &[Change]) -> Vec<(ObjKind, String)> {
    let mut out = Vec::new();
    for c in changes {
        let Some(k) = ObjKind::defined_in(&c.kind) else { continue };
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

/// Objects by kind and name: they are found again after an edit changed the indices.
type Named = Vec<(ObjKind, String)>;

/// What an edit did to the file, before everything derived from it is refreshed.
struct Effect {
    /// Label of the edit (shown as "Undo <label>").
    label: String,
    changes: Vec<Change>,
    /// Objects to select instead of the previous selection.
    focus: Option<Named>,
    message: Option<String>,
    created: Option<String>,
}

impl<T> From<Applied<T>> for Effect {
    fn from(a: Applied<T>) -> Effect {
        Effect { label: a.label, changes: a.changes, focus: None, message: None, created: None }
    }
}

impl Effect {
    /// An edit that added the object `id`: it is named in the label and selected.
    fn added(a: Applied<String>, kind: ObjKind) -> Effect {
        let label = format!("{} {}", a.label, a.value);
        Effect { label, focus: Some(vec![(kind, a.value)]), changes: a.changes, message: None, created: None }
    }

    fn message(mut self, message: String) -> Effect {
        self.message = Some(message);
        self
    }

    fn created(mut self, name: String) -> Effect {
        self.created = Some(name);
        self
    }
}

/// Name of the first key of a line (the object it belongs to), for labels.
fn first_key(key: &[String]) -> &str {
    key.first().map_or("", String::as_str)
}

/// Helpers shared by the edits.
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
                let m = measure::geodesic_length(&ll);
                if self.inp.flow_units().is_metric() {
                    m
                } else {
                    m / 0.3048
                }
            }
            None => measure::planar_length(pts),
        }
    }

    /// Area of a ring in model coordinates, in ha (SI) or acres (US).
    fn model_area(&self, ring: &[[f64; 2]]) -> f64 {
        let si = self.inp.flow_units().is_metric();
        match &self.crs {
            Some(c) => {
                let mut ll = ring.to_vec();
                c.to_lonlat(&mut ll);
                let m2 = measure::geodesic_area(&ll);
                if si {
                    m2 / 10_000.0
                } else {
                    m2 / 4_046.856_422_4
                }
            }
            None => measure::shoelace(ring) / if si { 10_000.0 } else { 43_560.0 },
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
            self.display = Display::build(&self.net, self.crs.as_ref(), origin);
            for lr in [&mut self.results, &mut self.compare].into_iter().flatten().chain(&mut self.overlays) {
                lr.remap(&self.net);
            }
        } else if r.geometry_changed() {
            self.display.update(&self.net, self.crs.as_ref(), &r);
        }
        r
    }

    /// Refreshes the derived state and describes the change for the UI. The previous
    /// selection (`keep`) stays, unless the edit selects something else.
    fn outcome(&mut self, effect: Effect, keep: Named) -> EditOutcome {
        let r = self.after_change(&effect.changes);
        let selection = self.refs_of(effect.focus.as_ref().unwrap_or(&keep));
        let patch = (!r.rebuilt && r.geometry_changed()).then(|| self.display.patch(&self.net, &r)).flatten();
        EditOutcome {
            label: effect.label,
            info: self.info(),
            geometry: r.geometry_changed() && patch.is_none(),
            patch,
            rebuilt: r.rebuilt,
            selection,
            message: effect.message,
            created: effect.created,
        }
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
}

/// Edits, undo and redo.
impl Session {
    /// Applies an edit. `selection` is kept (by name) unless the edit selects something
    /// else (a new object).
    pub fn edit(&mut self, req: EditRequest, selection: &[ObjRef]) -> Res<EditOutcome> {
        let keep = self.ids_of(selection);
        let effect = match req {
            EditRequest::SetField { section: s, key, field, value } => self.set_field(&s, &key, field, &value),
            EditRequest::SetFieldBulk { objects, section: s, field, value } => {
                self.set_field_bulk(&objects, &s, &field, &value)
            }
            EditRequest::AddLine { section: s, key } => self.add_line(&s, &key),
            EditRequest::RemoveLine { section: s, key } => self.remove_line(&s, &key),
            EditRequest::Rename { kind, old, new } => self.rename(kind, &old, new.trim(), &keep),
            EditRequest::AddNode { node_type, xy } => self.add_node(node_type, xy),
            EditRequest::AddLink { link_type, from, to, vertices } => self.add_link(link_type, from, to, &vertices),
            EditRequest::AddSubcatchment { polygon } => self.add_subcatchment(&polygon),
            EditRequest::AddGage { xy } => self.add_gage(xy),
            EditRequest::Delete { objects } => self.delete(&objects),
            EditRequest::SetGeometry { object, points } => self.set_geometry(object, &points),
            EditRequest::Translate { objects, dx, dy } => self.translate(&objects, dx, dy),
            EditRequest::Reconnect { link, end, node } => self.reconnect(link, end, node),
            EditRequest::SetOptions { values } => self.set_options(&values),
            EditRequest::SetTitle { text } => self.set_title(&text),
            EditRequest::SetTable { table, old_name } => self.set_table(&table, old_name.as_deref()),
            EditRequest::AddTable { kind } => self.add_table(kind),
            EditRequest::DeleteTable { kind, name } => self.delete_table(kind, &name),
            EditRequest::AssignRdii { nodes, hydrograph, area } => {
                self.assign_rdii(&nodes, hydrograph.trim(), area.as_deref())
            }
            EditRequest::RemoveRdii { nodes } => self.remove_rdii(&nodes),
            EditRequest::SetCells { section: s, cells } => self.set_cells(&s, &cells),
            EditRequest::SetClimate { climate } => self.set_climate(&climate),
            EditRequest::SetSectionText { section: s, text } => self.set_section_text(&s, &text),
        }?;
        Ok(self.outcome(effect, keep))
    }

    pub fn undo(&mut self, selection: &[ObjRef]) -> Res<EditOutcome> {
        let keep = self.ids_of(selection);
        let a = self.history.undo(&mut self.inp).ok_or("nothing to undo")?;
        Ok(self.replayed("Undo", a, keep))
    }

    pub fn redo(&mut self, selection: &[ObjRef]) -> Res<EditOutcome> {
        let keep = self.ids_of(selection);
        let a = self.history.redo(&mut self.inp).ok_or("nothing to redo")?;
        Ok(self.replayed("Redo", a, keep))
    }

    /// Outcome of an undo or a redo: objects it brought back are selected.
    fn replayed(&mut self, verb: &str, a: Applied<()>, keep: Named) -> EditOutcome {
        let restored = defined(&a.changes);
        let effect = Effect {
            label: format!("{verb} {}", a.label),
            focus: (!restored.is_empty()).then_some(restored),
            ..Effect::from(a)
        };
        self.outcome(effect, keep)
    }
}
/// What the editors read, and saving.
impl Session {
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
        // Written by the app: not a change made by another program.
        self.inp_watch = crate::watch::Watch::new(&target);
        if target != self.inp_path {
            self.inp_path = target;
            self.save_project()?;
            // The autosave follows the model to its new file (the old one's is removed).
            if let Some(dir) = self.autosave.take().map(|a| a.dir().to_path_buf()) {
                self.start_autosave(&dir);
                // Changes left for the file it replaces are gone with it.
                self.discard_recovery();
            }
        }
        self.history.mark_saved();
        if let Some(a) = &self.autosave {
            a.clear();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
