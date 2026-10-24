//! Run history: each run lives in `<model dir>/<model>_runs/<timestamp>[_<label>]/` with
//! the model snapshot, report, results and a `run.json` record.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::run::{RunOutcome, RunStatus};
use crate::{EngineConfig, EngineError};

pub const RECORD_FILE: &str = "run.json";

/// Folder holding the runs of a model: `model.inp` → `model_runs`.
pub fn runs_dir(model: &Path) -> PathBuf {
    let stem = model.file_stem().map_or("model".into(), |s| s.to_string_lossy().into_owned());
    model.parent().unwrap_or(Path::new(".")).join(format!("{stem}_runs"))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContinuitySummary {
    pub runoff_quantity: Option<f64>,
    pub groundwater: Option<f64>,
    pub flow_routing: Option<f64>,
}

/// Metadata of one run (`run.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    pub label: Option<String>,
    /// Model the run was made from.
    pub model: PathBuf,
    pub engine: EngineConfig,
    /// RFC 3339 local time.
    pub started: String,
    pub seconds: f64,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub errors: usize,
    pub warnings: usize,
    pub continuity: Option<ContinuitySummary>,
    /// File names inside the run folder.
    pub inp: String,
    pub rpt: String,
    pub out: String,
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

impl RunRecord {
    pub(crate) fn from_outcome(
        model: &Path,
        engine: &EngineConfig,
        label: Option<String>,
        started: chrono::DateTime<chrono::Local>,
        o: &RunOutcome,
    ) -> RunRecord {
        let continuity = o.report.as_ref().map(|r| {
            let c = r.continuity();
            ContinuitySummary {
                runoff_quantity: c.runoff_quantity,
                groundwater: c.groundwater,
                flow_routing: c.flow_routing,
            }
        });
        RunRecord {
            label,
            model: model.to_path_buf(),
            engine: engine.clone(),
            started: started.to_rfc3339(),
            seconds: o.seconds,
            status: o.status,
            exit_code: o.exit_code,
            errors: o.report.as_ref().map_or(0, |r| r.errors.len()),
            warnings: o.report.as_ref().map_or(0, |r| r.warnings.len()),
            continuity,
            inp: file_name(&o.inp),
            rpt: file_name(&o.rpt),
            out: file_name(&o.out),
        }
    }

    pub fn save(&self, run_dir: &Path) -> Result<(), EngineError> {
        let p = run_dir.join(RECORD_FILE);
        std::fs::write(&p, serde_json::to_string_pretty(self).expect("record serialize"))
            .map_err(|e| EngineError::io(&p, e))
    }

    pub fn load(run_dir: &Path) -> Result<RunRecord, EngineError> {
        let p = run_dir.join(RECORD_FILE);
        let s = std::fs::read_to_string(&p).map_err(|e| EngineError::io(&p, e))?;
        serde_json::from_str(&s).map_err(|e| EngineError::Settings(format!("{}: {e}", p.display())))
    }
}

/// Previous runs of a model, most recent first. Folders without a readable record are skipped.
pub fn list_runs(model: &Path) -> Vec<(PathBuf, RunRecord)> {
    let Ok(entries) = std::fs::read_dir(runs_dir(model)) else {
        return Vec::new();
    };
    let mut runs: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| RunRecord::load(&p).ok().map(|r| (p, r)))
        .collect();
    runs.sort_by(|a, b| b.1.started.cmp(&a.1.started));
    runs
}

/// Changes the label of a run (its folder keeps its name).
pub fn set_label(run_dir: &Path, label: Option<&str>) -> Result<RunRecord, EngineError> {
    let mut r = RunRecord::load(run_dir)?;
    r.label = label.map(str::trim).filter(|l| !l.is_empty()).map(str::to_string);
    r.save(run_dir)?;
    Ok(r)
}

/// Deletes the folder of a run of `model`. Refuses folders that are not a run of this
/// model (outside its runs folder, or without a record).
pub fn delete_run(model: &Path, run_dir: &Path) -> Result<(), EngineError> {
    let parent = run_dir.parent().and_then(|p| p.canonicalize().ok());
    let runs = runs_dir(model).canonicalize().ok();
    if parent.is_none() || parent != runs || RunRecord::load(run_dir).is_err() {
        return Err(EngineError::Settings(format!("{} is not a run of {}", run_dir.display(), model.display())));
    }
    std::fs::remove_dir_all(run_dir).map_err(|e| EngineError::io(run_dir, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_dir_name() {
        assert_eq!(runs_dir(Path::new("C:/m/net.inp")), Path::new("C:/m/net_runs"));
    }

    #[test]
    fn label_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("m.inp");
        let run = runs_dir(&model).join("20260101_000000");
        std::fs::create_dir_all(&run).unwrap();
        let rec = RunRecord {
            label: None,
            model: model.clone(),
            engine: EngineConfig { name: "e".into(), path: "e.exe".into(), version: None },
            started: "2026-01-01T00:00:00+00:00".into(),
            seconds: 1.0,
            status: RunStatus::Success,
            exit_code: Some(0),
            errors: 0,
            warnings: 0,
            continuity: None,
            inp: "m.inp".into(),
            rpt: "m.rpt".into(),
            out: "m.out".into(),
        };
        rec.save(&run).unwrap();
        assert_eq!(set_label(&run, Some(" base ")).unwrap().label.as_deref(), Some("base"));
        assert_eq!(list_runs(&model)[0].1.label.as_deref(), Some("base"));
        assert!(delete_run(&model, dir.path()).is_err());
        delete_run(&model, &run).unwrap();
        assert!(list_runs(&model).is_empty());
    }
}
