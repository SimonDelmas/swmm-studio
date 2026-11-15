//! The engine registry (shared with the CLI) and the engine chosen for the model.

use std::path::PathBuf;

use serde::Serialize;
use swmm_engine::{EngineConfig, Settings};
use tauri::State;

use super::AppState;
use crate::session::Res;

#[derive(Serialize)]
pub struct EnginesDto {
    engines: Vec<EngineConfig>,
    default: Option<String>,
    /// Engine chosen for this model (overrides the default).
    project: Option<String>,
    /// Engine a run would use.
    effective: Option<String>,
    settings_path: PathBuf,
    error: Option<String>,
}

pub(super) fn load_settings() -> (Settings, Option<String>) {
    match Settings::load(&Settings::default_path()) {
        Ok(s) => (s, None),
        Err(e) => (Settings::default(), Some(e.to_string())),
    }
}

fn save_settings(s: &Settings) -> Res<()> {
    s.save(&Settings::default_path()).map_err(|e| e.to_string())
}

/// Engine for the open model: the project's choice, else the default one.
pub(super) fn effective_engine(settings: &Settings, project: Option<&str>) -> Option<EngineConfig> {
    project.and_then(|n| settings.engine(n)).or_else(|| settings.default_engine()).cloned()
}

fn engines_dto(state: &AppState) -> EnginesDto {
    let (settings, error) = load_settings();
    let project = state.read(|s| Ok(s.project.engine.clone())).ok().flatten();
    let effective = effective_engine(&settings, project.as_deref()).map(|e| e.name);
    EnginesDto {
        default: settings.default_engine().map(|e| e.name.clone()),
        engines: settings.engines,
        project,
        effective,
        settings_path: Settings::default_path(),
        error,
    }
}

#[tauri::command(async)]
pub fn engines(state: State<'_, AppState>) -> EnginesDto {
    engines_dto(&state)
}

/// Registers an engine after checking that it runs and reading its version.
#[tauri::command(async)]
pub fn add_engine(state: State<'_, AppState>, name: String, path: PathBuf) -> Res<EnginesDto> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("give the engine a name".into());
    }
    let version = swmm_engine::detect_version(&path).map_err(|e| e.to_string())?;
    let (mut settings, error) = load_settings();
    if let Some(e) = error {
        return Err(format!("settings not saved, the file is unreadable: {e}"));
    }
    settings.add_engine(EngineConfig { name, path, version });
    save_settings(&settings)?;
    Ok(engines_dto(&state))
}

#[tauri::command(async)]
pub fn remove_engine(state: State<'_, AppState>, name: String) -> Res<EnginesDto> {
    let (mut settings, _) = load_settings();
    settings.remove_engine(&name);
    save_settings(&settings)?;
    Ok(engines_dto(&state))
}

#[tauri::command(async)]
pub fn set_default_engine(state: State<'_, AppState>, name: String) -> Res<EnginesDto> {
    let (mut settings, _) = load_settings();
    settings.set_default(&name).map_err(|e| e.to_string())?;
    save_settings(&settings)?;
    Ok(engines_dto(&state))
}

/// Engine for this model only (`None`: use the default engine).
#[tauri::command(async)]
pub fn set_project_engine(state: State<'_, AppState>, name: Option<String>) -> Res<EnginesDto> {
    state.write(|s| {
        s.project.engine = name;
        s.save_project()
    })?;
    Ok(engines_dto(&state))
}
