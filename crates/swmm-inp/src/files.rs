//! External files referenced by a model (rainfall, time series, hotstart…).
//!
//! The engine runner uses this to make paths absolute when it runs a copy of the model
//! from another folder.

use crate::{InpFile, LineKind, SectionKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRefKind {
    /// `[FILES]` entry: `USE|SAVE <type> <file>`.
    Interface { mode: String, file_type: String },
    /// Rain gage reading a rainfall file.
    RaingageFile { gage: String },
    /// Time series stored in an external file.
    TimeseriesFile { series: String },
    /// `[TEMPERATURE] FILE` climate file.
    ClimateFile,
    /// LID report file.
    LidReport { subcatchment: String },
    /// `[BACKDROP] FILE` image (GUI only).
    Backdrop,
    /// `modules_configuration=<file>` in `[TITLE]` (SWMM extension modules).
    ModulesConfig,
}

/// Location of a file path in the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef {
    pub kind: FileRefKind,
    pub section: usize,
    pub line: usize,
    /// Token holding the path; `None` for a `key=value` text line.
    pub token: Option<usize>,
    pub path: String,
}

const MODULES_KEY: &str = "modules_configuration";

impl InpFile {
    /// All external file paths found in the model, as written in the file.
    pub fn file_refs(&self) -> Vec<FileRef> {
        let mut out = Vec::new();
        for (si, s) in self.sections().iter().enumerate() {
            for (li, l) in s.data() {
                let t = |i: usize| l.token(i).unwrap_or("");
                let mut push = |kind: FileRefKind, token: usize| {
                    if let Some(path) = l.token(token) {
                        out.push(FileRef { kind, section: si, line: li, token: Some(token), path: path.to_string() });
                    }
                };
                match s.kind() {
                    SectionKind::Files => push(
                        FileRefKind::Interface {
                            mode: t(0).to_ascii_uppercase(),
                            file_type: t(1).to_ascii_uppercase(),
                        },
                        2,
                    ),
                    SectionKind::Raingages if t(4).eq_ignore_ascii_case("FILE") => {
                        push(FileRefKind::RaingageFile { gage: t(0).to_string() }, 5)
                    }
                    SectionKind::Timeseries if t(1).eq_ignore_ascii_case("FILE") => {
                        push(FileRefKind::TimeseriesFile { series: t(0).to_string() }, 2)
                    }
                    SectionKind::Temperature if t(0).eq_ignore_ascii_case("FILE") => push(FileRefKind::ClimateFile, 1),
                    SectionKind::Backdrop if t(0).eq_ignore_ascii_case("FILE") => push(FileRefKind::Backdrop, 1),
                    SectionKind::LidUsage if l.len() > 8 && t(8) != "*" => {
                        push(FileRefKind::LidReport { subcatchment: t(0).to_string() }, 8)
                    }
                    SectionKind::Title if l.kind() == LineKind::Text => {
                        if let Some((key, value)) = l.text().split_once('=') {
                            if key.trim().eq_ignore_ascii_case(MODULES_KEY) {
                                out.push(FileRef {
                                    kind: FileRefKind::ModulesConfig,
                                    section: si,
                                    line: li,
                                    token: None,
                                    path: value.trim().to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }

    /// Replaces the path of a reference returned by [`InpFile::file_refs`].
    pub fn set_file_ref(&mut self, r: &FileRef, path: &str) -> bool {
        let Some(line) = self.sections_mut().get_mut(r.section).and_then(|s| s.line_mut(r.line)) else {
            return false;
        };
        match r.token {
            Some(t) => line.set_token(t, path),
            None => {
                let ending = line.ending();
                *line = crate::Line::from_text(format!("{MODULES_KEY}={path}"), ending, true);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "[TITLE]\nmodules_configuration=modules.inp\n\n[FILES]\nUSE HOTSTART \"hot start.hsf\"\n\n[RAINGAGES]\nRG1 INTENSITY 0:05 1.0 FILE rain.dat STA1 MM\nRG2 INTENSITY 0:05 1.0 TIMESERIES TS1\n\n[TIMESERIES]\nTS1 01/01/2000 0:00 0\nTS2 FILE ts2.dat\n\n[TEMPERATURE]\nFILE climate.txt\n";

    #[test]
    fn finds_and_rewrites_refs() {
        let mut inp = InpFile::parse_str(SRC);
        let refs = inp.file_refs();
        let paths: Vec<_> = refs.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["modules.inp", "hot start.hsf", "rain.dat", "ts2.dat", "climate.txt"]);
        for r in &refs {
            assert!(inp.set_file_ref(r, &format!("C:\\models\\{}", r.path)));
        }
        let text = inp.to_string_lossy();
        assert!(text.contains("modules_configuration=C:\\models\\modules.inp\n"));
        assert!(text.contains("USE HOTSTART \"C:\\models\\hot start.hsf\""));
        assert!(text.contains("FILE C:\\models\\rain.dat STA1"));
        assert!(text.contains("TS2 FILE C:\\models\\ts2.dat"));
    }
}
