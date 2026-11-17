//! Observed data: reading a file to link it to an object, the link, and its series.

use std::path::PathBuf;

use swmm_obs::DateOrder;
use tauri::ipc::Response;
use tauri::State;

use super::AppState;
use crate::observed::{inspect, ObservedFile};
use crate::project::ObservedLink;
use crate::session::{ModelInfo, Res};

/// What a file holds and the default mapping of its columns to the variables of object
/// `id`. The file is read without holding the model.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn inspect_observed(
    state: State<'_, AppState>,
    path: PathBuf,
    sheet: Option<String>,
    time_column: Option<String>,
    date_order: Option<DateOrder>,
    kind: String,
    id: String,
) -> Res<ObservedFile> {
    let variables = state.read(|s| s.observed_variables(&kind))?;
    inspect(&path, sheet.as_deref(), time_column.as_deref(), date_order.unwrap_or_default(), &kind, &id, variables)
}

/// Links a file to an object (`link` null: removes it); the project is saved.
#[tauri::command(async)]
pub fn set_observed(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    link: Option<ObservedLink>,
) -> Res<ModelInfo> {
    state.write(|s| {
        s.set_observed(&kind, &id, link)?;
        Ok(s.info())
    })
}

/// Observed values of a variable of an object over a time range (see
/// [`crate::session::Session::observed_series`]).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn observed_series(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    var: String,
    t0: f64,
    t1: f64,
    buckets: usize,
) -> Res<Response> {
    state.read(|s| s.observed_series(&kind, &id, &var, t0 as i64, t1 as i64, buckets).map(Response::new))
}
