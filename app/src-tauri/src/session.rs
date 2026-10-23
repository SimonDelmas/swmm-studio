//! An open model with its display geometry, results and report. No Tauri types here:
//! everything is testable headless; `commands.rs` only wraps it.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use swmm_geo::{mercator, Crs, Hit, SpatialIndex};
use swmm_inp::InpFile;
use swmm_model::{LinkType, Network, NodeType, ObjKind, ObjRef, PropertyGroup};
use swmm_out::{ElementKind, MinMax, Results};
use swmm_rpt::{Body, Report};

use crate::project::Project;

pub type Res<T> = Result<T, String>;

/// Series read straight from a `.out` without a cache touch every page of the range;
/// beyond this many bytes the request waits for the cache.
const DIRECT_READ_LIMIT: u64 = 256 << 20;

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
    bounds: Option<[f64; 4]>,
    /// Points that could not be reprojected.
    unprojected: usize,
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
            if s.polygon.len() >= 3 {
                sub_pts.extend_from_slice(&s.polygon);
                if s.polygon.first() != s.polygon.last() {
                    sub_pts.push(s.polygon[0]);
                }
            }
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
            match (crs, space) {
                (Some(c), _) => c.to_lonlat(arr),
                (None, Space::Cartesian { origin }) => {
                    arr.iter_mut().for_each(|p| *p = [p[0] - origin[0], p[1] - origin[1]])
                }
                (None, Space::LonLat) => unreachable!(),
            }
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
        match (crs, self.space) {
            (Some(c), _) => c.to_lonlat(pts),
            (None, Space::Cartesian { origin }) => {
                pts.iter_mut().for_each(|p| *p = [p[0] - origin[0], p[1] - origin[1]])
            }
            (None, Space::LonLat) => {}
        }
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
    pub(crate) fn patch(&self, net: &Network, r: &swmm_model::Refresh) -> Option<GeometryPatch> {
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
            subcatchments: r.subcatchments.iter().map(|&i| (i, self.sub(i as usize).to_vec())).collect(),
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
    pub(crate) fn update(&mut self, net: &Network, crs: Option<&Crs>, r: &swmm_model::Refresh) {
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
                    if s.polygon.len() >= 3 {
                        let mut p = s.polygon.clone();
                        if p.first() != p.last() {
                            p.push(p[0]);
                        }
                        self.project(crs, &mut p);
                        pts.extend(p);
                    }
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
    /// Closed ring (empty when the subcatchment has no outline).
    pub subcatchments: Vec<(u32, Vec<[f64; 2]>)>,
}

/// State of the results cache of the open `.out`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum CacheState {
    Ready,
    Building {
        progress: f64,
    },
    Failed {
        message: String,
    },
    /// The file cannot be cached (simulation still running or crashed).
    Unavailable {
        message: String,
    },
}

pub struct LoadedResults {
    pub path: PathBuf,
    pub results: Results,
    /// For each network object, its index in the `.out` (`u32::MAX` if absent), by
    /// [`ElementKind`] (subcatchments, nodes, links).
    to_out: [Vec<u32>; 3],
    matched: [usize; 3],
    pub cache: CacheState,
}

fn element(kind: ObjKind) -> Option<ElementKind> {
    match kind {
        ObjKind::Node => Some(ElementKind::Node),
        ObjKind::Link => Some(ElementKind::Link),
        ObjKind::Subcatchment => Some(ElementKind::Subcatchment),
        ObjKind::Gage => None,
    }
}

/// Element kind by name (`node`, `link`, `subcatchment`, `system`).
pub fn element_by_name(s: &str) -> Res<ElementKind> {
    ElementKind::from_name(s).ok_or_else(|| format!("unknown object kind {s:?}"))
}

