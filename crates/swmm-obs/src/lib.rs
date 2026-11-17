//! Observed time series, read from tabular files to compare them with SWMM results.
//!
//! A file holds a column of dates and times and one or more columns of values: CSV or other
//! delimited text (`,` `;` tab `|`, decimal comma, UTF-8 or Windows-1252), Excel and
//! OpenDocument workbooks (`xlsx`, `xlsm`, `xlsb`, `xls`, `ods`), Parquet.
//!
//! - [`inspect`]: the columns of a file, the one with the dates, a preview;
//! - [`load`]: the series of a file, sorted by time;
//! - [`mapping::suggest`]: the default mapping of its columns to the variables of an object.
//! - [`units`]: the units of its columns, converted to the units of the results.

pub mod mapping;
mod read;
pub mod time;
pub mod units;

use std::path::Path;

use serde::Serialize;

pub use read::{format_of, read as read_table, Cell, Format, Table};
pub use time::DateOrder;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported file type “.{0}” (CSV, TXT, TSV, XLSX, XLS, XLSB, ODS or Parquet)")]
    Format(String),
    #[error("cannot read the file: {0}")]
    Read(String),
    #[error("no sheet “{0}” in the workbook")]
    Sheet(String),
    #[error("the file has no data")]
    Empty,
    #[error("no column “{0}” in the file")]
    Column(String),
    #[error("no column of dates and times in the file")]
    NoTime,
    #[error("column “{0}” has no date and time that can be read")]
    BadTime(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    /// Dates and times.
    Time,
    /// Numbers (and missing values).
    Number,
    Text,
    Empty,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub kind: ColumnKind,
    /// Cells with a value.
    pub values: usize,
}

/// Share of the non-empty cells of a column that must be dates (or numbers) for the
/// column to be one of dates (or numbers): a few notes or errors are allowed.
const SHARE: f64 = 0.9;

/// Kind of a column, its cells with a value and how many of them are dates.
fn column_kind(cells: &[Cell]) -> (ColumnKind, usize, usize) {
    let (mut n, mut times, mut numbers) = (0, 0, 0);
    for c in cells {
        match c {
            Cell::Empty => continue,
            Cell::Number(_) => numbers += 1,
            Cell::Time(_) => times += 1,
            Cell::Text(s) => times += usize::from(time::parse(s, DateOrder::Auto).is_some()),
        }
        n += 1;
    }
    let kind = if n == 0 {
        ColumnKind::Empty
    } else if times as f64 >= SHARE * n as f64 {
        ColumnKind::Time
    } else if numbers as f64 >= SHARE * n as f64 {
        ColumnKind::Number
    } else {
        ColumnKind::Text
    };
    (kind, n, times)
}

/// What a file holds, to choose its columns.
#[derive(Debug, Clone, Serialize)]
pub struct Inspection {
    pub format: Format,
    /// Sheets of a workbook (empty for other files).
    pub sheets: Vec<String>,
    /// The sheet read.
    pub sheet: Option<String>,
    pub columns: Vec<ColumnInfo>,
    /// The column of dates (the first one whose title names a date or a time, else the
    /// first column of dates).
    pub time_column: Option<String>,
    /// Order of day and month found in the dates, and whether the values leave it open.
    pub date_order: DateOrder,
    pub date_order_ambiguous: bool,
    pub rows: usize,
    /// The first rows, as text.
    pub preview: Vec<Vec<String>>,
}

const PREVIEW_ROWS: usize = 8;

/// The columns of a file (`sheet`: the sheet of a workbook, default the first one).
pub fn inspect(path: &Path, sheet: Option<&str>) -> Result<Inspection, Error> {
    let (table, sheets, format) = read::read(path, sheet)?;
    Ok(inspect_table(&table, format, sheets, sheet))
}

