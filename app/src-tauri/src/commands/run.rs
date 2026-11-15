//! Running a simulation in the background.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use swmm_engine::{RunEvent, RunOptions, RunOutcome, RunStatus};
use swmm_out::OutFile;
use tauri::{AppHandle, Emitter, Manager, State};

use super::cache::start_cache_job;
use super::AppState;
use crate::session::{ModelInfo, Res, Session};

#[derive(Clone, Serialize)]
struct RunProgress {
    progress: Option<f64>,
    elapsed: f64,
    run_dir: Option<PathBuf>,
}

#[derive(Clone, Serialize)]
struct RunFinished {
    status: String,
    message: Option<String>,
    seconds: f64,
    run_dir: Option<PathBuf>,
    errors: usize,
    warnings: usize,
    console: Vec<String>,
    info: Option<ModelInfo>,
}

/// Loads what a finished run wrote into the model it was made from. A cancelled run
/// leaves the loaded results alone; a failed one shows its report (with the errors) and
/// the periods it wrote, if any. `None`: nothing was loaded (other model, cancelled).
fn load_outcome(app: &AppHandle, s: &mut Session, model: &Path, o: &RunOutcome) -> Res<Option<ModelInfo>> {
    if s.model_path() != model || o.status == RunStatus::Cancelled {
        return Ok(None);
    }
    s.close_results();
    if o.out_complete {
        s.open_results(&o.out)?;
    } else if OutFile::open(&o.out).is_ok_and(|f| f.n_periods() > 0) {
        let note = match s.open_results(&o.out) {
            Ok(()) => "partial results loaded (periods written before the failure)".to_string(),
            Err(e) => format!("partial results not loaded: {e}"),
        };
        let _ = app.emit("run-output", note);
    }
    if o.rpt.is_file() {
        s.open_report(&o.rpt)?;
    }
    s.save_project()?;
    Ok(Some(s.info()))
}

/// Starts a simulation of the model as it is in memory (unsaved edits included).
/// Events: `run-progress`, `run-output` (console lines), `run-finished`.
#[tauri::command(async)]
pub fn run_start(app: AppHandle, state: State<'_, AppState>, label: Option<String>) -> Res<()> {
    let mut slot = state.run.lock().unwrap();
    if slot.is_some() {
        return Err("a simulation is already running".into());
    }
    let (settings, _) = swmm_engine::Settings::load_or_default();
    let (inp, path, engine) = state.read(|s| {
        let engine =
            settings.engine_for(s.project_engine()).cloned().ok_or("no SWMM engine configured: add one in Engines")?;
        Ok((s.model_copy(), s.model_path().to_path_buf(), engine))
    })?;
    let cancel = Arc::new(AtomicBool::new(false));
    *slot = Some(cancel.clone());
    drop(slot);
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut run_dir = None;
        let opts = RunOptions { label: label.filter(|l| !l.trim().is_empty()), run_dir: None };
        let on_event = |ev| match ev {
            RunEvent::Started { run_dir: d } => {
                run_dir = Some(d.clone());
                let _ = app.emit("run-progress", RunProgress { progress: None, elapsed: 0.0, run_dir: Some(d) });
            }
            RunEvent::Progress(p) => {
                if last.elapsed() >= Duration::from_millis(100) || p >= 1.0 {
                    last = Instant::now();
                    let elapsed = t0.elapsed().as_secs_f64();
                    let _ = app.emit("run-progress", RunProgress { progress: Some(p), elapsed, run_dir: None });
                }
            }
            RunEvent::Output(line) => {
                let _ = app.emit("run-output", line);
            }
        };
        let result = swmm_engine::run_inp(&inp, &path, &engine, &opts, on_event, &cancel);
        let state = app.state::<AppState>();
        let finished = match result {
            Ok(o) => {
                let info = state.write(|s| load_outcome(&app, s, &path, &o)).unwrap_or_else(|e| {
                    let _ = app.emit("run-output", format!("results not loaded: {e}"));
                    None
                });
                RunFinished {
                    status: format!("{:?}", o.status).to_lowercase(),
                    message: None,
                    seconds: o.seconds,
                    run_dir: Some(o.run_dir),
                    errors: o.report.as_ref().map_or(0, |r| r.errors.len()),
                    warnings: o.report.as_ref().map_or(0, |r| r.warnings.len()),
                    console: o.console,
                    info,
                }
            }
            Err(e) => RunFinished {
                status: "failed".into(),
                message: Some(e.to_string()),
                seconds: t0.elapsed().as_secs_f64(),
                run_dir,
                errors: 0,
                warnings: 0,
                console: Vec::new(),
                info: None,
            },
        };
        state.run.lock().unwrap().take();
        let loaded = finished.info.is_some();
        let _ = app.emit("run-finished", finished);
        if loaded {
            start_cache_job(&app, &state);
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn run_cancel(state: State<'_, AppState>) {
    if let Some(c) = state.run.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}
