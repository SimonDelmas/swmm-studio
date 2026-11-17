//! Reading a file into a table of cells: CSV and other delimited text, Excel and
//! OpenDocument workbooks, Parquet.

use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Field;
use serde::Serialize;

use crate::{time, Error};

/// One value of a table.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Number(f64),
    Text(String),
    /// A date stored as such (Excel date cells, Parquet timestamps).
    Time(NaiveDateTime),
}

impl Cell {
    pub fn text(&self) -> String {
        match self {
            Cell::Empty => String::new(),
            Cell::Number(v) => v.to_string(),
            Cell::Text(s) => s.clone(),
            Cell::Time(t) => t.format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// Delimited text (`,` `;` tab `|`).
    Text,
    /// Excel or OpenDocument workbook.
    Workbook,
    Parquet,
}

/// A table read from a file, by columns.
#[derive(Debug, Clone, Default)]
pub struct Table {
    pub headers: Vec<String>,
    /// One vector per header, all of the same length.
    pub columns: Vec<Vec<Cell>>,
}

impl Table {
    pub fn rows(&self) -> usize {
        self.columns.first().map_or(0, Vec::len)
    }

    /// Builds a table from rows, the first one (if it is not data) giving the column titles.
    fn from_rows(mut rows: Vec<Vec<Cell>>) -> Table {
        rows.retain(|r| r.iter().any(|c| *c != Cell::Empty));
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        // A first row with a date or a number in it is data: the columns get numbers.
        let has_header = rows.first().is_some_and(|r| {
            r.iter().all(|c| match c {
                Cell::Text(s) => time::parse(s, time::DateOrder::Auto).is_none(),
                Cell::Empty => true,
                _ => false,
            })
        });
        let header_row = if has_header { rows.remove(0) } else { Vec::new() };
        let mut headers: Vec<String> = Vec::with_capacity(width);
        for i in 0..width {
            let base = match header_row.get(i).map(Cell::text) {
                Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => format!("Column {}", i + 1),
            };
            let mut name = base.clone();
            let mut k = 2;
            while headers.contains(&name) {
                name = format!("{base} ({k})");
                k += 1;
            }
            headers.push(name);
        }
        let mut columns = vec![Vec::with_capacity(rows.len()); width];
        for r in rows {
            let mut r = r.into_iter();
            for col in columns.iter_mut() {
                col.push(r.next().unwrap_or(Cell::Empty));
            }
        }
        Table { headers, columns }
    }
}

/// What the file is, from its extension.
pub fn format_of(path: &Path) -> Result<Format, Error> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "csv" | "txt" | "tsv" | "dat" | "prn" => Ok(Format::Text),
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => Ok(Format::Workbook),
        "parquet" | "pq" => Ok(Format::Parquet),
        _ => Err(Error::Format(ext)),
    }
}

/// Reads a file; `sheet` picks the sheet of a workbook (default: the first). Returns the
/// table and the sheets of the workbook (none for other formats).
pub fn read(path: &Path, sheet: Option<&str>) -> Result<(Table, Vec<String>, Format), Error> {
    let format = format_of(path)?;
    let (table, sheets) = match format {
        Format::Text => (read_text(&std::fs::read(path)?)?, Vec::new()),
        Format::Workbook => read_workbook(path, sheet)?,
        Format::Parquet => (read_parquet(path)?, Vec::new()),
    };
    if table.headers.is_empty() {
        return Err(Error::Empty);
    }
    Ok((table, sheets, format))
}

const MISSING: [&str; 8] = ["", "na", "nan", "n/a", "null", "none", "-", "#n/a"];

