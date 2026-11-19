//! Autosave and crash recovery (F-FILE-5). While a model has unsaved changes, the app
//! writes it every [`INTERVAL`] to a recovery file in `%APPDATA%\SwmmStudio\recovery\`,
//! exactly as "save" would. The file is removed when the model is saved, closed or the app
//! quits: one that is still there belongs to a session that ended without saving, and the
//! app offers to restore it.
//!
//! Every model has a key (hash of its path) and three files: `<key>.inp` (the model),
//! `<key>.json` ([`RecoveryInfo`]) and `<key>.lock`, held open by the app that has the
//! model open. A lock nobody holds means that app is gone: its recovery file is offered.
//! Several windows can thus run side by side without taking each other's autosave for a
//! crash.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How often the open model is autosaved (when it changed): at most this much work is lost.
pub const INTERVAL: Duration = Duration::from_secs(30);

/// `recovery` next to the settings file.
pub fn default_dir() -> PathBuf {
    let settings = swmm_engine::Settings::default_path();
    settings.parent().unwrap_or(Path::new(".")).join("recovery")
}

/// A model with unsaved changes left by a session that ended without saving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryInfo {
    /// The model file.
    pub model: PathBuf,
    /// When the changes were autosaved (local time, `YYYY-MM-DD HH:MM:SS`).
    pub saved_at: String,
}

/// The path a model is known by: absolute, so that the same file always has the same key.
fn normalize(model: &Path) -> PathBuf {
    std::path::absolute(model).unwrap_or_else(|_| model.to_path_buf())
}

fn key(model: &Path) -> String {
    let p = normalize(model).to_string_lossy().into_owned();
    let p = if cfg!(windows) { p.to_lowercase() } else { p };
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(p.as_bytes()))
}

struct Files {
    inp: PathBuf,
    json: PathBuf,
    lock: PathBuf,
}

fn files(dir: &Path, key: &str) -> Files {
    Files {
        inp: dir.join(format!("{key}.inp")),
        json: dir.join(format!("{key}.json")),
        lock: dir.join(format!("{key}.lock")),
    }
}

/// Writes next to `path`, then replaces it: a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

fn remove(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != io::ErrorKind::NotFound {
            eprintln!("cannot remove {}: {e}", path.display());
        }
    }
}

/// Takes the lock of a model: an exclusive handle on a file deleted when it is closed,
/// also by the system when the app crashes.
#[cfg(windows)]
fn take_lock(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const DELETE: u32 = 0x0001_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .access_mode(GENERIC_WRITE | DELETE)
        .share_mode(0)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .open(path)
}

#[cfg(not(windows))]
fn take_lock(path: &Path) -> io::Result<File> {
    use std::io::Write;
    if held(path) {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, "locked"));
    }
    let mut f = File::create(path)?;
    write!(f, "{}", std::process::id())?;
    Ok(f)
}

/// The lock is held by a running app.
#[cfg(windows)]
fn held(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    if !path.exists() {
        return false;
    }
    // Nobody else can open a held lock; one that opens was left behind.
    match std::fs::OpenOptions::new().read(true).share_mode(0).open(path) {
        Ok(f) => {
            drop(f);
            remove(path);
            false
        }
        Err(_) => true,
    }
}

#[cfg(not(windows))]
fn held(path: &Path) -> bool {
    let Ok(pid) = std::fs::read_to_string(path) else { return false };
    let pid = pid.trim();
    !pid.is_empty() && pid != std::process::id().to_string() && Path::new("/proc").join(pid).exists()
}

fn read_info(json: &Path) -> Option<RecoveryInfo> {
    serde_json::from_str(&std::fs::read_to_string(json).ok()?).ok()
}

/// Autosave of the open model. Dropping it removes its recovery file (the model was
/// saved or its changes were given up), unless the file is one left by an earlier session
/// that has not been restored or discarded yet.
#[derive(Debug)]
pub struct Autosave {
    dir: PathBuf,
    model: PathBuf,
    key: String,
    _lock: File,
    /// Recovery file of an earlier session, not written over until restored or discarded.
    pending: Option<RecoveryInfo>,
    /// Revision of the model last written (`u64::MAX`: none).
    written: AtomicU64,
}

const NONE: u64 = u64::MAX;