/// [`inspect`] of a table already read.
pub fn inspect_table(table: &Table, format: Format, sheets: Vec<String>, sheet: Option<&str>) -> Inspection {
    let mut dates = Vec::new();
    let columns: Vec<ColumnInfo> = table
        .headers
        .iter()
        .zip(&table.columns)
        .map(|(name, cells)| {
            let (kind, values, times) = column_kind(cells);
            dates.push(times);
            ColumnInfo { name: name.clone(), kind, values }
        })
        .collect();
    let times = columns.iter().filter(|c| c.kind == ColumnKind::Time);
    // Else a column named so with mostly dates (a few rows of notes or errors).
    let named =
        columns.iter().zip(&dates).find(|(c, &d)| time::is_time_name(&c.name) && 2 * d > c.values).map(|(c, _)| c);
    let time_column =
        times.clone().find(|c| time::is_time_name(&c.name)).or(times.clone().next()).or(named).map(|c| c.name.clone());
    let (date_order, date_order_ambiguous) = match &time_column {
        Some(name) => order_of(table, name),
        None => (DateOrder::Dmy, false),
    };
    let preview =
        (0..table.rows().min(PREVIEW_ROWS)).map(|r| table.columns.iter().map(|c| c[r].text()).collect()).collect();
    Inspection {
        format,
        sheet: if format == Format::Workbook {
            sheet.map(str::to_string).or_else(|| sheets.first().cloned())
        } else {
            None
        },
        sheets,
        columns,
        time_column,
        date_order,
        date_order_ambiguous,
        rows: table.rows(),
        preview,
    }
}

/// Order of day and month of the dates written as text in a column (none: not ambiguous).
fn order_of(table: &Table, column: &str) -> (DateOrder, bool) {
    let Some(i) = table.headers.iter().position(|h| h == column) else { return (DateOrder::Dmy, false) };
    time::detect_order(
        table.columns[i].iter().filter_map(|c| if let Cell::Text(s) = c { Some(s.as_str()) } else { None }),
    )
}

/// The series of a file: times in milliseconds since 1970 (the dates as written, read as
/// UTC like the model's clock), sorted, and the values of each column (NaN: missing).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Series {
    pub columns: Vec<String>,
    pub times: Vec<i64>,
    pub values: Vec<Vec<f64>>,
    /// Rows left out because their date could not be read.
    pub skipped: usize,
}

impl Series {
    pub fn column(&self, name: &str) -> Option<&[f64]> {
        self.columns.iter().position(|c| c == name).map(|i| self.values[i].as_slice())
    }

    /// Values of column `col` with their times in `[t0, t1]` (ms), missing ones left out;
    /// when there are more than `2 × buckets`, the minimum and maximum of each of `buckets`
    /// equal time intervals, at their own times.
    pub fn window(&self, col: usize, t0: i64, t1: i64, buckets: usize) -> (Vec<i64>, Vec<f64>) {
        let a = self.times.partition_point(|&t| t < t0);
        let b = self.times.partition_point(|&t| t <= t1);
        let v = &self.values[col];
        let points: Vec<(i64, f64)> = (a..b).filter(|&i| !v[i].is_nan()).map(|i| (self.times[i], v[i])).collect();
        let buckets = buckets.max(1);
        if points.len() <= 2 * buckets || t1 <= t0 {
            return points.into_iter().unzip();
        }
        let width = (t1 - t0) as f64 / buckets as f64;
        let (mut ts, mut vs) = (Vec::with_capacity(2 * buckets), Vec::with_capacity(2 * buckets));
        // The last point (at `t1`) is in the last bucket.
        let bucket = |t: i64| (((t - t0) as f64 / width) as usize).min(buckets - 1);
        let mut i = 0;
        while i < points.len() {
            let k = bucket(points[i].0);
            let mut j = i;
            let (mut lo, mut hi) = (i, i);
            while j < points.len() && bucket(points[j].0) == k {
                if points[j].1 < points[lo].1 {
                    lo = j;
                }
                if points[j].1 > points[hi].1 {
                    hi = j;
                }
                j += 1;
            }
            for p in if lo <= hi { [lo, hi] } else { [hi, lo] } {
                if ts.last() != Some(&points[p].0) {
                    ts.push(points[p].0);
                    vs.push(points[p].1);
                }
            }
            i = j;
        }
        (ts, vs)
    }
}

/// Reads the series of a file: dates from column `time_column` (with `order` for the dates
/// that do not start with the year), values from every column of numbers.
pub fn load(path: &Path, sheet: Option<&str>, time_column: &str, order: DateOrder) -> Result<Series, Error> {
    let (table, _, _) = read::read(path, sheet)?;
    series_of(&table, time_column, order)
}