#[derive(Debug, Clone, Serialize)]
pub struct VarInfo {
    pub name: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResultsInfo {
    pub path: PathBuf,
    pub n_periods: usize,
    /// Time of period 0, milliseconds since 1970 (model clock, shown as UTC).
    pub start_ms: i64,
    pub step_secs: i64,
    pub complete: bool,
    pub flow_units: String,
    pub version: i32,
    pub variables: std::collections::BTreeMap<String, Vec<VarInfo>>,
    /// Network objects found in the file, per kind.
    pub matched: std::collections::BTreeMap<String, usize>,
    /// Objects in the file, per kind.
    pub in_file: std::collections::BTreeMap<String, usize>,
    pub cache: CacheState,
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
    pub attributes: std::collections::BTreeMap<String, Vec<String>>,
    pub results: Option<ResultsInfo>,
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
pub struct MessageDto {
    pub code: String,
    pub text: String,
    pub line: Option<usize>,
    pub section: Option<String>,
    pub context: Option<String>,
    pub object: Option<ObjRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockInfo {
    pub title: String,
    pub kind: &'static str,
    pub rows: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportSummary {
    pub path: PathBuf,
    pub version: Option<String>,
    pub errors: Vec<MessageDto>,
    pub warnings: Vec<MessageDto>,
    /// `(balance, error %)`.
    pub continuity: Vec<(String, f64)>,
    pub blocks: Vec<BlockInfo>,
    pub analysis_begun: Option<String>,
    pub analysis_ended: Option<String>,
    pub elapsed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockDto {
    pub title: String,
    pub value_headers: Vec<String>,
    pub kind: &'static str,
    pub columns: Vec<String>,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub footer: Vec<Vec<String>>,
    pub notes: Vec<String>,
    /// Kind of the objects named in the first column, when they are network objects.
    pub id_kind: Option<ObjKind>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VarValue {
    pub name: String,
    pub unit: String,
    pub value: f32,
    /// Whole-run maximum and its period, when the cache is ready.
    pub max: Option<f32>,
    pub max_period: Option<usize>,
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
    pub inp_path: PathBuf,
    pub inp: InpFile,
    pub net: Network,
    pub project: Project,
    project_error: Option<String>,
    pub(crate) crs: Option<Crs>,
    pub(crate) display: Display,
    pub results: Option<LoadedResults>,
    pub report: Option<(PathBuf, Report)>,
    notes: Vec<String>,
    pub(crate) history: swmm_model::edit::History,
    /// Incremented on every change of the model (edit, undo, redo).
    pub(crate) revision: u64,
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
            report: None,
            notes,
            history: Default::default(),
            revision: 0,
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
        let mut attributes = std::collections::BTreeMap::new();
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
            bounds: self.display.bounds,
            unprojected: self.display.unprojected,
            missing_coordinates: missing,
            project: self.project.clone(),
            project_error: self.project_error.clone(),
            attributes,
            results: self.results_info(),
            report: self.report_summary(),
            notes: self.notes.clone(),
            dirty: self.history.is_dirty(),
            undo: self.history.undo_label().map(str::to_string),
            redo: self.history.redo_label().map(str::to_string),
            revision: self.revision,
        }
    }

    /// Guess from the coordinate ranges: degrees, or French Lambert 93.
    fn crs_hint(&self) -> Option<CrsDto> {
        let b = self.net.bounds()?;
        let code = if b[0] >= -180.0 && b[2] <= 180.0 && b[1] >= -90.0 && b[3] <= 90.0 && b[2] - b[0] < 20.0 {
            4326
        } else if b[0] > 50_000.0 && b[2] < 1_300_000.0 && b[1] > 6_000_000.0 && b[3] < 7_200_000.0 {
            2154
        } else {
            return None;
        };
        swmm_geo::crs::lookup(code).map(|c| CrsDto { id: c.id(), name: c.name })
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

    /// Geometry for the map, as one little-endian buffer:
    ///
    /// ```text
    /// 0   "SWG1"
    /// 4   u32 space (0 cartesian, 1 lon/lat)
    /// 8   f64 origin x, f64 origin y
    /// 24  u32 nodes, links, link points, subcatchments, subcatchment points, gages
    /// 48  padding to 64
    /// 64  f64 xy: nodes, link points, subcatchment points (closed rings), gages
    ///     u32 link starts (links + 1), subcatchment starts (subcatchments + 1)
    ///     u32 link end nodes (from, to per link; u32::MAX when unknown)
    ///     u8 node types, link types
    /// ```
    pub fn geometry(&self) -> Vec<u8> {
        let d = &self.display;
        let mut b = Vec::with_capacity(64 + 16 * (d.nodes.len() + d.link_pts.len() + d.sub_pts.len()));
        b.extend_from_slice(b"SWG2");
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
        for l in &self.net.links {
            b.extend_from_slice(&l.from.unwrap_or(u32::MAX).to_le_bytes());
            b.extend_from_slice(&l.to.unwrap_or(u32::MAX).to_le_bytes());
        }
        b.extend(self.net.nodes.iter().map(|n| match n.kind {
            NodeType::Junction => 0u8,
            NodeType::Outfall => 1,
            NodeType::Divider => 2,
            NodeType::Storage => 3,
        }));
        b.extend(self.net.links.iter().map(|l| match l.kind {
            LinkType::Conduit => 0u8,
            LinkType::Pump => 1,
            LinkType::Orifice => 2,
            LinkType::Weir => 3,
            LinkType::Outlet => 4,
        }));
        b
    }

    pub fn ids(&self, kind: ObjKind) -> Vec<&str> {
        (0..self.net.len(kind) as u32).map(|index| self.net.id(ObjRef { kind, index })).collect()
    }

    fn hits(hits: Vec<Hit>) -> Vec<ObjRef> {
        hits.into_iter().map(|h| ObjRef { kind: kind_of_layer(h.layer), index: h.index }).collect()
    }

    /// Closest object to a point (display coordinates), within `tol` index units
    /// (Web Mercator metres or model units).
    pub fn pick(&self, p: [f64; 2], tol: f64) -> Option<ObjRef> {
        let d = &self.display;
        d.index.nearest(d.to_index(p), tol).map(|h| ObjRef { kind: kind_of_layer(h.layer), index: h.index })
    }

    pub fn select_rect(&self, a: [f64; 2], b: [f64; 2]) -> Vec<ObjRef> {
        let d = &self.display;
        Self::hits(d.index.in_rect(d.to_index(a), d.to_index(b)))
    }

    pub fn select_polygon(&self, ring: &[[f64; 2]]) -> Vec<ObjRef> {
        let d = &self.display;
        let ring: Vec<_> = ring.iter().map(|p| d.to_index(*p)).collect();
        Self::hits(d.index.in_polygon(&ring))
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
        let results = match (period, &self.results, element(r.kind)) {
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

    // ---- results ---------------------------------------------------------------

    pub fn open_results(&mut self, path: &Path) -> Res<()> {
        let results = Results::open(path).map_err(|e| e.to_string())?;
        let meta = results.meta();
        let (to_out, matched) = match_results(meta, &self.net);
        if matched.iter().sum::<usize>() == 0
            && meta.ids(ElementKind::Node).len() + meta.ids(ElementKind::Link).len() > 0
        {
            return Err("no object of the results file is in the model".into());
        }
        let cache = if results.cache().is_some() {
            CacheState::Ready
        } else if !meta.complete {
            CacheState::Unavailable { message: "the simulation did not finish writing this file".into() }
        } else {
            // The caller starts the background build.
            CacheState::Building { progress: 0.0 }
        };
        self.results = Some(LoadedResults { path: path.to_path_buf(), results, to_out, matched, cache });
        self.project.results.out = Some(path.to_path_buf());
        Ok(())
    }

    pub fn open_report(&mut self, path: &Path) -> Res<()> {
        let report = Report::read(path).map_err(|e| e.to_string())?;
        self.report = Some((path.to_path_buf(), report));
        self.project.results.rpt = Some(path.to_path_buf());
        Ok(())
    }

    pub fn results_info(&self) -> Option<ResultsInfo> {
        let lr = self.results.as_ref()?;
        let m = lr.results.meta();
        let mut variables = std::collections::BTreeMap::new();
        let mut matched = std::collections::BTreeMap::new();
        let mut in_file = std::collections::BTreeMap::new();
        for ek in ElementKind::ALL {
            let vars = m
                .var_names(ek)
                .into_iter()
                .enumerate()
                .map(|(v, name)| VarInfo { name, unit: swmm_out::format::unit(ek, v, m.flow_units).to_string() })
                .collect();
            variables.insert(ek.name().to_string(), vars);
            in_file.insert(ek.name().to_string(), m.count(ek));
            if ek != ElementKind::System {
                matched.insert(ek.name().to_string(), lr.matched[ek as usize]);
            }
        }
        Some(ResultsInfo {
            path: lr.path.clone(),
            n_periods: m.n_periods,
            start_ms: m.time(0).and_utc().timestamp_millis(),
            step_secs: m.report_step_secs as i64,
            complete: m.complete,
            flow_units: m.flow_units.name().to_string(),
            version: m.version,
            variables,
            matched,
            in_file,
            cache: lr.cache.clone(),
        })
    }

    fn loaded(&self) -> Res<&LoadedResults> {
        self.results.as_ref().ok_or_else(|| "no results loaded".to_string())
    }

    /// One variable for every network object of a kind at a period (NaN where the
    /// object is not in the results).
    pub fn frame(&self, kind: ElementKind, var: usize, period: usize) -> Res<Vec<f32>> {
        let lr = self.loaded()?;
        let raw = lr.results.frame(kind, var, period).map_err(|e| e.to_string())?;
        if kind == ElementKind::System {
            return Ok(raw);
        }
        Ok(lr.to_out[kind as usize].iter().map(|&o| raw.get(o as usize).copied().unwrap_or(f32::NAN)).collect())
    }

    /// Whole-run maximum of a variable for every network object (needs the cache).
    pub fn envelope_max(&self, kind: ElementKind, var: usize) -> Res<Vec<f32>> {
        let lr = self.loaded()?;
        let env = lr.results.envelope(kind, var).map_err(|e| e.to_string())?;
        if kind == ElementKind::System {
            return Ok(env.iter().map(|s| s.max).collect());
        }
        Ok(lr.to_out[kind as usize].iter().map(|&o| env.get(o as usize).map_or(f32::NAN, |s| s.max)).collect())
    }

    /// Index in the `.out` of a network object (`system`: 0).
    fn out_index(&self, kind: ElementKind, index: usize) -> Res<usize> {
        let lr = self.loaded()?;
        if kind == ElementKind::System {
            return Ok(0);
        }
        match lr.to_out[kind as usize].get(index) {
            Some(&o) if o != u32::MAX => Ok(o as usize),
            _ => Err(format!("{} #{index} has no results", kind.name())),
        }
    }

    /// Min/max envelope of a series over `[p0, p1)` in about `buckets` points.
    pub fn series(
        &self,
        kind: ElementKind,
        index: usize,
        var: usize,
        p0: usize,
        p1: usize,
        buckets: usize,
    ) -> Res<MinMax> {
        let lr = self.loaded()?;
        let o = self.out_index(kind, index)?;
        let p1 = p1.min(lr.results.out().n_periods());
        if lr.results.cache().is_none() {
            let bytes = (p1.saturating_sub(p0)) as u64 * lr.results.out().layout().bytes_per_period();
            if bytes > DIRECT_READ_LIMIT {
                return Err(match &lr.cache {
                    CacheState::Building { progress } => {
                        format!("building the results cache ({:.0}%): zoom in or wait", progress * 100.0)
                    }
                    _ => "range too long to read without the results cache: zoom in".into(),
                });
            }
        }
        lr.results.series_minmax(kind, o, var, p0..p1, buckets).map_err(|e| e.to_string())
    }

    /// Period of the maximum of a series over the whole run.
    pub fn time_of_max(&self, kind: ElementKind, index: usize, var: usize) -> Res<usize> {
        let lr = self.loaded()?;
        self.check_long_read(lr)?;
        let o = self.out_index(kind, index)?;
        lr.results.stats(kind, o, var).map(|s| s.argmax).map_err(|e| e.to_string())
    }

    /// Start of the next event (rise above `threshold`) after `from`.
    pub fn next_event(
        &self,
        kind: ElementKind,
        index: usize,
        var: usize,
        from: usize,
        threshold: f32,
    ) -> Res<Option<usize>> {
        let lr = self.loaded()?;
        self.check_long_read(lr)?;
        let o = self.out_index(kind, index)?;
        lr.results.next_rise(kind, o, var, from, threshold).map_err(|e| e.to_string())
    }

    fn check_long_read(&self, lr: &LoadedResults) -> Res<()> {
        let size = lr.results.out().n_periods() as u64 * lr.results.out().layout().bytes_per_period();
        if lr.results.cache().is_none() && size > DIRECT_READ_LIMIT {
            return Err("this needs the results cache, which is not ready yet".into());
        }
        Ok(())
    }

    /// `.out` to cache in the background, if its cache is missing.
    pub fn cache_job(&self) -> Option<PathBuf> {
        let lr = self.results.as_ref()?;
        matches!(lr.cache, CacheState::Building { .. }).then(|| lr.path.clone())
    }

    /// Called when the background build of `path` ends.
    pub fn cache_done(&mut self, path: &Path, outcome: Result<(), String>) {
        let Some(lr) = self.results.as_mut().filter(|lr| lr.path == path) else {
            return;
        };
        lr.cache = match outcome.and_then(|()| lr.results.reload_cache().map_err(|e| e.to_string())) {
            Ok(()) => CacheState::Ready,
            Err(message) => CacheState::Failed { message },
        };
    }

    pub fn cache_progress(&mut self, path: &Path, progress: f64) {
        if let Some(lr) = self.results.as_mut().filter(|lr| lr.path == path) {
            if matches!(lr.cache, CacheState::Building { .. }) {
                lr.cache = CacheState::Building { progress };
            }
        }
    }

    // ---- report ----------------------------------------------------------------

    fn message(&self, m: &swmm_rpt::Message) -> MessageDto {
        MessageDto {
            code: m.code.clone(),
            text: m.text.clone(),
            line: m.line,
            section: m.section.clone(),
            context: m.context.clone(),
            object: m.object().and_then(|id| self.net.find_any(id)),
        }
    }

    pub fn report_summary(&self) -> Option<ReportSummary> {
        let (path, r) = self.report.as_ref()?;
        let c = r.continuity();
        let continuity = [
            ("Runoff quantity", c.runoff_quantity),
            ("Groundwater", c.groundwater),
            ("Flow routing", c.flow_routing),
            ("Runoff quality", c.runoff_quality),
            ("Quality routing", c.quality_routing),
        ]
        .into_iter()
        .filter_map(|(n, v)| v.map(|v| (n.to_string(), v)))
        .collect();
        let blocks = r
            .blocks
            .iter()
            .map(|b| {
                let (kind, rows) = match &b.body {
                    Body::Table(t) => ("table", t.rows.len()),
                    Body::KeyValues(kv) => ("values", kv.len()),
                    Body::Text(t) => ("text", t.len()),
                };
                BlockInfo { title: b.title.clone(), kind, rows }
            })
            .collect();
        Some(ReportSummary {
            path: path.clone(),
            version: r.version.clone(),
            errors: r.errors.iter().map(|m| self.message(m)).collect(),
            warnings: r.warnings.iter().map(|m| self.message(m)).collect(),
            continuity,
            blocks,
            analysis_begun: r.analysis_begun.clone(),
            analysis_ended: r.analysis_ended.clone(),
            elapsed: r.elapsed.clone(),
        })
    }

    pub fn report_block(&self, i: usize) -> Res<BlockDto> {
        let (_, r) = self.report.as_ref().ok_or("no report loaded")?;
        let b = r.blocks.get(i).ok_or_else(|| format!("no report block #{i}"))?;
        let mut dto = BlockDto {
            title: b.title.clone(),
            value_headers: b.value_headers.clone(),
            kind: "text",
            columns: Vec::new(),
            header: Vec::new(),
            rows: Vec::new(),
            footer: Vec::new(),
            notes: Vec::new(),
            id_kind: None,
        };
        match &b.body {
            Body::Table(t) => {
                dto.kind = "table";
                dto.columns = t.columns.clone();
                dto.header = t.header.clone();
                dto.rows = t.rows.clone();
                dto.footer = t.footer.clone();
                dto.notes = t.notes.clone();
                dto.id_kind = self.id_kind(t.rows.iter().filter_map(|r| r.first()));
            }
            Body::KeyValues(kv) => {
                dto.kind = "values";
                dto.columns = std::iter::once("".to_string()).chain(b.value_headers.iter().cloned()).collect();
                dto.rows = kv
                    .iter()
                    .map(|k| std::iter::once(k.key.clone()).chain(k.values.iter().cloned()).collect())
                    .collect();
            }
            Body::Text(t) => dto.notes = t.clone(),
        }
        Ok(dto)
    }

    /// Kind of object most first-column cells name (looking at up to 50 rows).
    fn id_kind<'a>(&self, cells: impl Iterator<Item = &'a String>) -> Option<ObjKind> {
        let mut counts = [0usize; 4];
        let mut n = 0;
        for c in cells.take(50) {
            n += 1;
            for k in ObjKind::ALL {
                if self.net.find(k, c).is_some() {
                    counts[k as usize] += 1;
                    break;
                }
            }
        }
        let (best, count) = counts.iter().enumerate().max_by_key(|(_, c)| **c)?;
        (*count > 0 && *count * 2 >= n).then(|| ObjKind::ALL[best])
    }
}

/// For each network object, its index in the results (by element kind), and how many
/// objects matched.
fn match_results(meta: &swmm_out::OutMeta, net: &Network) -> ([Vec<u32>; 3], [usize; 3]) {
    let mut to_out: [Vec<u32>; 3] = Default::default();
    let mut matched = [0usize; 3];
    for (ek, ok) in [
        (ElementKind::Subcatchment, ObjKind::Subcatchment),
        (ElementKind::Node, ObjKind::Node),
        (ElementKind::Link, ObjKind::Link),
    ] {
        let mut map = vec![u32::MAX; net.len(ok)];
        for (oi, id) in meta.ids(ek).iter().enumerate() {
            if let Some(ni) = net.find(ok, id) {
                map[ni as usize] = oi as u32;
                matched[ek as usize] += 1;
            }
        }
        to_out[ek as usize] = map;
    }
    (to_out, matched)
}

impl LoadedResults {
    /// Matches the results again after the network was rebuilt by an edit.
    pub(crate) fn remap(&mut self, net: &Network) {
        (self.to_out, self.matched) = match_results(self.results.meta(), net);
    }

    fn object_values(&self, kind: ElementKind, index: usize, period: usize) -> Option<Vec<VarValue>> {
        let o = *self.to_out[kind as usize].get(index).filter(|&&o| o != u32::MAX)? as usize;
        let m = self.results.meta();
        let values = self.results.out().object_values(kind, o, period.min(m.n_periods.saturating_sub(1))).ok()?;
        let names = m.var_names(kind);
        Some(
            values
                .into_iter()
                .enumerate()
                .map(|(v, value)| {
                    let stats = self.results.cache().map(|c| c.stats(m.layout.series(kind, o, v)));
                    VarValue {
                        name: names[v].clone(),
                        unit: swmm_out::format::unit(kind, v, m.flow_units).to_string(),
                        value,
                        max: stats.map(|s| s.max),
                        max_period: stats.map(|s| s.argmax),
                    }
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use swmm_out::{OutSpec, OutWriter};

    const TINY: &str = include_str!("../../../testdata/tiny.inp");

    const RPT: &str = "
  EPA STORM WATER MANAGEMENT MODEL - VERSION 5.2 (Build 5.2.4)

  WARNING 04: minimum elevation drop used for Conduit C2

  **************************        Volume        Volume
  Flow Routing Continuity        hectare-m      10^6 ltr
  **************************     ---------     ---------
  Continuity Error (%) .....        -0.081


  ******************
  Node Depth Summary
  ******************

  ---------------------------------------------------------------------------------
                                 Average  Maximum  Maximum  Time of Max    Reported
                                   Depth    Depth      HGL   Occurrence   Max Depth
  Node                 Type       Meters   Meters   Meters  days hr:min      Meters
  ---------------------------------------------------------------------------------
  J1                   JUNCTION     0.01     0.06   100.06     0  04:01        0.06
  Out1                 OUTFALL      0.01     0.07    97.87     0  04:13        0.06
";

    /// `tiny.inp` with a results file whose node order differs from the model's, and
    /// value = 1000 * period + series index.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("tiny.inp");
        std::fs::write(&inp, TINY).unwrap();
        let mut spec = OutSpec::simple(2, 4, 3, 45_444.0, 300);
        spec.nodes = ["Out1", "J1", "J2", "J3"].map(String::from).to_vec();
        spec.links = ["C1", "C2", "C3"].map(String::from).to_vec();
        let mut w = OutWriter::create(inp.with_extension("out"), &spec).unwrap();
        let n = w.layout().values_per_period();
        for p in 0..40 {
            let values: Vec<f32> = (0..n).map(|i| (p * 1000 + i) as f32).collect();
            w.write_period(45_444.0 + (p + 1) as f64 * 300.0 / 86_400.0, &values).unwrap();
        }
        w.finish(0).unwrap();
        std::fs::write(inp.with_extension("rpt"), RPT).unwrap();
        (dir, inp)
    }

    #[test]
    fn open_finds_results_and_report() {
        let (_dir, inp) = fixture();
        let s = Session::open(&inp).unwrap();
        let info = s.info();
        assert_eq!((info.counts.nodes, info.counts.links, info.counts.subcatchments, info.counts.gages), (4, 3, 2, 1));
        assert_eq!(info.flow_units, "LPS");
        assert_eq!(info.crs_hint.as_ref().map(|c| c.id.as_str()), Some("EPSG:2154"));
        assert!(matches!(info.space, Space::Cartesian { .. }));
        let r = info.results.unwrap();
        assert_eq!((r.n_periods, r.step_secs), (40, 300));
        assert_eq!(r.matched["node"], 4);
        assert_eq!(r.cache, CacheState::Building { progress: 0.0 });
        let rep = info.report.unwrap();
        assert_eq!(rep.warnings[0].object, Some(ObjRef { kind: ObjKind::Link, index: 1 }));
        assert_eq!(rep.continuity, vec![("Flow routing".to_string(), -0.081)]);
        let i = rep.blocks.iter().position(|b| b.title == "Node Depth Summary").unwrap();
        let b = s.report_block(i).unwrap();
        assert_eq!((b.kind, b.rows.len(), b.id_kind), ("table", 2, Some(ObjKind::Node)));
    }

    #[test]
    fn frames_follow_network_order() {
        let (_dir, inp) = fixture();
        let s = Session::open(&inp).unwrap();
        let lr = s.results.as_ref().unwrap();
        let layout = *lr.results.out().layout();
        // Network node 0 is J1, which is node 1 in the file.
        let f = s.frame(ElementKind::Node, 0, 3).unwrap();
        assert_eq!(f[0], (3000 + layout.series(ElementKind::Node, 1, 0)) as f32);
        assert_eq!(f[3], (3000 + layout.series(ElementKind::Node, 0, 0)) as f32);
        let mm = s.series(ElementKind::Node, 0, 0, 0, 40, 100).unwrap();
        assert_eq!(mm.len(), 40);
        assert_eq!(mm.max[5], (5000 + layout.series(ElementKind::Node, 1, 0)) as f32);
        assert_eq!(s.time_of_max(ElementKind::Link, 2, 0).unwrap(), 39);
        assert!(s.envelope_max(ElementKind::Node, 0).is_err());
        assert_eq!(s.next_event(ElementKind::Link, 2, 0, 0, 20_000.0).unwrap(), Some(20));
        let o = s.object(ObjRef { kind: ObjKind::Node, index: 0 }, Some(2)).unwrap();
        let depth = &o.results.unwrap()[0];
        assert_eq!((depth.name.as_str(), depth.unit.as_str(), depth.value), ("depth", "m", f[0] - 1000.0));
        assert_eq!(o.connections[0].id, "C1");
        assert!(!o.groups.iter().any(|g| g.title == "RDII"));
        let j2 = s.object(ObjRef { kind: ObjKind::Node, index: 1 }, None).unwrap();
        assert!(j2.groups.iter().any(|g| g.title == "RDII"));
    }

    #[test]
    fn crs_and_selection() {
        let (_dir, inp) = fixture();
        let mut s = Session::open(&inp).unwrap();
        // Cartesian: J1 is at (651200, 6862100) minus the origin.
        let Space::Cartesian { origin } = s.display.space else { panic!() };
        let j1 = [651_200.0 - origin[0], 6_862_100.0 - origin[1]];
        assert_eq!(s.pick(j1, 1.0), Some(ObjRef { kind: ObjKind::Node, index: 0 }));
        s.set_crs(Some("EPSG:2154")).unwrap();
        assert!(crate::project::project_path(&inp).exists());
        let info = s.info();
        assert_eq!(info.crs.unwrap().name, "RGF93 / Lambert-93");
        let b = info.bounds.unwrap();
        assert!(b[0] > 2.3 && b[2] < 2.4 && b[1] > 48.8 && b[3] < 48.9, "{b:?}");
        let geom = s.geometry();
        assert_eq!(&geom[0..4], b"SWG2");
        assert_eq!(u32::from_le_bytes(geom[4..8].try_into().unwrap()), 1);
        // J1 in lon/lat, then picked with a 1 m tolerance.
        let lon = f64::from_le_bytes(geom[64..72].try_into().unwrap());
        let lat = f64::from_le_bytes(geom[72..80].try_into().unwrap());
        assert_eq!(s.pick([lon, lat], 1.0), Some(ObjRef { kind: ObjKind::Node, index: 0 }));
        // Box around the whole model.
        let all = s.select_rect([b[0], b[1]], [b[2], b[3]]);
        assert_eq!(all.len(), 4 + 3 + 2 + 1);
        // Reopen: the project keeps the CRS.
        let again = Session::open(&inp).unwrap();
        assert_eq!(again.info().crs.unwrap().id, "EPSG:2154");
        s.set_crs(None).unwrap();
        assert!(matches!(s.info().space, Space::Cartesian { .. }));
    }

    #[test]
    fn geometry_layout() {
        let (_dir, inp) = fixture();
        let s = Session::open(&inp).unwrap();
        let g = s.geometry();
        let u = |at: usize| u32::from_le_bytes(g[at..at + 4].try_into().unwrap()) as usize;
        let (nodes, links, link_pts, subs, sub_pts, gages) = (u(24), u(28), u(32), u(36), u(40), u(44));
        assert_eq!((nodes, links, link_pts, subs, sub_pts, gages), (4, 3, 6, 2, 10, 1));
        let floats = 2 * (nodes + link_pts + sub_pts + gages);
        let starts = 64 + 8 * floats;
        assert_eq!(u(starts + 4 * 3), 6);
        let types = starts + 4 * (links + 1 + subs + 1) + 8 * links;
        // C1 goes from J1 (node 0) to J2 (node 1).
        assert_eq!((u(types - 8 * links), u(types - 8 * links + 4)), (0, 1));
        assert_eq!(g.len(), types + nodes + links);
        assert_eq!(g[types + 3], 1); // Out1 is an outfall
    }
}