impl Autosave {
    /// Starts the autosave of `model`. `None` when another running app has it open (that
    /// app autosaves it).
    pub fn claim(dir: &Path, model: &Path) -> io::Result<Option<Autosave>> {
        std::fs::create_dir_all(dir)?;
        let key = key(model);
        let f = files(dir, &key);
        if held(&f.lock) {
            return Ok(None);
        }
        let lock = match take_lock(&f.lock) {
            Ok(l) => l,
            // Taken in between by another app.
            Err(_) if f.lock.exists() => return Ok(None),
            Err(e) => return Err(e),
        };
        let pending = f.inp.exists().then(|| read_info(&f.json)).flatten();
        Ok(Some(Autosave {
            dir: dir.to_path_buf(),
            model: normalize(model),
            key,
            _lock: lock,
            pending,
            written: AtomicU64::new(NONE),
        }))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Unsaved changes left by an earlier session, to restore or discard.
    pub fn pending(&self) -> Option<&RecoveryInfo> {
        self.pending.as_ref()
    }

    /// The recovery file of the model.
    pub fn file(&self) -> PathBuf {
        files(&self.dir, &self.key).inp
    }

    /// Writes the model at `revision` (`bytes`), unless it is already written or an earlier
    /// recovery file waits for an answer. Returns whether it was written.
    pub fn write(&self, revision: u64, bytes: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<bool, String> {
        if self.pending.is_some() || self.written.load(Ordering::Relaxed) == revision {
            return Ok(false);
        }
        let f = files(&self.dir, &self.key);
        let bytes = bytes()?;
        write_atomic(&f.inp, &bytes).map_err(|e| format!("{}: {e}", f.inp.display()))?;
        let info = RecoveryInfo {
            model: self.model.clone(),
            saved_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        };
        let json = serde_json::to_vec_pretty(&info).expect("recovery info serializes");
        write_atomic(&f.json, &json).map_err(|e| format!("{}: {e}", f.json.display()))?;
        self.written.store(revision, Ordering::Relaxed);
        Ok(true)
    }

    /// Removes the recovery file (the model was saved, or has no unsaved changes).
    pub fn clear(&self) {
        if self.pending.is_some() {
            return;
        }
        self.remove_files();
    }

    /// The earlier session's changes were restored: they are now those of the model,
    /// autosaved as such (`revision`: the model with them).
    pub fn restored(&mut self, revision: u64) {
        self.pending = None;
        self.written.store(revision, Ordering::Relaxed);
    }

    /// The earlier session's changes are given up.
    pub fn discard(&mut self) {
        self.pending = None;
        self.remove_files();
    }

    fn remove_files(&self) {
        let f = files(&self.dir, &self.key);
        remove(&f.json);
        remove(&f.inp);
        self.written.store(NONE, Ordering::Relaxed);
    }
}

impl Drop for Autosave {
    fn drop(&mut self) {
        self.clear();
        // Windows deletes the lock when its handle closes.
        #[cfg(not(windows))]
        remove(&files(&self.dir, &self.key).lock);
    }
}

/// Models with unsaved changes left by sessions that ended without saving, newest first.
pub fn list(dir: &Path) -> Vec<RecoveryInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<RecoveryInfo> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|json| {
            let f = files(dir, json.file_stem()?.to_str()?);
            if !f.inp.exists() || held(&f.lock) {
                return None;
            }
            read_info(&json)
        })
        .collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    out
}

/// Gives up the changes left for `model` (not when an app has it open).
pub fn discard(dir: &Path, model: &Path) {
    let f = files(dir, &key(model));
    if !held(&f.lock) {
        remove(&f.json);
        remove(&f.inp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(dir: &Path) -> PathBuf {
        dir.join("Model.inp")
    }

    #[test]
    fn autosave_then_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let rec = tmp.path().join("recovery");
        let m = model(tmp.path());
        let a = Autosave::claim(&rec, &m).unwrap().unwrap();
        assert!(a.pending().is_none());
        assert!(a.write(1, || Ok(b"[TITLE]\r\nx\r\n".to_vec())).unwrap());
        // Same revision: not written again.
        assert!(!a.write(1, || panic!("written twice")).unwrap());
        assert_eq!(std::fs::read(a.file()).unwrap(), b"[TITLE]\r\nx\r\n");
        // Held by this app: not offered.
        assert!(list(&rec).is_empty());
        a.clear();
        assert!(!a.file().exists());
        assert!(a.write(1, || Ok(b"y".to_vec())).unwrap());
        let file = a.file();
        drop(a);
        assert!(!file.exists(), "closing the model removes its recovery file");
    }

    #[test]
    fn second_claim_is_refused_while_held() {
        let tmp = tempfile::tempdir().unwrap();
        let m = model(tmp.path());
        let a = Autosave::claim(tmp.path(), &m).unwrap();
        assert!(a.is_some());
        #[cfg(windows)]
        assert!(Autosave::claim(tmp.path(), &m).unwrap().is_none());
        drop(a);
        assert!(Autosave::claim(tmp.path(), &m).unwrap().is_some());
    }

    #[test]
    fn leftover_is_offered_then_restored_or_discarded() {
        let tmp = tempfile::tempdir().unwrap();
        let rec = tmp.path().join("recovery");
        let m = model(tmp.path());
        // Files as an app that crashed leaves them (no lock).
        std::fs::create_dir_all(&rec).unwrap();
        let f = files(&rec, &key(&m));
        std::fs::write(&f.inp, b"edited").unwrap();
        let info = RecoveryInfo { model: normalize(&m), saved_at: "2026-11-19 10:00:00".into() };
        std::fs::write(&f.json, serde_json::to_vec(&info).unwrap()).unwrap();
        assert_eq!(list(&rec), vec![info.clone()]);

        let a = Autosave::claim(&rec, &m).unwrap().unwrap();
        assert_eq!(a.pending(), Some(&info));
        // Not written over while waiting for an answer, nor removed with the autosave.
        assert!(!a.write(1, || panic!("written over")).unwrap());
        drop(a);
        assert!(f.inp.exists());

        let mut a = Autosave::claim(&rec, &m).unwrap().unwrap();
        a.restored(7);
        assert!(a.pending().is_none());
        assert!(!a.write(7, || panic!("already there")).unwrap());
        a.discard();
        assert!(!f.inp.exists() && !f.json.exists());
    }

    #[test]
    fn discard_without_opening() {
        let tmp = tempfile::tempdir().unwrap();
        let m = model(tmp.path());
        let f = files(tmp.path(), &key(&m));
        std::fs::write(&f.inp, b"x").unwrap();
        std::fs::write(&f.json, b"{}").unwrap();
        discard(tmp.path(), &m);
        assert!(!f.inp.exists() && !f.json.exists());
        // Unreadable info: not offered.
        assert!(list(tmp.path()).is_empty());
    }
}
