//! Edits, undo / redo, and the views of the model the editors read.

use swmm_model::ops::DeletePlan;
use swmm_model::schema::RefKind;
use swmm_model::tables::Table;
use swmm_model::{climate::Climate, grid::Grid, validate::Issue, ObjRef};
use tauri::State;

use super::AppState;
use crate::editing::{EditOutcome, EditRequest, OptionsDto};
use crate::model_views::SectionInfo;
use crate::session::Res;

#[tauri::command(async)]
pub fn edit(state: State<'_, AppState>, request: EditRequest, selection: Vec<ObjRef>) -> Res<EditOutcome> {
    state.write(|s| s.edit(request, &selection))
}

#[tauri::command(async)]
pub fn undo(state: State<'_, AppState>, selection: Vec<ObjRef>) -> Res<EditOutcome> {
    state.write(|s| s.undo(&selection))
}

#[tauri::command(async)]
pub fn redo(state: State<'_, AppState>, selection: Vec<ObjRef>) -> Res<EditOutcome> {
    state.write(|s| s.redo(&selection))
}

#[tauri::command(async)]
pub fn delete_plan(state: State<'_, AppState>, objects: Vec<ObjRef>) -> Res<DeletePlan> {
    state.read(|s| Ok(s.delete_plan(&objects)))
}

#[tauri::command(async)]
pub fn names(state: State<'_, AppState>, kind: RefKind) -> Res<Vec<String>> {
    state.read(|s| Ok(s.names(kind)))
}

#[tauri::command(async)]
pub fn table(state: State<'_, AppState>, kind: RefKind, name: String) -> Res<Table> {
    state.read(|s| s.table(kind, &name))
}

#[tauri::command(async)]
pub fn options(state: State<'_, AppState>) -> Res<OptionsDto> {
    state.read(|s| Ok(s.options()))
}

#[tauri::command(async)]
pub fn validate_model(state: State<'_, AppState>) -> Res<Vec<Issue>> {
    state.read(|s| Ok(s.validate()))
}

#[tauri::command(async)]
pub fn grid(state: State<'_, AppState>, section: String) -> Res<Grid> {
    state.read(|s| s.grid(&section))
}

#[tauri::command(async)]
pub fn climate(state: State<'_, AppState>) -> Res<Climate> {
    state.read(|s| Ok(s.climate()))
}

#[tauri::command(async)]
pub fn sections(state: State<'_, AppState>) -> Res<Vec<SectionInfo>> {
    state.read(|s| Ok(s.sections()))
}

#[tauri::command(async)]
pub fn section_text(state: State<'_, AppState>, section: String) -> Res<String> {
    state.read(|s| Ok(s.section_text(&section)))
}
