//! Byte-exact round-trip on a corpus of real models.
//!
//! Set `SWMM_INP_CORPUS` to a folder; every `*.inp` below it is parsed and written back.
//! Skipped when the variable is not set.

use std::path::{Path, PathBuf};

use swmm_inp::InpFile;

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("inp")) {
            out.push(p);
        }
    }
}

#[test]
fn corpus_round_trip() {
    let Some(root) = std::env::var_os("SWMM_INP_CORPUS") else {
        eprintln!("SWMM_INP_CORPUS not set, skipping");
        return;
    };
    let mut files = Vec::new();
    collect(Path::new(&root), &mut files);
    assert!(!files.is_empty(), "no .inp file found");
    let mut failures = Vec::new();
    for f in &files {
        let bytes = std::fs::read(f).unwrap();
        let inp = InpFile::parse_bytes(&bytes);
        match inp.to_bytes() {
            Ok(out) if out == bytes => {}
            _ => failures.push(f.display().to_string()),
        }
    }
    eprintln!("{} files, {} failures", files.len(), failures.len());
    assert!(failures.is_empty(), "round-trip failed for:\n{}", failures.join("\n"));
}
