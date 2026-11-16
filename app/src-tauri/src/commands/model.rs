//! The open model: opening, saving, coordinate system, project settings, picking and
//! object properties.

use std::path::PathBuf;

use serde::Serialize;
use swmm_model::ObjRef;
use tauri::ipc::Response;
use tauri::{AppHandle, State};

use super::cache::start_cache_job;
use super::{floats, obj_kind, AppState};
use crate::editing::create_model;
use crate::project::Basemap;
use crate::session::{ModelInfo, ObjectInfo, Res, Session};

#[tauri::command(async)]
pub fn open_model(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> Res<ModelInfo> {
    state.cancel_job();
    let session = Session::open(&path)?;
    let info = session.info();
    state.replace(session)?;
    start_cache_job(&app, &state);
    Ok(info)
}

#[tauri::command(async)]
pub fn model_info(state: State<'_, AppState>) -> Res<ModelInfo> {
    state.read(|s| Ok(s.info()))
}

#[tauri::command(async)]
pub fn geometry(state: State<'_, AppState>) -> Res<Response> {
    state.read(|s| Ok(Response::new(s.geometry())))
}

#[tauri::command(async)]
pub fn ids(state: State<'_, AppState>, kind: String) -> Res<Vec<String>> {
    let k = obj_kind(&kind)?;
    state.read(|s| Ok(s.ids(k).into_iter().map(str::to_string).collect()))
}

#[derive(Serialize)]
pub struct CrsEntry {
    id: String,
    name: String,
    geographic: bool,
}

#[tauri::command(async)]
pub fn search_crs(query: String) -> Vec<CrsEntry> {
    swmm_geo::crs::search(&query, 50)
        .into_iter()
        .map(|c| CrsEntry { id: c.id(), geographic: c.kind == swmm_geo::crs::CrsKind::Geographic, name: c.name })
        .collect()
}

#[tauri::command(async)]
pub fn set_crs(state: State<'_, AppState>, crs: Option<String>) -> Res<ModelInfo> {
    state.write(|s| {
        s.set_crs(crs.as_deref())?;
        Ok(s.info())
    })
}

#[tauri::command(async)]
pub fn update_project(state: State<'_, AppState>, basemap: Option<Basemap>, ui: Option<serde_json::Value>) -> Res<()> {
    state.write(|s| s.update_project(basemap, ui))
}

#[tauri::command(async)]
pub fn pick(state: State<'_, AppState>, x: f64, y: f64, tol: f64) -> Res<Option<ObjRef>> {
    state.read(|s| Ok(s.pick([x, y], tol)))
}

#[tauri::command(async)]
pub fn pick_all(state: State<'_, AppState>, x: f64, y: f64, tol: f64) -> Res<Vec<ObjRef>> {
    state.read(|s| Ok(s.pick_all([x, y], tol)))
}

#[tauri::command(async)]
pub fn select_rect(state: State<'_, AppState>, a: [f64; 2], b: [f64; 2]) -> Res<Vec<ObjRef>> {
    state.read(|s| Ok(s.select_rect(a, b)))
}

#[tauri::command(async)]
pub fn select_polygon(state: State<'_, AppState>, ring: Vec<[f64; 2]>) -> Res<Vec<ObjRef>> {
    state.read(|s| Ok(s.select_polygon(&ring)))
}

#[tauri::command(async)]
pub fn find_object(state: State<'_, AppState>, id: String) -> Res<Option<ObjRef>> {
    state.read(|s| Ok(s.find(&id)))
}

#[tauri::command(async)]
pub fn object_info(state: State<'_, AppState>, kind: String, index: u32, period: Option<usize>) -> Res<ObjectInfo> {
    let k = obj_kind(&kind)?;
    state.read(|s| s.object(ObjRef { kind: k, index }, period))
}

#[tauri::command(async)]
pub fn attribute(state: State<'_, AppState>, kind: String, name: String) -> Res<Response> {
    let k = obj_kind(&kind)?;
    state.read(|s| s.attribute(k, &name).map(|v| floats(&v)))
}

/// Saves the model; `path` saves a copy under a new name and continues with it.
#[tauri::command(async)]
pub fn save_model(state: State<'_, AppState>, path: Option<PathBuf>) -> Res<ModelInfo> {
    state.write(|s| {
        s.save(path.as_deref())?;
        Ok(s.info())
    })
}

/// Writes a new empty model and opens it.
#[tauri::command(async)]
pub fn new_model(app: AppHandle, state: State<'_, AppState>, path: PathBuf, flow_units: String) -> Res<ModelInfo> {
    create_model(&path, &flow_units)?;
    open_model(app, state, path)
}
