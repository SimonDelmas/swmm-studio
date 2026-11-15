//! Background build of the results caches.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use swmm_out::cache::{self, CacheOptions};
use swmm_out::OutFile;
use tauri::{AppHandle, Emitter, Manager, State};

use super::AppState;
use crate::session::{ModelInfo, Res};

#[derive(Clone, Serialize)]
struct CacheEvent {
    path: PathBuf,
    progress: f64,
}

/// Starts building, in the background, the results caches that the loaded and the
/// compared `.out` files lack (one after the other).
pub(super) fn start_cache_job(app: &AppHandle, state: &AppState) {
    let Ok(paths) = state.read(|s| Ok(s.cache_jobs())) else {
        return;
    };
    if paths.is_empty() {
        return;
    }
    state.cancel_job();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.job.lock().unwrap() = Some(cancel.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        for path in paths {
            let last = Mutex::new(Instant::now());
            let progress = |p: cache::BuildProgress| {
                let mut l = last.lock().unwrap();
                if l.elapsed() < Duration::from_millis(250) {
                    return;
                }
                *l = Instant::now();
                let f = p.bytes_done as f64 / p.bytes_total.max(1) as f64;
                let state = app.state::<AppState>();
                let _ = state.write(|s| {
                    s.cache_progress(&path, f);
                    Ok(())
                });
                let _ = app.emit("cache-progress", CacheEvent { path: path.clone(), progress: f });
            };
            let outcome = OutFile::open(&path).map_err(|e| e.to_string()).and_then(|out| {
                cache::build(&out, &cache::default_cache_path(&path), &CacheOptions::default(), progress, &cancel)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            });
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let state = app.state::<AppState>();
            let _ = state.write(|s| {
                s.cache_done(&path, outcome);
                Ok(())
            });
            if let Ok(info) = state.read(|s| Ok(s.info())) {
                for r in info.results.into_iter().chain(info.compare).filter(|r| r.path == path) {
                    let _ = app.emit("results-changed", r);
                }
            }
        }
        // Free the slot, unless a newer job took it while this one was finishing.
        let state = app.state::<AppState>();
        let mut slot = state.job.lock().unwrap();
        if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            slot.take();
        }
    });
}

/// Deletes and rebuilds the results cache.
#[tauri::command(async)]
pub fn rebuild_cache(app: AppHandle, state: State<'_, AppState>) -> Res<ModelInfo> {
    state.cancel_job();
    let path = state.read(|s| s.results_path().map(Path::to_path_buf).ok_or("no results loaded".into()))?;
    let info = state.write(|s| {
        // Reopen without the cache (its file must not be mapped), then build it again.
        s.close_results();
        let _ = std::fs::remove_file(cache::default_cache_path(&path));
        s.open_results(&path)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}
