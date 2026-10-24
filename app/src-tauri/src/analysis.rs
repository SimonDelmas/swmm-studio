//! Analysis on a [`Session`]: statistics over periods (envelope maps, time
//! aggregation), comparison with a second run, event statistics, profiles, validation,
//! run history and the tabular views of the model.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use swmm_analysis::{self as an, Calendar, EventParams, Profile, Stat, YearStats};
use swmm_engine::history::{self, RunRecord};
use swmm_inp::SectionKind;
use swmm_model::{climate::Climate, grid::Grid, validate::Issue, ObjKind};
use swmm_out::ElementKind;

use crate::session::{LoadedResults, Res, Session};

/// Head is node variable 1 in every `.out` file.
const HEAD: usize = 1;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Statistics are returned per object; durations above a threshold in hours.
fn finish(stat: Stat, v: f64, step_secs: f64) -> f32 {
    match stat {
        Stat::PeriodsAbove { .. } => (v * step_secs / 3600.0) as f32,
        _ => v as f32,
    }
}

fn step(lr: &LoadedResults) -> f64 {
    lr.results.meta().report_step_secs as f64
}

/// Unit of a statistic of a variable.
fn stat_unit(lr: &LoadedResults, kind: ElementKind, var: usize, stat: Stat) -> String {
    let m = lr.results.meta();
    let unit = swmm_out::format::unit(kind, var, m.flow_units);
    match stat {
        Stat::Total => an::integral(unit, m.flow_units).map_or(format!("{unit}·s"), |f| f.1.to_string()),
        Stat::PeriodsAbove { .. } => "h".into(),
        Stat::TimeOfMax => "period".into(),
        _ => unit.to_string(),
    }
}

/// Period of `b` at the time of period `p` of `a` (none when `b` has no period there).
fn same_time(a: &LoadedResults, b: &LoadedResults, p: usize) -> Option<usize> {
    let (ma, mb) = (a.results.meta(), b.results.meta());
    let secs = (ma.time(p) - mb.time(0)).num_seconds();
    let step = mb.report_step_secs.max(1) as i64;
    if secs < -step / 2 {
        return None;
    }
    let q = ((secs as f64) / step as f64).round().max(0.0) as i64;
    ((secs - q * step).abs() * 2 <= step && (q as usize) < mb.n_periods).then_some(q as usize)
}

