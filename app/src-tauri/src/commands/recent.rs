//! Recent files and crash recovery (F-FILE-5).

use std::path::{Path, PathBuf};

use serde::Serialize;
use swmm_engine::Settings;
use tauri::State;

use super::AppState;
use crate::recovery::{self, RecoveryInfo};
use crate::session::{ModelInfo, Res};

#[derive(Serialize)]
pub struct RecentFile {
    path: PathBuf,
    name: String,
    /// The file is still there.
    exists: bool,
}

/// Changes the settings with `f` and saves them; not when the file cannot be read (it
/// would be written over).
fn update_settings(f: impl FnOnce(&mut Settings)) {
    let (mut settings, error) = Settings::load_or_default();
    if error.is_some() {
        return;
    }
    f(&mut settings);
    if let Err(e) = settings.save(&Settings::default_path()) {
        eprintln!("cannot save the settings: {e}");
    }
}

/// Puts a model at the top of the recent files.
pub(crate) fn remember(path: &Path) {
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    update_settings(|s| s.add_recent(&path));
}

fn recent_list() -> Vec<RecentFile> {
    Settings::load_or_default()
        .0
        .recent_files
        .into_iter()
        .map(|path| RecentFile {
            name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            exists: path.is_file(),
            path,
        })
        .collect()
}

/// Models opened or saved last, newest first.
#[tauri::command(async)]
pub fn recent_files() -> Vec<RecentFile> {
    recent_list()
}

/// Removes a model from the recent files (`None`: all of them).
#[tauri::command(async)]
pub fn forget_recent_file(path: Option<PathBuf>) -> Vec<RecentFile> {
    update_settings(|s| match &path {
        Some(p) => {
            s.remove_recent(p);
        }
        None => s.recent_files.clear(),
    });
    recent_list()
}

/// Models with unsaved changes left by sessions that ended without saving.
#[tauri::command(async)]
pub fn recoveries() -> Vec<RecoveryInfo> {
    recovery::list(&recovery::default_dir())
}

/// Replaces the open model by the unsaved changes an earlier session left.
#[tauri::command(async)]
pub fn restore_recovery(state: State<'_, AppState>) -> Res<ModelInfo> {
    state.write(|s| {
        s.restore_recovery()?;
        Ok(s.info())
    })
}

/// Gives up the unsaved changes left for `model` (`None`: for the open model).
#[tauri::command(async)]
pub fn discard_recovery(state: State<'_, AppState>, model: Option<PathBuf>) -> Res<Option<ModelInfo>> {
    match model {
        Some(m) => {
            recovery::discard(&recovery::default_dir(), &m);
            Ok(None)
        }
        None => state.write(|s| {
            s.discard_recovery();
            Ok(Some(s.info()))
        }),
    }
}
