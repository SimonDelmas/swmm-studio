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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_dir_name() {
        assert_eq!(runs_dir(Path::new("C:/m/net.inp")), Path::new("C:/m/net_runs"));
    }
}
