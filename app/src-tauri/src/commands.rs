//! Tauri commands: thin wrappers around [`Session`]. Large arrays are returned as raw
//! little-endian buffers (`ArrayBuffer` on the JS side), everything else as JSON.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use swmm_model::{ObjKind, ObjRef};
use swmm_out::cache::{self, CacheOptions};
use swmm_out::OutFile;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::project::Basemap;
use crate::session::{element_by_name, ModelInfo, Res, Session};

#[derive(Default)]
pub struct AppState {
    session: RwLock<Option<Session>>,
    /// Cancel flag of the running cache build.
    job: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    fn read<T>(&self, f: impl FnOnce(&Session) -> Res<T>) -> Res<T> {
        let g = self.session.read().map_err(|_| "internal error (lock)".to_string())?;
        f(g.as_ref().ok_or("no model open")?)
    }

    fn write<T>(&self, f: impl FnOnce(&mut Session) -> Res<T>) -> Res<T> {
        let mut g = self.session.write().map_err(|_| "internal error (lock)".to_string())?;
        f(g.as_mut().ok_or("no model open")?)
    }

    fn cancel_job(&self) {
        if let Some(cancel) = self.job.lock().unwrap().take() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn kind(s: &str) -> Res<ObjKind> {
    ObjKind::from_name(s).ok_or_else(|| format!("unknown object kind {s:?}"))
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

#[derive(Clone, Serialize)]
struct CacheEvent {
    path: PathBuf,
    progress: f64,
}

/// Starts building the results cache in the background if the open `.out` has none.
fn start_cache_job(app: &AppHandle, state: &AppState) {
    let Ok(Some(path)) = state.read(|s| Ok(s.cache_job())) else {
        return;
    };
    state.cancel_job();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.job.lock().unwrap() = Some(cancel.clone());
    let app = app.clone();
    std::thread::spawn(move || {
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
        state.job.lock().unwrap().take();
        if let Ok(Some(info)) = state.read(|s| Ok(s.results_info())) {
            let _ = app.emit("results-changed", info);
        }
    });
}

#[tauri::command(async)]
pub fn open_model(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> Res<ModelInfo> {
    state.cancel_job();
    let session = Session::open(&path)?;
    let info = session.info();
    *state.session.write().unwrap() = Some(session);
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
    let k = self::kind(&kind)?;
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
    state.write(|s| {
        if let Some(b) = basemap {
            s.project.basemap = b;
        }
        if let Some(ui) = ui {
            s.project.ui = ui;
        }
        s.save_project()
    })
}

#[tauri::command(async)]
pub fn pick(state: State<'_, AppState>, x: f64, y: f64, tol: f64) -> Res<Option<ObjRef>> {
    state.read(|s| Ok(s.pick([x, y], tol)))
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
pub fn object_info(
    state: State<'_, AppState>,
    kind: String,
    index: u32,
    period: Option<usize>,
) -> Res<crate::session::ObjectInfo> {
    let k = self::kind(&kind)?;
    state.read(|s| s.object(ObjRef { kind: k, index }, period))
}

#[tauri::command(async)]
pub fn attribute(state: State<'_, AppState>, kind: String, name: String) -> Res<Response> {
    let k = self::kind(&kind)?;
    state.read(|s| s.attribute(k, &name).map(|v| Response::new(f32_bytes(&v))))
}

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
    state.read(|s| s.frame(k, var, period).map(|v| Response::new(f32_bytes(&v))))
}

/// `u32 n`, then `u32 periods[n]`, `f32 min[n]`, `f32 max[n]`.
#[tauri::command(async)]
pub fn series(
    state: State<'_, AppState>,
    kind: String,
    index: usize,
    var: usize,
    p0: usize,
    p1: usize,
    buckets: usize,
) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| {
        let mm = s.series(k, index, var, p0, p1, buckets.clamp(1, 20_000))?;
        let mut b = Vec::with_capacity(4 + 12 * mm.len());
        b.extend_from_slice(&(mm.len() as u32).to_le_bytes());
        b.extend(mm.periods.iter().flat_map(|&p| (p as u32).to_le_bytes()));
        b.extend(f32_bytes(&mm.min));
        b.extend(f32_bytes(&mm.max));
        Ok(Response::new(b))
    })
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

#[tauri::command(async)]
pub fn report_block(state: State<'_, AppState>, index: usize) -> Res<crate::session::BlockDto> {
    state.read(|s| s.report_block(index))
}

/// Whole-run maximum per object (`f32` array, network order).
#[tauri::command(async)]
pub fn envelope(state: State<'_, AppState>, kind: String, var: usize) -> Res<Response> {
    let k = element_by_name(&kind)?;
    state.read(|s| s.envelope_max(k, var).map(|v| Response::new(f32_bytes(&v))))
}

/// Writes the raw request body to the file named by the `path` header (exports).
#[tauri::command(async)]
pub fn save_file(request: tauri::ipc::Request<'_>) -> Res<()> {
    let path = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("missing path")?;
    let path = percent_decode(path);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

/// Header values are ASCII: the UI percent-encodes the path.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Deletes and rebuilds the results cache.
#[tauri::command(async)]
pub fn rebuild_cache(app: AppHandle, state: State<'_, AppState>) -> Res<ModelInfo> {
    state.cancel_job();
    let path = state.read(|s| s.results.as_ref().map(|r| r.path.clone()).ok_or("no results loaded".into()))?;
    let info = state.write(|s| {
        // Reopen without the cache, then build it again.
        s.results = None;
        let _ = std::fs::remove_file(cache::default_cache_path(&path));
        s.open_results(&path)?;
        Ok(s.info())
    })?;
    start_cache_job(&app, &state);
    Ok(info)
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_decoding() {
        assert_eq!(super::percent_decode("C%3A%5Cr%C3%A9seau%20a.png"), r"C:\réseau a.png");
        assert_eq!(super::percent_decode("100%"), "100%");
        assert_eq!(super::percent_decode("%zz%4"), "%zz%4");
    }
}
