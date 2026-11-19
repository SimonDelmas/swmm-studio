//! Results and report of the loaded run, and the run compared with it.

use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::{AppHandle, State};

use super::cache::start_cache_job;
use super::{f32_bytes, floats, AppState};
use crate::session::{element_by_name, BlockDto, ModelInfo, Res};

#[tauri::command(async)]
pub fn open_results(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> Res<ModelInfo> {
    state.cancel_job();
    let info = state.write(|s| {
        s.open_results(&path)?;
        let rpt = path.with_extension("rpt");
        if rpt.exists() {
            s.open_report(&rpt)?;
        }
        s.save_project()?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}

#[tauri::command(async)]
pub fn open_report(state: State<'_, AppState>, path: PathBuf) -> Res<ModelInfo> {
    state.write(|s| {
        s.open_report(&path)?;
        s.save_project()?;
        Ok(s.info())
    })
}

#[tauri::command(async)]
pub fn frame(state: State<'_, AppState>, kind: String, var: usize, period: usize) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.frame(k, var, period).map(|v| floats(&v)))
}

/// `u32 n`, then `u32 periods[n]`, `f32 min[n]`, `f32 max[n]`.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn series(
    state: State<'_, AppState>,
    kind: String,
    index: usize,
    var: usize,
    p0: usize,
    p1: usize,
    buckets: usize,
    b: Option<bool>,
    path: Option<PathBuf>,
) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| {
        let mm = s.series(k, index, var, p0, p1, buckets.clamp(1, 20_000), b.unwrap_or(false), path.as_deref())?;
        let mut b = Vec::with_capacity(4 + 12 * mm.len());
        b.extend_from_slice(&(mm.len() as u32).to_le_bytes());
        b.extend(mm.periods.iter().flat_map(|&p| (p as u32).to_le_bytes()));
        b.extend(f32_bytes(&mm.min));
        b.extend(f32_bytes(&mm.max));
        Ok(Response::new(b))
    })
}

/// `f32` values of a series of the loaded results at periods `p0, p0 + stride, …` before `p1`.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn series_values(
    state: State<'_, AppState>,
    kind: String,
    index: usize,
    var: usize,
    p0: usize,
    p1: usize,
    stride: usize,
) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.series_values(k, index, var, p0, p1, stride).map(|v| floats(&v)))
}

#[tauri::command(async)]
pub fn time_of_max(state: State<'_, AppState>, kind: String, index: usize, var: usize) -> Res<usize> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.time_of_max(k, index, var))
}

#[tauri::command(async)]
pub fn next_event(
    state: State<'_, AppState>,
    kind: String,
    index: usize,
    var: usize,
    from: usize,
    threshold: f32,
) -> Res<Option<usize>> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.next_event(k, index, var, from, threshold))
}

/// A block of the loaded report, or of the report at `path` (one looked at with `run_report`).
#[tauri::command(async)]
pub fn report_block(state: State<'_, AppState>, index: usize, path: Option<PathBuf>) -> Res<BlockDto> {
    state.read(|s| s.report_block(index, path.as_deref()))
}

/// Results of other runs overlaid on the time series graphs.
#[tauri::command(async)]
pub fn set_overlays(app: AppHandle, state: State<'_, AppState>, paths: Vec<PathBuf>) -> Res<ModelInfo> {
    let info = state.write(|s| {
        s.set_overlays(&paths)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}

/// Whole-run maximum per object (`f32` array, network order).
#[tauri::command(async)]
pub fn envelope(state: State<'_, AppState>, kind: String, var: usize) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.envelope_max(k, var).map(|v| floats(&v)))
}

/// Loaded minus compared results at a period (`f32` array, network order).
#[tauri::command(async)]
pub fn compare_frame(state: State<'_, AppState>, kind: String, var: usize, period: usize) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.compare_frame(k, var, period).map(|v| floats(&v)))
}

#[tauri::command(async)]
pub fn compare_period(state: State<'_, AppState>, period: usize) -> Res<Option<usize>> {
    state.read(|s| s.compare_period(period))
}

#[tauri::command(async)]
pub fn open_comparison(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> Res<ModelInfo> {
    let info = state.write(|s| {
        s.open_comparison(&path)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}

#[tauri::command(async)]
pub fn close_comparison(state: State<'_, AppState>) -> Res<ModelInfo> {
    state.write(|s| {
        s.close_comparison();
        Ok(s.info())
    })
}
