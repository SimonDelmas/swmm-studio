//! Statistics, time aggregation, events and profiles.

use swmm_analysis::{Calendar, Stat};
use tauri::ipc::Response;
use tauri::State;

use super::{floats, AppState};
use crate::analysis::{Aggregated, EventDto, EventQuery, EventTable, ProfileDto};
use crate::session::{element_by_name, Res};

/// A statistic over `[p0, p1)` for every network object (`f32` array, network order).
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn stat_values(
    state: State<'_, AppState>,
    kind: String,
    var: usize,
    stat: Stat,
    p0: usize,
    p1: usize,
    b: Option<bool>,
) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.stat_values(k, var, stat, p0, p1, b.unwrap_or(false)).map(|v| floats(&v)))
}

#[tauri::command(async)]
pub fn stat_unit(state: State<'_, AppState>, kind: String, var: usize, stat: Stat, b: Option<bool>) -> Res<String> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.stat_unit(k, var, stat, b.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn aggregate(
    state: State<'_, AppState>,
    kind: String,
    index: usize,
    var: usize,
    unit: Calendar,
    stat: Stat,
    b: Option<bool>,
) -> Res<Aggregated> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.aggregate(k, index, var, unit, stat, b.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn event_stats(state: State<'_, AppState>, query: EventQuery) -> Res<EventTable> {
    state.read(|s| s.event_stats(&query))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn object_events(
    state: State<'_, AppState>,
    kind: String,
    index: u32,
    var: usize,
    threshold: f32,
    min_gap_hours: f64,
    b: Option<bool>,
) -> Res<Vec<EventDto>> {
    state.read(|s| s.object_events(&kind, index, var, threshold, min_gap_hours, b.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn profile(state: State<'_, AppState>, nodes: Vec<u32>) -> Res<ProfileDto> {
    state.read(|s| s.profile(&nodes))
}

/// Heads of nodes at a period (`f32` array).
#[tauri::command(async)]
pub fn heads(state: State<'_, AppState>, nodes: Vec<u32>, period: usize, b: Option<bool>) -> Res<Response> {
    state.read(|s| s.heads(&nodes, period, b.unwrap_or(false)).map(|v| floats(&v)))
}
