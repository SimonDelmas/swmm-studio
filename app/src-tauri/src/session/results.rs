//! Results of a run (`.out`) matched with the network: frames, series and the state of
//! the background results cache.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use swmm_model::{Network, ObjKind};
use swmm_out::{ElementKind, MinMax, Results};

use super::{Res, Session};

/// Series read straight from a `.out` without a cache touch every page of the range;
/// beyond this many bytes the request waits for the cache.
const DIRECT_READ_LIMIT: u64 = 256 << 20;

/// State of the results cache of the open `.out`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum CacheState {
    Ready,
    Building { progress: f64 },
    Failed { message: String },
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

pub(crate) fn element(kind: ObjKind) -> Option<ElementKind> {
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
    pub variables: BTreeMap<String, Vec<VarInfo>>,
    /// Network objects found in the file, per kind.
    pub matched: BTreeMap<String, usize>,
    /// Objects in the file, per kind.
    pub in_file: BTreeMap<String, usize>,
    pub cache: CacheState,
    /// Most periods a series can span when read without the cache.
    pub direct_periods: usize,
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

impl Session {
    pub fn open_results(&mut self, path: &Path) -> Res<()> {
        self.results = Some(LoadedResults::open(path, &self.net)?);
        self.project.results.out = Some(path.to_path_buf());
        Ok(())
    }

    /// Loads results to compare with the loaded ones.
    pub fn open_comparison(&mut self, path: &Path) -> Res<()> {
        self.compare = None;
        self.compare = Some(LoadedResults::open(path, &self.net)?);
        Ok(())
    }

    pub fn results_info(&self) -> Option<ResultsInfo> {
        self.results.as_ref().map(LoadedResults::info)
    }

    pub(crate) fn loaded(&self) -> Res<&LoadedResults> {
        self.results.as_ref().ok_or_else(|| "no results loaded".to_string())
    }

    /// The loaded results, or the compared ones (`b`).
    pub(crate) fn source(&self, b: bool) -> Res<&LoadedResults> {
        if b {
            self.compare.as_ref().ok_or_else(|| "no results to compare with".to_string())
        } else {
            self.loaded()
        }
    }
    /// One variable for every network object of a kind at a period (NaN where the
    /// object is not in the results).
    pub fn frame(&self, kind: ElementKind, var: usize, period: usize) -> Res<Vec<f32>> {
        let lr = self.loaded()?;
        let raw = lr.results.frame(kind, var, period).map_err(|e| e.to_string())?;
        Ok(lr.to_network(kind, &raw, f32::NAN))
    }

    /// Whole-run maximum of a variable for every network object (needs the cache).
    pub fn envelope_max(&self, kind: ElementKind, var: usize) -> Res<Vec<f32>> {
        let lr = self.loaded()?;
        let env = lr.results.envelope(kind, var).map_err(|e| e.to_string())?;
        let max: Vec<f32> = env.iter().map(|s| s.max).collect();
        Ok(lr.to_network(kind, &max, f32::NAN))
    }

    /// Min/max envelope of a series over `[p0, p1)` in about `buckets` points, from the
    /// loaded results or the compared ones (`b`).
    #[allow(clippy::too_many_arguments)]
    pub fn series(
        &self,
        kind: ElementKind,
        index: usize,
        var: usize,
        p0: usize,
        p1: usize,
        buckets: usize,
        b: bool,
    ) -> Res<MinMax> {
        let lr = self.source(b)?;
        let o = lr.out_index(kind, index)?;
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
        lr.check_long_read(lr.results.out().n_periods())?;
        let o = lr.out_index(kind, index)?;
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
        lr.check_long_read(lr.results.out().n_periods())?;
        let o = lr.out_index(kind, index)?;
        lr.results.next_rise(kind, o, var, from, threshold).map_err(|e| e.to_string())
    }

    /// `.out` files to cache in the background (loaded and compared results).
    pub fn cache_jobs(&self) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = [&self.results, &self.compare]
            .into_iter()
            .flatten()
            .filter(|lr| matches!(lr.cache, CacheState::Building { .. }))
            .map(|lr| lr.path.clone())
            .collect();
        v.dedup();
        v
    }

    fn results_at<'a>(&'a mut self, path: &'a Path) -> impl Iterator<Item = &'a mut LoadedResults> + 'a {
        [&mut self.results, &mut self.compare].into_iter().flatten().filter(move |lr| lr.path == path)
    }

    /// Called when the background build of `path` ends.
    pub fn cache_done(&mut self, path: &Path, outcome: Result<(), String>) {
        for lr in self.results_at(path) {
            lr.cache = match outcome.clone().and_then(|()| lr.results.reload_cache().map_err(|e| e.to_string())) {
                Ok(()) => CacheState::Ready,
                Err(message) => CacheState::Failed { message },
            };
        }
    }

    pub fn cache_progress(&mut self, path: &Path, progress: f64) {
        for lr in self.results_at(path) {
            if matches!(lr.cache, CacheState::Building { .. }) {
                lr.cache = CacheState::Building { progress };
            }
        }
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
    /// Opens a results file and matches its objects with the network.
    pub(crate) fn open(path: &Path, net: &Network) -> Res<LoadedResults> {
        let results = Results::open(path).map_err(|e| e.to_string())?;
        let meta = results.meta();
        let (to_out, matched) = match_results(meta, net);
        if matched.iter().sum::<usize>() == 0
            && meta.ids(ElementKind::Node).len() + meta.ids(ElementKind::Link).len() > 0
        {
            return Err("no object of the results file is in the model".into());
        }
        // Without a cache the caller starts the background build (of the periods written,
        // for a run that did not finish).
        let cache = if results.cache().is_some() { CacheState::Ready } else { CacheState::Building { progress: 0.0 } };
        Ok(LoadedResults { path: path.to_path_buf(), results, to_out, matched, cache })
    }

    pub(crate) fn info(&self) -> ResultsInfo {
        let lr = self;
        let m = lr.results.meta();

        let mut variables = BTreeMap::new();
        let mut matched = BTreeMap::new();
        let mut in_file = BTreeMap::new();
        for ek in ElementKind::ALL {
            let vars = m
                .var_names(ek)
                .into_iter()
                .enumerate()
                .map(|(v, name)| VarInfo { name, unit: m.unit(ek, v).to_string() })
                .collect();
            variables.insert(ek.name().to_string(), vars);
            in_file.insert(ek.name().to_string(), m.count(ek));
            if ek != ElementKind::System {
                matched.insert(ek.name().to_string(), lr.matched[ek as usize]);
            }
        }
        ResultsInfo {
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
            direct_periods: (DIRECT_READ_LIMIT / lr.results.out().layout().bytes_per_period().max(1)) as usize,
        }
    }

    /// Index in the `.out` of a network object (`system`: 0).
    pub(crate) fn out_index(&self, kind: ElementKind, index: usize) -> Res<usize> {
        if kind == ElementKind::System {
            return Ok(0);
        }
        match self.to_out[kind as usize].get(index) {
            Some(&o) if o != u32::MAX => Ok(o as usize),
            _ => Err(format!("{} #{index} has no results", kind.name())),
        }
    }

    /// Network-ordered values from values in `.out` order (`missing` where an object
    /// has no results).
    pub(crate) fn to_network<T: Copy>(&self, kind: ElementKind, raw: &[T], missing: T) -> Vec<T> {
        if kind == ElementKind::System {
            return raw.to_vec();
        }
        self.to_out[kind as usize].iter().map(|&o| raw.get(o as usize).copied().unwrap_or(missing)).collect()
    }

    /// Fails when reading `periods` periods would touch more than [`DIRECT_READ_LIMIT`]
    /// bytes without the cache.
    pub(crate) fn check_long_read(&self, periods: usize) -> Res<()> {
        let size = periods as u64 * self.results.out().layout().bytes_per_period();
        if self.results.cache().is_none() && size > DIRECT_READ_LIMIT {
            return Err(match &self.cache {
                CacheState::Building { progress } => {
                    format!("this needs the results cache, which is being built ({:.0}%)", progress * 100.0)
                }
                _ => "this needs the results cache, which is not ready".into(),
            });
        }
        Ok(())
    }

    /// Matches the results again after the network was rebuilt by an edit.
    pub(crate) fn remap(&mut self, net: &Network) {
        (self.to_out, self.matched) = match_results(self.results.meta(), net);
    }

    pub(crate) fn object_values(&self, kind: ElementKind, index: usize, period: usize) -> Option<Vec<VarValue>> {
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
                        unit: m.unit(kind, v).to_string(),
                        value,
                        max: stats.map(|s| s.max),
                        max_period: stats.map(|s| s.argmax),
                    }
                })
                .collect(),
        )
    }
}