/// [`load`] from a table already read.
pub fn series_of(table: &Table, time_column: &str, order: DateOrder) -> Result<Series, Error> {
    let ti = table.headers.iter().position(|h| h == time_column).ok_or_else(|| Error::Column(time_column.into()))?;
    let order = match order {
        DateOrder::Auto => order_of(table, time_column).0,
        o => o,
    };
    let value_cols: Vec<usize> = (0..table.headers.len())
        .filter(|&i| i != ti && column_kind(&table.columns[i]).0 == ColumnKind::Number)
        .collect();
    let mut rows: Vec<(i64, usize)> = Vec::with_capacity(table.rows());
    let mut skipped = 0;
    for (r, c) in table.columns[ti].iter().enumerate() {
        let t = match c {
            Cell::Time(t) => Some(*t),
            Cell::Text(s) => time::parse(s, order),
            Cell::Empty => continue,
            Cell::Number(_) => None,
        };
        match t {
            Some(t) => rows.push((t.and_utc().timestamp_millis(), r)),
            None => skipped += 1,
        }
    }
    if rows.is_empty() {
        return Err(Error::BadTime(time_column.into()));
    }
    // Stable: rows with the same time keep the file's order.
    rows.sort_by_key(|&(t, _)| t);
    let value = |c: &Cell| if let Cell::Number(v) = c { *v } else { f64::NAN };
    Ok(Series {
        columns: value_cols.iter().map(|&i| table.headers[i].clone()).collect(),
        times: rows.iter().map(|&(t, _)| t).collect(),
        values: value_cols.iter().map(|&i| rows.iter().map(|&(_, r)| value(&table.columns[i][r])).collect()).collect(),
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn t(s: &str) -> i64 {
        time::parse(s, DateOrder::Dmy).unwrap().and_utc().timestamp_millis()
    }

    #[test]
    fn inspect_and_load_text() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("obs.csv");
        std::fs::write(&p, "Station;Date;Q (l/s);Note\nA;13/01/2024 00:05;2;ok\nA;13/01/2024 00:00;1,5;\nA;bad;3;x\n")
            .unwrap();
        let i = inspect(&p, None).unwrap();
        assert_eq!(i.format, Format::Text);
        assert_eq!(i.time_column.as_deref(), Some("Date"));
        assert_eq!((i.date_order, i.date_order_ambiguous), (DateOrder::Dmy, false));
        let kinds: Vec<ColumnKind> = i.columns.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, [ColumnKind::Text, ColumnKind::Text, ColumnKind::Number, ColumnKind::Text]);
        assert_eq!(i.rows, 3);
        assert_eq!(i.preview[0], ["A", "13/01/2024 00:05", "2", "ok"]);
        // 2 of 3 dates: a column of text, taken for its title; the third row is left out.
        let s = load(&p, None, "Date", DateOrder::Auto).unwrap();
        assert_eq!(s.columns, ["Q (l/s)"]);
        assert_eq!(s.times, [t("13/01/2024 00:00"), t("13/01/2024 00:05")]);
        assert_eq!(s.values[0], [1.5, 2.0]);
        assert_eq!(s.skipped, 1);
        assert!(matches!(load(&p, None, "Station", DateOrder::Auto), Err(Error::BadTime(_))));
        assert!(matches!(load(&p, None, "Nope", DateOrder::Auto), Err(Error::Column(_))));
    }

    #[test]
    fn ambiguous_dates() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("obs.txt");
        std::fs::write(&p, "time\tflow\n01/02/2024 00:00\t1\n01/03/2024 00:00\t2\n").unwrap();
        let i = inspect(&p, None).unwrap();
        assert_eq!((i.date_order, i.date_order_ambiguous), (DateOrder::Dmy, true));
        let s = load(&p, None, "time", DateOrder::Mdy).unwrap();
        assert_eq!(s.times[1] - s.times[0], 24 * 60 * MIN);
        // Day first by default: 1 February to 1 March 2024.
        let s = load(&p, None, "time", DateOrder::Auto).unwrap();
        assert_eq!(s.times[1] - s.times[0], 29 * 24 * 60 * MIN);
    }

    #[test]
    fn window_and_decimation() {
        let n = 1000;
        let s = Series {
            columns: vec!["v".into()],
            times: (0..n).map(|i| i * MIN).collect(),
            values: vec![(0..n).map(|i| if i == 500 { f64::NAN } else { (i % 10) as f64 }).collect()],
            skipped: 0,
        };
        let (ts, vs) = s.window(0, 10 * MIN, 19 * MIN, 100);
        assert_eq!(ts.len(), 10);
        assert_eq!(vs[0], 0.0);
        let (ts, _) = s.window(0, 495 * MIN, 505 * MIN, 100);
        assert_eq!(ts.len(), 10, "missing value left out");
        let (ts, vs) = s.window(0, 0, (n - 1) * MIN, 10);
        assert!(ts.len() <= 20 && ts.len() >= 10, "{}", ts.len());
        assert!(ts.windows(2).all(|w| w[0] < w[1]));
        assert!(vs.contains(&9.0) && vs.contains(&0.0));
    }
}

