//! Run history of the model (`<model>_runs/`).

use std::path::PathBuf;

use tauri::{AppHandle, State};

use super::cache::start_cache_job;
use super::AppState;
use crate::runs::RunDto;
use crate::session::{ModelInfo, ReportSummary, Res};

#[tauri::command(async)]
pub fn runs(state: State<'_, AppState>) -> Res<Vec<RunDto>> {
    state.read(|s| Ok(s.runs()))
}

#[tauri::command(async)]
pub fn open_run(app: AppHandle, state: State<'_, AppState>, dir: PathBuf) -> Res<ModelInfo> {
    state.cancel_job();
    let info = state.write(|s| {
        s.open_run(&dir)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}

#[tauri::command(async)]
pub fn compare_run(app: AppHandle, state: State<'_, AppState>, dir: PathBuf) -> Res<ModelInfo> {
    let info = state.write(|s| {
        s.compare_run(&dir)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}

/// Report of a run (not loaded with its results).
#[tauri::command(async)]
pub fn run_report(state: State<'_, AppState>, dir: PathBuf) -> Res<ReportSummary> {
    state.write(|s| s.run_report(&dir))
}

/// Console output of a run, as the engine wrote it.
#[tauri::command(async)]
pub fn run_console(dir: PathBuf) -> Vec<String> {
    swmm_engine::history::load_console(&dir)
}

#[tauri::command(async)]
pub fn set_run_label(state: State<'_, AppState>, dir: PathBuf, label: Option<String>) -> Res<Vec<RunDto>> {
    state.read(|s| {
        s.set_run_label(&dir, label.as_deref())?;
        Ok(s.runs())
    })
}

#[tauri::command(async)]
pub fn delete_run(app: AppHandle, state: State<'_, AppState>, dir: PathBuf) -> Res<ModelInfo> {
    // A cache being built for these results holds the file open.
    state.cancel_job();
    let info = state.write(|s| {
        s.delete_run(&dir)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}
