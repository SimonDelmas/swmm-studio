//! Run history of a model (`<model>_runs/`): listing, loading, comparing, labelling
//! and deleting runs.

use std::path::{Path, PathBuf};

use serde::Serialize;
use swmm_engine::history::{self, RunRecord};

use crate::session::{err, LoadedResults, ReportSummary, Res, Session};

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

impl Session {
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
        self.close_report();
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

    /// Report of a run, to look at it without loading its results.
    pub fn run_report(&mut self, dir: &Path) -> Res<ReportSummary> {
        let (_, rpt) = self.run_files(dir)?;
        if !rpt.is_file() {
            return Err("this run has no report".into());
        }
        self.view_report(&rpt)
    }

    pub fn set_run_label(&self, dir: &Path, label: Option<&str>) -> Res<()> {
        history::set_label(dir, label).map(|_| ()).map_err(err)
    }

    /// Deletes a run, unloading its results first (open files cannot be deleted).
    pub fn delete_run(&mut self, dir: &Path) -> Res<()> {
        if self.results.as_ref().is_some_and(|lr| lr.path.starts_with(dir)) {
            self.close_results();
        }
        if self.report.as_ref().is_some_and(|(p, _)| p.starts_with(dir)) {
            self.close_report();
        }
        if self.compare.as_ref().is_some_and(|lr| lr.path.starts_with(dir)) {
            self.close_comparison();
        }
        self.overlays.retain(|lr| !lr.path.starts_with(dir));
        self.drop_viewed_report(dir);
        history::delete_run(&self.inp_path, dir).map_err(err)?;
        self.save_project()
    }
}