/// A number written as text; with `comma`, a decimal comma is accepted (`1,5`).
fn number(s: &str, comma: bool) -> Option<f64> {
    let t: String = s.chars().filter(|c| !matches!(c, ' ' | '\u{a0}' | '\u{202f}')).collect();
    let t = if comma && t.contains(',') && !t.contains('.') { t.replace(',', ".") } else { t };
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn text_cell(s: &str, comma: bool) -> Cell {
    let s = s.trim();
    if MISSING.contains(&s.to_ascii_lowercase().as_str()) {
        return Cell::Empty;
    }
    match number(s, comma) {
        Some(v) => Cell::Number(v),
        None => Cell::Text(s.to_string()),
    }
}

/// The delimiter found on most of the first lines the same number of times.
fn sniff_delimiter(text: &str) -> u8 {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(30).collect();
    let mut best = (0usize, b',');
    for d in [b';', b'\t', b',', b'|'] {
        let counts: Vec<usize> = lines.iter().map(|l| l.bytes().filter(|&b| b == d).count()).collect();
        let Some(&first) = counts.iter().find(|&&c| c > 0) else { continue };
        let same = counts.iter().filter(|&&c| c == first).count();
        if same > best.0 {
            best = (same, d);
        }
    }
    best.1
}

/// Delimited text, in UTF-8 or else Windows-1252; lines starting with `#` before the
/// table are comments.
pub(crate) fn read_text(bytes: &[u8]) -> Result<Table, Error> {
    let text = match std::str::from_utf8(bytes) {
        Ok(s) => s.trim_start_matches('\u{feff}').to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    };
    let start: usize = text
        .split_inclusive('\n')
        .take_while(|l| l.trim_start().starts_with('#') || l.trim().is_empty())
        .map(str::len)
        .sum();
    let text = &text[start..];
    let delimiter = sniff_delimiter(text);
    let comma = delimiter != b',';
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for rec in reader.records() {
        let rec = rec.map_err(|e| Error::Read(e.to_string()))?;
        rows.push(rec.iter().map(|s| text_cell(s, comma)).collect());
    }
    Ok(Table::from_rows(rows))
}

fn read_workbook(path: &Path, sheet: Option<&str>) -> Result<(Table, Vec<String>), Error> {
    let mut wb = open_workbook_auto(path).map_err(|e| Error::Read(e.to_string()))?;
    let sheets = wb.sheet_names().to_vec();
    let name = match sheet {
        Some(s) if sheets.iter().any(|x| x == s) => s.to_string(),
        Some(s) => return Err(Error::Sheet(s.to_string())),
        None => sheets.first().cloned().ok_or(Error::Empty)?,
    };
    let range = wb.worksheet_range(&name).map_err(|e| Error::Read(e.to_string()))?;
    let rows = range
        .rows()
        .map(|r| {
            r.iter()
                .map(|c| match c {
                    Data::Empty | Data::Error(_) => Cell::Empty,
                    Data::Int(v) => Cell::Number(*v as f64),
                    Data::Float(v) => Cell::Number(*v),
                    Data::Bool(b) => Cell::Number(f64::from(u8::from(*b))),
                    Data::String(s) => text_cell(s, true),
                    Data::DateTime(d) => d.as_datetime().map_or(Cell::Empty, Cell::Time),
                    Data::DateTimeIso(s) => {
                        time::parse(s, time::DateOrder::Auto).map_or_else(|| Cell::Text(s.clone()), Cell::Time)
                    }
                    Data::DurationIso(s) => Cell::Text(s.clone()),
                })
                .collect()
        })
        .collect();
    Ok((Table::from_rows(rows), sheets))
}

fn parquet_cell(f: &Field) -> Cell {
    let from_ms = |ms: i64| DateTime::from_timestamp_millis(ms).map_or(Cell::Empty, |t| Cell::Time(t.naive_utc()));
    match f {
        Field::Null => Cell::Empty,
        Field::Bool(b) => Cell::Number(f64::from(u8::from(*b))),
        Field::Byte(v) => Cell::Number(f64::from(*v)),
        Field::Short(v) => Cell::Number(f64::from(*v)),
        Field::Int(v) => Cell::Number(f64::from(*v)),
        Field::Long(v) => Cell::Number(*v as f64),
        Field::UByte(v) => Cell::Number(f64::from(*v)),
        Field::UShort(v) => Cell::Number(f64::from(*v)),
        Field::UInt(v) => Cell::Number(f64::from(*v)),
        Field::ULong(v) => Cell::Number(*v as f64),
        Field::Float16(v) => Cell::Number(f64::from(*v)),
        Field::Float(v) => Cell::Number(f64::from(*v)),
        Field::Double(v) => Cell::Number(*v),
        Field::Decimal(_) => Cell::Text(f.to_string()).to_number(),
        Field::Str(s) => text_cell(s, true),
        Field::Date(days) => NaiveDate::from_num_days_from_ce_opt(*days + 719_163)
            .map_or(Cell::Empty, |d| Cell::Time(d.and_time(chrono::NaiveTime::MIN))),
        Field::TimestampMillis(ms) => from_ms(*ms),
        Field::TimestampMicros(us) => from_ms(us.div_euclid(1000)),
        _ => Cell::Text(f.to_string()),
    }
}

impl Cell {
    fn to_number(self) -> Cell {
        match &self {
            Cell::Text(s) => number(s, false).map_or(self, Cell::Number),
            _ => self,
        }
    }
}

fn read_parquet(path: &Path) -> Result<Table, Error> {
    let file = std::fs::File::open(path)?;
    let reader = SerializedFileReader::new(file).map_err(|e| Error::Read(e.to_string()))?;
    let schema = reader.metadata().file_metadata().schema_descr();
    let headers: Vec<String> = schema.root_schema().get_fields().iter().map(|f| f.name().to_string()).collect();
    let mut columns = vec![Vec::new(); headers.len()];
    for row in reader.get_row_iter(None).map_err(|e| Error::Read(e.to_string()))? {
        let row = row.map_err(|e| Error::Read(e.to_string()))?;
        for (col, (_, f)) in columns.iter_mut().zip(row.get_column_iter()) {
            col.push(parquet_cell(f));
        }
    }
    Ok(Table { headers, columns })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delimited_text() {
        let t = read_text(b"# station 12\nDate;Q (l/s);H\n31/01/2024 12:00;1,5;NA\n31/01/2024 12:05;2;0,3\n").unwrap();
        assert_eq!(t.headers, ["Date", "Q (l/s)", "H"]);
        assert_eq!(t.columns[1], [Cell::Number(1.5), Cell::Number(2.0)]);
        assert_eq!(t.columns[2], [Cell::Empty, Cell::Number(0.3)]);
        let t = read_text(b"time,flow\n2024-01-01 00:00,1.5\n").unwrap();
        assert_eq!(t.columns[1], [Cell::Number(1.5)]);
        // No title row: numbered columns.
        let t = read_text(b"2024-01-01 00:00\t1\n2024-01-01 00:05\t2\n").unwrap();
        assert_eq!(t.headers, ["Column 1", "Column 2"]);
        assert_eq!(t.rows(), 2);
        // Windows-1252 and duplicate titles.
        let t = read_text(b"Date,D\xe9bit,D\xe9bit\n2024-01-01,1,2\n").unwrap();
        assert_eq!(t.headers, ["Date", "Débit", "Débit (2)"]);
    }
}
