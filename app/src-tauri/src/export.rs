//! Table exports: CSV, or an Excel workbook when the path ends in `.xlsx`.

use std::path::Path;

use crate::session::Res;

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Text of a CSV file (CRLF line ends, like Excel writes them).
pub fn csv(columns: &[String], rows: &[Vec<String>]) -> String {
    let mut out = String::new();
    for r in std::iter::once(columns).chain(rows.iter().map(Vec::as_slice)) {
        out.push_str(&r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

/// A cell that reads as a finite number (written as a number in workbooks).
fn number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.starts_with('+') || (t.len() > 1 && t.starts_with('0') && !t.starts_with("0.")) {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

pub fn write_table(path: &Path, title: &str, columns: &[String], rows: &[Vec<String>]) -> Res<()> {
    let is_xlsx = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xlsx"));
    if !is_xlsx {
        return std::fs::write(path, csv(columns, rows)).map_err(|e| format!("{}: {e}", path.display()));
    }
    use rust_xlsxwriter::{Format, Workbook};
    let err = |e: rust_xlsxwriter::XlsxError| format!("{}: {e}", path.display());
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    // Sheet names: at most 31 characters, none of []:*?/\.
    let name: String = title.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
    if !name.trim().is_empty() {
        ws.set_name(name.trim()).map_err(err)?;
    }
    let bold = Format::new().set_bold();
    for (c, h) in columns.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, &bold).map_err(err)?;
    }
    for (r, row) in rows.iter().enumerate() {
        let r = (r + 1) as u32;
        for (c, v) in row.iter().enumerate() {
            match number(v) {
                Some(x) => ws.write_number(r, c as u16, x).map_err(err)?,
                None => ws.write_string(r, c as u16, v).map_err(err)?,
            };
        }
    }
    ws.set_freeze_panes(1, 0).map_err(err)?;
    ws.autofit();
    wb.save(path).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_and_xlsx() {
        let cols = vec!["Node".to_string(), "Max (m)".to_string()];
        let rows = vec![vec!["J1".to_string(), "1.5".to_string()], vec!["a,\"b\"".to_string(), "007".to_string()]];
        assert_eq!(csv(&cols, &rows), "Node,Max (m)\r\nJ1,1.5\r\n\"a,\"\"b\"\"\",007\r\n");
        assert_eq!(
            (number("1.5"), number("007"), number("0.5"), number("x"), number("NaN")),
            (Some(1.5), None, Some(0.5), None, None)
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.xlsx");
        write_table(&p, "Events: nodes", &cols, &rows).unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!(&b[..2], b"PK");
        write_table(&dir.path().join("t.csv"), "x", &cols, &rows).unwrap();
    }
}
