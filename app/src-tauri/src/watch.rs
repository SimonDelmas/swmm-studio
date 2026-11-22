//! Changes made on disk by other programs to the files the app has loaded (F-FILE-6): the
//! model (`.inp`) and the loaded results (`.out`). They are polled: the size and the time of
//! the last change of a file are compared with those it had when it was read.

use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;

/// How often the files are looked at.
pub const INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// What a file looks like on disk (`None` in [`Watch`]: there is no file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> Option<Stamp> {
        let m = std::fs::metadata(path).ok()?;
        Some(Stamp { len: m.len(), modified: m.modified().ok() })
    }
}

/// Follows one file: reports, once, a change that is not the app's own.
#[derive(Debug, Clone)]
pub struct Watch {
    /// The file as the app read or wrote it.
    known: Option<Stamp>,
    /// The file at the last look: a change is reported once it stays the same between two
    /// looks (the other program finished writing).
    seen: Option<Stamp>,
    /// The change reported last, not reported again.
    reported: Option<Option<Stamp>>,
}

impl Watch {
    /// The file as it is now is the one the app has.
    pub fn new(path: &Path) -> Watch {
        let s = Stamp::of(path);
        Watch { known: s, seen: s, reported: None }
    }

    /// Looks at the file. `Some(exists)` when it changed since it was read (or since the
    /// last change the user chose to keep): it is reported once per change.
    pub fn poll(&mut self, path: &Path) -> Option<bool> {
        let now = Stamp::of(path);
        let stable = now == self.seen;
        self.seen = now;
        if now == self.known {
            // Back as it was (or changed by the app): a later change is new.
            self.reported = None;
            return None;
        }
        if !stable || self.reported == Some(now) {
            return None;
        }
        self.reported = Some(now);
        Some(now.is_some())
    }

    /// The user keeps what the app has: the file as it is now is no longer a change.
    pub fn ignore(&mut self, path: &Path) {
        *self = Watch::new(path);
    }
}

/// File changed by another program.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileChange {
    /// `model` (the `.inp`) or `results` (the loaded `.out`).
    pub kind: &'static str,
    pub path: std::path::PathBuf,
    /// False: the file was deleted (or renamed).
    pub exists: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn reports_a_change_once_it_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.inp");
        write(&p, "one");
        let mut w = Watch::new(&p);
        assert_eq!(w.poll(&p), None);
        write(&p, "two, longer");
        // Seen once: maybe still being written.
        assert_eq!(w.poll(&p), None);
        assert_eq!(w.poll(&p), Some(true));
        // Once only.
        assert_eq!(w.poll(&p), None);
        assert_eq!(w.poll(&p), None);
        // Another change is reported again.
        write(&p, "three, longer still");
        assert_eq!(w.poll(&p), None);
        assert_eq!(w.poll(&p), Some(true));
    }

    #[test]
    fn ignored_changes_are_the_file_the_app_has() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.out");
        write(&p, "one");
        let mut w = Watch::new(&p);
        write(&p, "two, longer");
        w.poll(&p);
        assert_eq!(w.poll(&p), Some(true));
        w.ignore(&p);
        assert_eq!(w.poll(&p), None);
        assert_eq!(w.poll(&p), None);
    }

    #[test]
    fn deleted_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.inp");
        write(&p, "one");
        let mut w = Watch::new(&p);
        std::fs::remove_file(&p).unwrap();
        w.poll(&p);
        assert_eq!(w.poll(&p), Some(false));
        // A file where there was none.
        let mut w = Watch::new(&p);
        write(&p, "new");
        w.poll(&p);
        assert_eq!(w.poll(&p), Some(true));
    }
}
