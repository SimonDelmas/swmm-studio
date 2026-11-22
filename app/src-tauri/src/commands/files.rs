//! Files written for the user (exported figures and tables), and files changed by other programs.

use std::path::PathBuf;

use tauri::State;

use super::AppState;
use crate::session::Res;

/// Keeps the model (`model`) or the loaded results (`results`) as they are after another
/// program changed their file: that change is no longer reported.
#[tauri::command(async)]
pub fn ignore_file_change(state: State<'_, AppState>, kind: String) -> Res<()> {
    state.write(|s| s.ignore_file_change(&kind))
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

/// Writes a table as CSV or, for a `.xlsx` path, as an Excel workbook (numbers as numbers).
#[tauri::command(async)]
pub fn export_table(path: PathBuf, title: String, columns: Vec<String>, rows: Vec<Vec<String>>) -> Res<()> {
    crate::export::write_table(&path, &title, &columns, &rows)
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
