//! An open model with its display geometry, results and report. No Tauri types here:
//! everything is testable headless; the `commands` modules only wrap it.
//!
//! - [`display`]: map geometry in display coordinates, spatial index, geometry buffer;
//! - [`results`]: the loaded and compared `.out` files and their cache;
//! - [`report`]: the `.rpt` of the loaded results.

mod display;
mod report;
mod results;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use swmm_geo::Crs;
use swmm_inp::InpFile;
use swmm_model::{Network, ObjKind, ObjRef, PropertyGroup};
use swmm_rpt::Report;

use crate::project::{Basemap, Project};

pub(crate) use display::Display;
pub use display::{GeometryPatch, Space};
pub use report::{BlockDto, ReportSummary};
pub(crate) use results::object_kind;
pub use results::{element_by_name, LoadedResults, ResultsInfo, VarInfo, VarValue};

pub type Res<T> = Result<T, String>;

/// The message of an error of the libraries, for the UI.
pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct Counts {
    pub nodes: usize,
    pub links: usize,
    pub subcatchments: usize,
    pub gages: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrsDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub path: PathBuf,
    pub name: String,
    pub title: Option<String>,
    pub flow_units: String,
    pub counts: Counts,
    pub crs: Option<CrsDto>,
    /// Suggested CRS when none is set.
    pub crs_hint: Option<CrsDto>,
    pub space: Space,
    /// Extent of the drawing in display coordinates.
    pub bounds: Option<[f64; 4]>,
    pub unprojected: usize,
    pub missing_coordinates: usize,
    pub project: Project,
    pub project_error: Option<String>,
    pub attributes: BTreeMap<String, Vec<String>>,
    pub results: Option<ResultsInfo>,
    /// Results compared with the loaded ones (run B).
    pub compare: Option<ResultsInfo>,
    /// Results of other runs drawn with each series of the time series graphs.
    pub overlays: Vec<ResultsInfo>,
    pub report: Option<ReportSummary>,
    /// Messages for the user (results that could not be loaded…).
    pub notes: Vec<String>,
    /// Unsaved changes.
    pub dirty: bool,
    /// Labels of the edits undo / redo would revert / apply.
    pub undo: Option<String>,
    pub redo: Option<String>,
    /// Changes on every edit, undo or redo.
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub role: String,
    pub object: ObjRef,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectInfo {
    pub object: ObjRef,
    pub id: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub groups: Vec<PropertyGroup>,
    /// Optional lines the object could have (inflows, RDII…).
    pub addable: Vec<swmm_model::Addable>,
    pub connections: Vec<Connection>,
    pub results: Option<Vec<VarValue>>,
}

pub struct Session {
    // The fields are for the modules that implement the session (`session`, `editing`,
    // `analysis`, `runs`, `model_views`, `export`); the commands go through its methods.
    pub(crate) inp_path: PathBuf,
    pub(crate) inp: InpFile,
    pub(crate) net: Network,
    pub(crate) project: Project,
    project_error: Option<String>,
    pub(crate) crs: Option<Crs>,
    pub(crate) display: Display,
    pub(crate) results: Option<LoadedResults>,
    /// Second results, for comparisons (difference maps, overlaid series).
    pub(crate) compare: Option<LoadedResults>,
    /// Results of other runs overlaid on the time series graphs.
    pub(crate) overlays: Vec<LoadedResults>,
    pub(crate) report: Option<(PathBuf, Report)>,
    /// Report of a run looked at in the simulation panel (not the loaded one).
    pub(crate) viewed_report: Option<(PathBuf, Report)>,
    notes: Vec<String>,
    pub(crate) history: swmm_model::edit::History,
    /// Incremented on every change of the model (edit, undo, redo).
    pub(crate) revision: u64,
    /// Observed series read from their files.
    pub(crate) observed_cache: crate::observed::Cache,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

impl Session {
    /// Opens a model and its project file, and loads linked (or most recent) results.
    pub fn open(path: &Path) -> Res<Session> {
        let inp = InpFile::read(path).map_err(|e| e.to_string())?;
        let net = Network::from_inp(&inp);
        let (project, project_error) = Project::load(path);
        let mut notes = Vec::new();
        let crs = match project.crs.as_deref().map(Crs::parse) {
            Some(Ok(c)) => Some(c),
            Some(Err(e)) => {
                notes.push(format!("Coordinate system ignored: {e}"));
                None
            }
            None => None,
        };
        let display = Display::build(&net, crs.as_ref(), None);
        let mut s = Session {
            inp_path: path.to_path_buf(),
            inp,
            net,
            project,
            project_error,
            crs,
            display,
            results: None,
            compare: None,
            overlays: Vec::new(),
            report: None,
            viewed_report: None,
            notes,
            history: Default::default(),
            revision: 0,
            observed_cache: Default::default(),
        };
        let (out, rpt) = s.find_results();
        if let Some(out) = out {
            if let Err(e) = s.open_results(&out) {
                s.notes.push(format!("Results {} not loaded: {e}", out.display()));
            }
        }
        if let Some(rpt) = rpt {
            if let Err(e) = s.open_report(&rpt) {
                s.notes.push(format!("Report {} not loaded: {e}", rpt.display()));
            }
        }
        Ok(s)
    }

    /// Results linked in the project, else the newest of `<model>.out` and the last run.
    fn find_results(&self) -> (Option<PathBuf>, Option<PathBuf>) {
        let linked = &self.project.results;
        if linked.out.is_some() || linked.rpt.is_some() {
            let keep = |p: &Option<PathBuf>| p.clone().filter(|p| p.exists());
            return (keep(&linked.out), keep(&linked.rpt));
        }
        let beside = (self.inp_path.with_extension("out"), self.inp_path.with_extension("rpt"));
        let run = swmm_engine::history::list_runs(&self.inp_path)
            .into_iter()
            .next()
            .map(|(d, r)| (d.join(r.out), d.join(r.rpt)));
        let mut candidates: Vec<(PathBuf, PathBuf)> = vec![beside];
        candidates.extend(run);
        candidates.retain(|(o, r)| o.exists() || r.exists());
        candidates.sort_by_key(|(o, r)| std::cmp::Reverse(mtime(o).or(mtime(r))));
        match candidates.into_iter().next() {
            Some((o, r)) => (o.exists().then_some(o), r.exists().then_some(r)),
            None => (None, None),
        }
    }

    pub fn info(&self) -> ModelInfo {
        let net = &self.net;
        let title = self
            .inp
            .section(&swmm_inp::SectionKind::Title)
            .and_then(|s| s.data().map(|(_, l)| l.text().trim().to_string()).find(|t| !t.is_empty()));
        let mut attributes = BTreeMap::new();
        for k in [ObjKind::Node, ObjKind::Link, ObjKind::Subcatchment] {
            attributes
                .insert(k.name().to_string(), swmm_model::attribute_names(k).iter().map(|s| s.to_string()).collect());
        }
        let missing = net.nodes.iter().filter(|n| n.xy.is_none()).count();
        ModelInfo {
            path: self.inp_path.clone(),
            name: self.inp_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            title,
            flow_units: self.inp.flow_units().name().to_string(),
            counts: Counts {
                nodes: net.nodes.len(),
                links: net.links.len(),
                subcatchments: net.subcatchments.len(),
                gages: net.gages.len(),
            },
            crs: self.crs.as_ref().map(|c| CrsDto { id: c.id.clone(), name: c.name.clone() }),
            crs_hint: if self.crs.is_none() { self.crs_hint() } else { None },
            space: self.display.space,
            bounds: self.display.bounds.or_else(|| self.empty_extent()),
            unprojected: self.display.unprojected,
            missing_coordinates: missing,
            project: self.project.clone(),
            project_error: self.project_error.clone(),
            attributes,
            results: self.results_info(),
            compare: self.compare.as_ref().map(LoadedResults::info),
            overlays: self.overlays.iter().map(LoadedResults::info).collect(),
            report: self.report_summary(),
            notes: self.notes.clone(),
            dirty: self.history.is_dirty(),
            undo: self.history.undo_label().map(str::to_string),
            redo: self.history.redo_label().map(str::to_string),
            revision: self.revision,
        }
    }

    /// Extent shown for a model with nothing drawn yet: around the origin of its
    /// projection rather than at 0°, 0° (a new model is then drawn where it belongs).
    fn empty_extent(&self) -> Option<[f64; 4]> {
        const HALF: f64 = 0.05;
        let [lon, lat] = self.crs.as_ref()?.origin()?;
        Some([lon - HALF, lat - HALF, lon + HALF, lat + HALF])
    }

    /// Coordinate system suggested by the extent of the model.
    fn crs_hint(&self) -> Option<CrsDto> {
        swmm_geo::crs::guess(self.net.bounds()?).map(|c| CrsDto { id: c.id(), name: c.name })
    }

    /// Sets the coordinate system (`None` = local coordinates) and saves the project.
    pub fn set_crs(&mut self, id: Option<&str>) -> Res<()> {
        let crs = match id {
            Some(s) => Some(Crs::parse(s).map_err(|e| e.to_string())?),
            None => None,
        };
        self.project.crs = crs.as_ref().map(|c| c.id.clone());
        self.crs = crs;
        self.display = Display::build(&self.net, self.crs.as_ref(), None);
        self.save_project()
    }

    pub fn save_project(&self) -> Res<()> {
        self.project.save(&self.inp_path).map_err(|e| format!("cannot save the project file: {e}"))
    }

    /// Name of the engine chosen for this model (`None`: the default engine).
    pub fn project_engine(&self) -> Option<&str> {
        self.project.engine.as_deref()
    }

    /// Chooses the engine of this model and saves the choice in the project.
    pub fn set_project_engine(&mut self, name: Option<String>) -> Res<()> {
        self.project.engine = name;
        self.save_project()
    }

    /// Saves in the project what the UI keeps there: the basemap, and its own settings.
    pub fn update_project(&mut self, basemap: Option<Basemap>, ui: Option<serde_json::Value>) -> Res<()> {
        if let Some(b) = basemap {
            self.project.basemap = b;
        }
        if let Some(ui) = ui {
            self.project.ui = ui;
        }
        self.save_project()
    }

    /// File of the model.
    pub fn model_path(&self) -> &Path {
        &self.inp_path
    }

    /// The model as it is now, unsaved edits included, to run it.
    pub fn model_copy(&self) -> InpFile {
        self.inp.clone()
    }

    /// File of the loaded results.
    pub fn results_path(&self) -> Option<&Path> {
        self.results.as_ref().map(|r| r.path.as_path())
    }

    pub fn ids(&self, kind: ObjKind) -> Vec<&str> {
        (0..self.net.len(kind) as u32).map(|index| self.net.id(ObjRef { kind, index })).collect()
    }

    /// Geometry for the map (see [`Display::encode`]).
    pub fn geometry(&self) -> Vec<u8> {
        self.display.encode(&self.net)
    }

    /// Closest object to a point (display coordinates), within `tol` index units
    /// (Web Mercator metres or model units).
    pub fn pick(&self, p: [f64; 2], tol: f64) -> Option<ObjRef> {
        self.display.pick(p, tol)
    }

    /// Every object within `tol` of a point, best first: the map keeps the first one it shows.
    pub fn pick_all(&self, p: [f64; 2], tol: f64) -> Vec<ObjRef> {
        self.display.pick_all(p, tol)
    }

    pub fn select_rect(&self, a: [f64; 2], b: [f64; 2]) -> Vec<ObjRef> {
        self.display.in_rect(a, b)
    }

    pub fn select_polygon(&self, ring: &[[f64; 2]]) -> Vec<ObjRef> {
        self.display.in_polygon(ring)
    }

    pub fn find(&self, id: &str) -> Option<ObjRef> {
        self.net.find_any(id.trim())
    }

    fn check(&self, r: ObjRef) -> Res<()> {
        if (r.index as usize) < self.net.len(r.kind) {
            Ok(())
        } else {
            Err(format!("no {} #{}", r.kind.name(), r.index))
        }
    }

    pub fn object(&self, r: ObjRef, period: Option<usize>) -> Res<ObjectInfo> {
        self.check(r)?;
        let net = &self.net;
        let i = r.index as usize;
        let mut connections = Vec::new();
        let mut conn = |role: &str, o: ObjRef| {
            connections.push(Connection { role: role.into(), object: o, id: net.id(o).to_string() })
        };
        let type_name = match r.kind {
            ObjKind::Node => {
                for l in net.node_links(r.index) {
                    let link = &net.links[l as usize];
                    let role = if link.to == Some(r.index) { "Inflow link" } else { "Outflow link" };
                    conn(role, ObjRef { kind: ObjKind::Link, index: l });
                }
                format!("{:?}", net.nodes[i].kind)
            }
            ObjKind::Link => {
                let l = &net.links[i];
                if let Some(n) = l.from {
                    conn("From node", ObjRef { kind: ObjKind::Node, index: n });
                }
                if let Some(n) = l.to {
                    conn("To node", ObjRef { kind: ObjKind::Node, index: n });
                }
                format!("{:?}", l.kind)
            }
            ObjKind::Subcatchment => {
                let s = &net.subcatchments[i];
                if let Some(o) = s.outlet {
                    conn("Outlet", o);
                }
                if let Some(g) = s.gage {
                    conn("Rain gage", ObjRef { kind: ObjKind::Gage, index: g });
                }
                "Subcatchment".into()
            }
            ObjKind::Gage => "Rain gage".into(),
        };
        let results = match (period, &self.results, results::element(r.kind)) {
            (Some(p), Some(lr), Some(ek)) => lr.object_values(ek, i, p),
            _ => None,
        };
        Ok(ObjectInfo {
            object: r,
            id: net.id(r).to_string(),
            type_name,
            groups: swmm_model::properties(&self.inp, net, r),
            addable: swmm_model::addable(&self.inp, net, r),
            connections,
            results,
        })
    }

    pub fn attribute(&self, kind: ObjKind, name: &str) -> Res<Vec<f32>> {
        swmm_model::attribute(&self.inp, &self.net, kind, name).ok_or_else(|| format!("no attribute {name}"))
    }
}

#[cfg(test)]
mod tests;