#[cfg(test)]
mod file_tests {
    use std::sync::Arc;

    use chrono::NaiveDate;
    use parquet::data_type::{DoubleType, Int64Type};
    use parquet::file::writer::SerializedFileWriter;
    use parquet::schema::parser::parse_message_type;

    use super::*;

    fn ms(d: u32, h: u32) -> i64 {
        NaiveDate::from_ymd_opt(2024, 3, d).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc().timestamp_millis()
    }

    #[test]
    fn workbook() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("obs.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        wb.add_worksheet().set_name("Notes").unwrap().write_string(0, 0, "nothing here").unwrap();
        let ws = wb.add_worksheet().set_name("Mesures").unwrap();
        let fmt = rust_xlsxwriter::Format::new().set_num_format("dd/mm/yyyy hh:mm");
        ws.write_string(0, 0, "Horodatage").unwrap();
        ws.write_string(0, 1, "C1 débit").unwrap();
        ws.write_string(0, 2, "C1 hauteur").unwrap();
        for (r, (d, h, q)) in [(2, 0, 1.0), (1, 12, 0.5), (2, 1, 2.0)].iter().enumerate() {
            let r = r as u32 + 1;
            let t =
                rust_xlsxwriter::ExcelDateTime::from_ymd(2024, 3, *d as u8).unwrap().and_hms(*h as u16, 0, 0).unwrap();
            ws.write_datetime_with_format(r, 0, &t, &fmt).unwrap();
            ws.write_number(r, 1, *q).unwrap();
            if r != 2 {
                ws.write_number(r, 2, q / 10.0).unwrap();
            }
        }
        wb.save(&p).unwrap();

        let i = inspect(&p, None).unwrap();
        assert_eq!(i.format, Format::Workbook);
        assert_eq!(i.sheets, ["Notes", "Mesures"]);
        assert_eq!(i.sheet.as_deref(), Some("Notes"));
        assert_eq!(i.time_column, None);
        let i = inspect(&p, Some("Mesures")).unwrap();
        assert_eq!(i.time_column.as_deref(), Some("Horodatage"));
        assert_eq!(i.columns[1].kind, ColumnKind::Number);
        assert!(matches!(inspect(&p, Some("Autre")), Err(Error::Sheet(_))));
        let s = load(&p, Some("Mesures"), "Horodatage", DateOrder::Auto).unwrap();
        assert_eq!(s.times, [ms(1, 12), ms(2, 0), ms(2, 1)]);
        assert_eq!(s.column("C1 débit").unwrap(), [0.5, 1.0, 2.0]);
        assert!(s.column("C1 hauteur").unwrap()[0].is_nan());
    }

    #[test]
    fn parquet_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("obs.parquet");
        let schema = Arc::new(
            parse_message_type("message s { REQUIRED INT64 ts (TIMESTAMP(MILLIS,false)); REQUIRED DOUBLE flow; }")
                .unwrap(),
        );
        let mut w = SerializedFileWriter::new(std::fs::File::create(&p).unwrap(), schema, Default::default()).unwrap();
        let mut rg = w.next_row_group().unwrap();
        let mut c = rg.next_column().unwrap().unwrap();
        c.typed::<Int64Type>().write_batch(&[ms(1, 0), ms(1, 1)], None, None).unwrap();
        c.close().unwrap();
        let mut c = rg.next_column().unwrap().unwrap();
        c.typed::<DoubleType>().write_batch(&[0.25, 0.5], None, None).unwrap();
        c.close().unwrap();
        rg.close().unwrap();
        w.close().unwrap();

        let i = inspect(&p, None).unwrap();
        assert_eq!(i.format, Format::Parquet);
        assert_eq!(i.time_column.as_deref(), Some("ts"));
        let s = load(&p, None, "ts", DateOrder::Auto).unwrap();
        assert_eq!(s.times, [ms(1, 0), ms(1, 1)]);
        assert_eq!(s.column("flow").unwrap(), [0.25, 0.5]);
    }
}