#[derive(Debug, Clone, Serialize)]
pub struct Aggregated {
    pub starts_ms: Vec<i64>,
    /// End of the last interval (for step plots).
    pub end_ms: Option<i64>,
    pub periods: Vec<[usize; 2]>,
    pub values: Vec<f32>,
    pub unit: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventQuery {
    pub kind: String,
    pub var: usize,
    pub threshold: f32,
    pub min_gap_hours: f64,
    /// Network objects; `None`: every object of the kind.
    pub objects: Option<Vec<u32>>,
    /// Nodes only: restrict to outfalls.
    #[serde(default)]
    pub outfalls_only: bool,
    #[serde(default)]
    pub b: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventRow {
    pub index: u32,
    pub id: String,
    pub count: usize,
    pub per_year: f64,
    pub total: f64,
    pub hours: f64,
    pub peak: f32,
    pub years: Vec<YearStats>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventTable {
    pub rows: Vec<EventRow>,
    /// Length of the run in years (for frequencies).
    pub years: f64,
    pub unit: String,
    pub total_unit: String,
    pub seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventDto {
    pub start: usize,
    pub end: usize,
    pub peak: f32,
    pub peak_period: usize,
    pub total: f64,
    pub hours: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileDto {
    #[serde(flatten)]
    pub profile: Profile,
    /// Maximum head of each profile node over the run (NaN when unknown).
    pub max_head: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunDto {
    pub dir: PathBuf,
    pub record: RunRecord,
    pub out: Option<PathBuf>,
    pub rpt: Option<PathBuf>,
    /// Its results are the loaded ones / the compared ones.
    pub loaded: bool,
    pub compared: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectionInfo {
    pub name: String,
    pub lines: usize,
    pub present: bool,
}

impl Session {
    /// A statistic of a variable over `[p0, p1)` for every network object (`system`: one
    /// value), from the loaded results or the compared ones.
    #[allow(clippy::too_many_arguments)]
    pub fn stat_values(
        &self,
        kind: ElementKind,
        var: usize,
        stat: Stat,
        p0: usize,
        p1: usize,
        b: bool,
    ) -> Res<Vec<f32>> {
        let lr = self.source(b)?;
        let p1 = p1.min(lr.results.out().n_periods());
        lr.check_long_read(p1.saturating_sub(p0))?;
        let raw = an::reduce_all(&lr.results, kind, var, p0..p1, stat).map_err(err)?;
        let v: Vec<f32> = raw.iter().map(|&x| finish(stat, x, step(lr))).collect();
        Ok(lr.to_network(kind, &v, f32::NAN))
    }

    /// Loaded minus compared results at the time of period `p` of the loaded ones (NaN
    /// where either has no value).
    pub fn compare_frame(&self, kind: ElementKind, var: usize, period: usize) -> Res<Vec<f32>> {
        let (a, b) = (self.loaded()?, self.source(true)?);
        if var >= b.results.meta().nvars(kind) {
            return Err("the compared results do not have this variable".into());
        }
        let fa = self.frame(kind, var, period)?;
        let Some(q) = same_time(a, b, period) else {
            return Ok(vec![f32::NAN; fa.len()]);
        };
        let raw = b.results.frame(kind, var, q).map_err(err)?;
        let fb = b.to_network(kind, &raw, f32::NAN);
        Ok(fa.iter().zip(&fb).map(|(x, y)| x - y).collect())
    }

    /// Period of the compared results at the time of period `p` of the loaded ones.
    pub fn compare_period(&self, period: usize) -> Res<Option<usize>> {
        Ok(same_time(self.loaded()?, self.source(true)?, period))
    }

    /// A statistic of one series per day, month or year.
    pub fn aggregate(
        &self,
        kind: ElementKind,
        index: usize,
        var: usize,
        unit: Calendar,
        stat: Stat,
        b: bool,
    ) -> Res<Aggregated> {
        let lr = self.source(b)?;
        let o = lr.out_index(kind, index)?;
        let m = lr.results.meta();
        lr.check_long_read(m.n_periods)?;
        let mut out = Aggregated {
            starts_ms: Vec::new(),
            end_ms: None,
            periods: Vec::new(),
            values: Vec::new(),
            unit: stat_unit(lr, kind, var, stat),
        };
        for bk in an::buckets(m, unit) {
            let v = an::reduce_series(&lr.results, kind, o, var, bk.periods.clone(), stat).map_err(err)?;
            out.starts_ms.push(bk.start.and_utc().timestamp_millis());
            out.end_ms = Some(bk.end.and_utc().timestamp_millis());
            out.periods.push([bk.periods.start, bk.periods.end]);
            out.values.push(finish(stat, v, step(lr)));
        }
        Ok(out)
    }

    /// Unit of a statistic (for legends).
    pub fn stat_unit(&self, kind: ElementKind, var: usize, stat: Stat, b: bool) -> Res<String> {
        Ok(stat_unit(self.source(b)?, kind, var, stat))
    }

    fn element(kind: &str) -> Res<(ElementKind, ObjKind)> {
        match kind {
            "node" => Ok((ElementKind::Node, ObjKind::Node)),
            "link" => Ok((ElementKind::Link, ObjKind::Link)),
            "subcatchment" => Ok((ElementKind::Subcatchment, ObjKind::Subcatchment)),
            k => Err(format!("no events for {k}")),
        }
    }

    fn gap_periods(lr: &LoadedResults, hours: f64) -> usize {
        ((hours.max(0.0) * 3600.0) / step(lr)).ceil().max(1.0) as usize
    }

    /// Event statistics of many objects.
    pub fn event_stats(&self, q: &EventQuery) -> Res<EventTable> {
        let t0 = std::time::Instant::now();
        let (ek, ok) = Self::element(&q.kind)?;
        let lr = self.source(q.b)?;
        let m = lr.results.meta();
        lr.check_long_read(m.n_periods)?;
        if q.var >= m.nvars(ek) {
            return Err(format!("no variable #{} for {}", q.var, q.kind));
        }
        let candidates: Vec<u32> = match &q.objects {
            Some(v) => v.clone(),
            None => (0..self.net.len(ok) as u32).collect(),
        };
        let net_objs: Vec<(u32, usize)> = candidates
            .into_iter()
            .filter(|&i| (i as usize) < self.net.len(ok))
            .filter(|&i| !q.outfalls_only || self.net.nodes[i as usize].kind == swmm_model::NodeType::Outfall)
            .filter_map(|i| lr.out_index(ek, i as usize).ok().map(|o| (i, o)))
            .collect();
        let objs: Vec<usize> = net_objs.iter().map(|x| x.1).collect();
        let params = EventParams { threshold: q.threshold, min_gap: Self::gap_periods(lr, q.min_gap_hours) };
        let sums = an::summarize(&lr.results, ek, &objs, q.var, 0..m.n_periods, params).map_err(err)?;
        let years = m.n_periods as f64 * step(lr) / (365.25 * 86_400.0);
        let rows = net_objs
            .iter()
            .zip(sums)
            .map(|(&(i, _), s)| EventRow {
                index: i,
                id: self.net.id(swmm_model::ObjRef { kind: ok, index: i }).to_string(),
                count: s.count,
                per_year: s.count as f64 / years.max(1e-9),
                total: s.total,
                hours: s.hours,
                peak: s.peak,
                years: s.years,
            })
            .collect();
        Ok(EventTable {
            rows,
            years,
            unit: swmm_out::format::unit(ek, q.var, m.flow_units).to_string(),
            total_unit: stat_unit(lr, ek, q.var, Stat::Total),
            seconds: t0.elapsed().as_secs_f64(),
        })
    }

    /// Events of one object.
    #[allow(clippy::too_many_arguments)]
    pub fn object_events(
        &self,
        kind: &str,
        index: u32,
        var: usize,
        threshold: f32,
        min_gap_hours: f64,
        b: bool,
    ) -> Res<Vec<EventDto>> {
        let (ek, _) = Self::element(kind)?;
        let lr = self.source(b)?;
        let m = lr.results.meta();
        lr.check_long_read(m.n_periods)?;
        let o = lr.out_index(ek, index as usize)?;
        let params = EventParams { threshold, min_gap: Self::gap_periods(lr, min_gap_hours) };
        let events = an::detect(&lr.results, ek, o, var, 0..m.n_periods, params).map_err(err)?;
        let h = step(lr) / 3600.0;
        Ok(events
            .iter()
            .map(|e| EventDto {
                start: e.start,
                end: e.end,
                peak: e.peak,
                peak_period: e.peak_period,
                total: an::event_total(m, ek, var, e),
                hours: e.periods() as f64 * h,
            })
            .collect())
    }

    /// Profile along the shortest path through `nodes` (in order).
    pub fn profile(&self, nodes: &[u32]) -> Res<ProfileDto> {
        if nodes.len() < 2 {
            return Err("pick at least two nodes".into());
        }
        if let Some(&n) = nodes.iter().find(|&&n| n as usize >= self.net.nodes.len()) {
            return Err(format!("no node #{n}"));
        }
        let lengths = an::profile::link_lengths(&self.inp, &self.net);
        let path = an::path_through(&self.net, &lengths, nodes).ok_or("these nodes are not connected")?;
        let profile = Profile::build(&self.inp, &self.net, &lengths, nodes[0], &path);
        let max_head = match self.results.as_ref() {
            Some(lr) if lr.check_long_read(lr.results.out().n_periods()).is_ok() => profile
                .nodes
                .iter()
                .map(|n| {
                    lr.out_index(ElementKind::Node, n.index as usize)
                        .ok()
                        .and_then(|o| lr.results.stats(ElementKind::Node, o, HEAD).ok())
                        .map_or(f32::NAN, |s| s.max)
                })
                .collect(),
            _ => vec![f32::NAN; profile.nodes.len()],
        };
        Ok(ProfileDto { profile, max_head })
    }

    /// Head of some nodes at a period.
    pub fn heads(&self, nodes: &[u32], period: usize, b: bool) -> Res<Vec<f32>> {
        let lr = self.source(b)?;
        let p = if b { self.compare_period(period)?.ok_or("no compared results at this time")? } else { period };
        let raw = lr.results.frame(ElementKind::Node, HEAD, p).map_err(err)?;
        Ok(nodes
            .iter()
            .map(|&n| {
                lr.out_index(ElementKind::Node, n as usize).ok().and_then(|o| raw.get(o).copied()).unwrap_or(f32::NAN)
            })
            .collect())
    }

    pub fn validate(&self) -> Vec<Issue> {
        swmm_model::validate::validate(&self.inp, &self.net)
    }

    pub fn grid(&self, section: &str) -> Res<Grid> {
        let kind = SectionKind::from_name(section);
        swmm_model::grid::grid(&self.inp, &self.net, &kind).ok_or_else(|| format!("[{section}] has no table view"))
    }

    pub fn climate(&self) -> Climate {
        Climate::read(&self.inp)
    }

    /// Sections of the file, then the known ones it does not have.
    pub fn sections(&self) -> Vec<SectionInfo> {
        let mut out: Vec<SectionInfo> = Vec::new();
        for s in self.inp.sections() {
            if !out.iter().any(|x| x.name == s.name()) {
                out.push(SectionInfo { name: s.name().to_string(), lines: s.data_len(), present: true });
            }
        }
        for k in SectionKind::KNOWN {
            if !out.iter().any(|x| x.name == k.name()) {
                out.push(SectionInfo { name: k.name().to_string(), lines: 0, present: false });
            }
        }
        out
    }

    pub fn section_text(&self, section: &str) -> String {
        swmm_model::grid::section_text(&self.inp, &SectionKind::from_name(section)).unwrap_or_default()
    }

    // ---- run history -----------------------------------------------------------

    pub fn runs(&self) -> Vec<RunDto> {
        let is = |lr: &Option<LoadedResults>, d: &Path| lr.as_ref().is_some_and(|lr| lr.path.starts_with(d));
        history::list_runs(&self.inp_path)
            .into_iter()
            .map(|(dir, record)| {
                let (out, rpt) = (dir.join(&record.out), dir.join(&record.rpt));
                RunDto {
                    loaded: is(&self.results, &dir),
                    compared: is(&self.compare, &dir),
                    out: out.is_file().then_some(out),
                    rpt: rpt.is_file().then_some(rpt),
                    dir,
                    record,
                }
            })
            .collect()
    }

    fn run_files(&self, dir: &Path) -> Res<(PathBuf, PathBuf)> {
        let r = RunRecord::load(dir).map_err(err)?;
        Ok((dir.join(r.out), dir.join(r.rpt)))
    }

    /// Loads the results and report of a run.
    pub fn open_run(&mut self, dir: &Path) -> Res<()> {
        let (out, rpt) = self.run_files(dir)?;
        if !out.is_file() {
            return Err("this run has no results file".into());
        }
        self.open_results(&out)?;
        self.report = None;
        self.project.results.rpt = None;
        if rpt.is_file() {
            self.open_report(&rpt)?;
        }
        self.save_project()
    }

    /// Compares the loaded results with those of a run.
    pub fn compare_run(&mut self, dir: &Path) -> Res<()> {
        let (out, _) = self.run_files(dir)?;
        if !out.is_file() {
            return Err("this run has no results file".into());
        }
        self.open_comparison(&out)
    }

    pub fn set_run_label(&self, dir: &Path, label: Option<&str>) -> Res<()> {
        history::set_label(dir, label).map(|_| ()).map_err(err)
    }

    /// Deletes a run, unloading its results first (open files cannot be deleted).
    pub fn delete_run(&mut self, dir: &Path) -> Res<()> {
        if self.results.as_ref().is_some_and(|lr| lr.path.starts_with(dir)) {
            self.results = None;
            self.project.results.out = None;
        }
        if self.report.as_ref().is_some_and(|(p, _)| p.starts_with(dir)) {
            self.report = None;
            self.project.results.rpt = None;
        }
        if self.compare.as_ref().is_some_and(|lr| lr.path.starts_with(dir)) {
            self.compare = None;
        }
        history::delete_run(&self.inp_path, dir).map_err(err)?;
        self.save_project()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use swmm_out::{OutSpec, OutWriter};

    const TINY: &str = include_str!("../../../testdata/tiny.inp");

    /// `tiny.inp` with two results files; B is A + 1 and starts one period later.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("tiny.inp");
        std::fs::write(&inp, TINY).unwrap();
        let write = |path: &Path, shift: usize, add: f32| {
            let start = 45_444.0 + shift as f64 * 300.0 / 86_400.0;
            let mut spec = OutSpec::simple(2, 4, 3, start, 300);
            spec.nodes = ["J1", "J2", "J3", "Out1"].map(String::from).to_vec();
            spec.links = ["C1", "C2", "C3"].map(String::from).to_vec();
            let mut w = OutWriter::create(path, &spec).unwrap();
            let n = w.layout().values_per_period();
            for p in 0..600 {
                let q = p + shift;
                let v: Vec<f32> = (0..n)
                    .map(|i| if (100..110).contains(&q) { 5.0 + i as f32 } else { add + (i % 3) as f32 * 0.01 })
                    .collect();
                w.write_period(start + (p + 1) as f64 * 300.0 / 86_400.0, &v).unwrap();
            }
            w.finish(0).unwrap();
        };
        let a = inp.with_extension("out");
        let b = dir.path().join("b.out");
        write(&a, 0, 0.0);
        write(&b, 1, 1.0);
        (dir, inp, b)
    }

    #[test]
    fn stats_comparison_events_profile() {
        let (_dir, inp, b) = fixture();
        let mut s = Session::open(&inp).unwrap();
        let max = s.stat_values(ElementKind::Node, 0, Stat::Max, 0, 600, false).unwrap();
        assert_eq!(max.len(), 4);
        assert!(max[0] >= 5.0);
        let above = s.stat_values(ElementKind::Node, 0, Stat::PeriodsAbove { threshold: 1.0 }, 0, 600, false).unwrap();
        assert!((above[0] - 10.0 * 300.0 / 3600.0).abs() < 1e-5, "{above:?}");
        assert!(s.compare_frame(ElementKind::Node, 0, 0).is_err());
        s.open_comparison(&b).unwrap();
        assert!(s.info().compare.is_some());
        // Period 5 of A is period 4 of B.
        assert_eq!(s.compare_period(5).unwrap(), Some(4));
        assert_eq!(s.compare_period(0).unwrap(), None);
        let d = s.compare_frame(ElementKind::Node, 0, 50).unwrap();
        assert!(d.iter().all(|&x| (x + 1.0).abs() < 1e-6), "{d:?}");
        let agg = s.aggregate(ElementKind::Link, 0, 0, Calendar::Day, Stat::Total, false).unwrap();
        assert_eq!(agg.unit, "m3");
        assert_eq!(agg.values.len(), agg.starts_ms.len());
        let q = EventQuery {
            kind: "node".into(),
            var: 0,
            threshold: 1.0,
            min_gap_hours: 1.0,
            objects: None,
            outfalls_only: false,
            b: false,
        };
        let t = s.event_stats(&q).unwrap();
        assert_eq!(t.rows.len(), 4);
        assert!(t.rows.iter().all(|r| r.count == 1), "{:?}", t.rows);
        let only = s.event_stats(&EventQuery { outfalls_only: true, ..q.clone() }).unwrap();
        assert_eq!(only.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["Out1"]);
        let ev = s.object_events("node", 0, 0, 1.0, 1.0, false).unwrap();
        assert_eq!((ev[0].start, ev[0].end), (100, 110));
        let j1 = s.net.find(ObjKind::Node, "J1").unwrap();
        let out1 = s.net.find(ObjKind::Node, "Out1").unwrap();
        let p = s.profile(&[j1, out1]).unwrap();
        assert_eq!(p.profile.nodes.first().unwrap().id, "J1");
        assert_eq!(p.profile.nodes.last().unwrap().id, "Out1");
        assert_eq!(p.max_head.len(), p.profile.nodes.len());
        let h = s.heads(&[j1, out1], 105, false).unwrap();
        assert!(h[0] >= 5.0);
        assert!(s.validate().iter().all(|i| i.code != "duplicate_id"));
        assert!(s.grid("JUNCTIONS").unwrap().rows.len() >= 3);
        assert!(s.sections().iter().any(|x| x.name == "JUNCTIONS" && x.present));
    }
}
