//! Tauri commands: thin wrappers around [`Session`], grouped by domain. Large arrays
//! are returned as raw little-endian buffers (`ArrayBuffer` on the JS side), everything
//! else as JSON.

pub mod analysis;
pub mod cache;
pub mod editing;
pub mod engines;
pub mod files;
pub mod model;
pub mod observed;
pub mod recent;
pub mod results;
pub mod run;
pub mod runs;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use swmm_model::ObjKind;
use tauri::ipc::Response;

use crate::session::{Res, Session};

#[derive(Default)]
pub struct AppState {
    session: RwLock<Option<Session>>,
    /// Cancel flag of the running cache build.
    job: Mutex<Option<Arc<AtomicBool>>>,
    /// Cancel flag of the running simulation.
    run: Mutex<Option<Arc<AtomicBool>>>,
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

    /// Makes `session` the open model.
    fn replace(&self, session: Session) -> Res<()> {
        *self.session.write().map_err(|_| "internal error (lock)".to_string())? = Some(session);
        Ok(())
    }

    /// Writes the unsaved changes of the open model to its recovery file.
    pub fn autosave(&self) {
        if let Ok(g) = self.session.read() {
            if let Some(Err(e)) = g.as_ref().map(Session::autosave) {
                eprintln!("autosave failed: {e}");
            }
        }
    }

    /// Closes the model (the app quits): its recovery file goes with it, the user
    /// already chose not to save.
    pub fn close(&self) {
        if let Ok(mut g) = self.session.write() {
            g.take();
        }
    }

    /// Stops the running cache build, if any.
    fn cancel_job(&self) {
        if let Some(cancel) = self.job.lock().unwrap().take() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn obj_kind(s: &str) -> Res<ObjKind> {
    ObjKind::from_name(s).ok_or_else(|| format!("unknown object kind {s:?}"))
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// An `f32` array as a raw little-endian response.
fn floats(v: &[f32]) -> Response {
    Response::new(f32_bytes(v))
}
