//! Observed data on a [`Session`]: files of measured series linked to objects in the
//! project, with the column of each variable, read once and kept while unchanged.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Serialize;
use swmm_model::ObjKind;
use swmm_obs::{DateOrder, Inspection, Series};
use swmm_out::ElementKind;

use crate::project::ObservedLink;
use crate::session::{err, Res, Session, VarInfo};

type Key = (PathBuf, Option<String>, String, DateOrder);

/// Series of the files read, with the time the file had then.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<Key, (Option<SystemTime>, Arc<Series>)>>);

impl Cache {
    fn get(&self, link: &ObservedLink) -> Res<Arc<Series>> {
        let key = (link.file.clone(), link.sheet.clone(), link.time_column.clone(), link.date_order);
        let mtime = std::fs::metadata(&link.file).and_then(|m| m.modified()).ok();
        if let Some((t, s)) = self.0.lock().map_err(|_| "internal error (lock)")?.get(&key) {
            if *t == mtime && mtime.is_some() {
                return Ok(s.clone());
            }
        }
        if !link.file.exists() {
            return Err(format!("observed data: {} not found", link.file.display()));
        }
        let s = Arc::new(
            swmm_obs::load(&link.file, link.sheet.as_deref(), &link.time_column, link.date_order).map_err(err)?,
        );
        self.0.lock().map_err(|_| "internal error (lock)")?.insert(key, (mtime, s.clone()));
        Ok(s)
    }
}

/// A file, to link it to an object: what it holds and the default mapping of its columns.
#[derive(Debug, Clone, Serialize)]
pub struct ObservedFile {
    pub path: PathBuf,
    #[serde(flatten)]
    pub inspection: Inspection,
    /// Columns of numbers, the series.
    pub series: Vec<String>,
    /// Variables of the object.
    pub variables: Vec<VarInfo>,
    /// Default column of each variable.
    pub mapping: BTreeMap<String, String>,
    /// Time range of the dates read with the time column and order asked (ms since 1970).
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Rows whose date could not be read.
    pub skipped: usize,
    /// Why the dates cannot be read.
    pub time_error: Option<String>,
}

/// Reads a file to link it to object `id` of kind `kind`, whose variables are `variables`:
/// its columns, the series with the dates of `time_column` (default: the one found) read
/// in `order`, and the default mapping.
pub fn inspect(
    path: &Path,
    sheet: Option<&str>,
    time_column: Option<&str>,
    order: DateOrder,
    kind: &str,
    id: &str,
    variables: Vec<VarInfo>,
) -> Res<ObservedFile> {
    let (table, sheets, format) = swmm_obs::read_table(path, sheet).map_err(err)?;
    let inspection = swmm_obs::inspect_table(&table, format, sheets, sheet);
    let time = time_column.map(str::to_string).or_else(|| inspection.time_column.clone());
    let (series, time_error) = match &time {
        Some(t) => match swmm_obs::series_of(&table, t, order) {
            Ok(s) => (Some(s), None),
            Err(e) => (None, Some(e.to_string())),
        },
        None => (None, Some(swmm_obs::Error::NoTime.to_string())),
    };
    let columns: Vec<String> = match &series {
        Some(s) => s.columns.clone(),
        None => inspection
            .columns
            .iter()
            .filter(|c| c.kind == swmm_obs::ColumnKind::Number && Some(&c.name) != time.as_ref())
            .map(|c| c.name.clone())
            .collect(),
    };
    let names: Vec<String> = variables.iter().map(|v| v.name.clone()).collect();
    let mapping = swmm_obs::mapping::suggest(kind, id, &names, &columns);
    Ok(ObservedFile {
        path: path.to_path_buf(),
        inspection: swmm_obs::Inspection { time_column: time, ..inspection },
        start_ms: series.as_ref().and_then(|s| s.times.first().copied()),
        end_ms: series.as_ref().and_then(|s| s.times.last().copied()),
        skipped: series.as_ref().map_or(0, |s| s.skipped),
        series: columns,
        variables,
        mapping,
        time_error,
    })
}

fn element(kind: &str) -> Res<(ObjKind, ElementKind)> {
    match kind {
        "node" => Ok((ObjKind::Node, ElementKind::Node)),
        "link" => Ok((ObjKind::Link, ElementKind::Link)),
        "subcatchment" => Ok((ObjKind::Subcatchment, ElementKind::Subcatchment)),
        _ => Err(format!("no observed data for objects of kind {kind:?}")),
    }
}

impl Session {
    /// Variables of objects of a kind: those of the loaded results (with pollutants), else
    /// the fixed ones of every `.out`.
    pub fn observed_variables(&self, kind: &str) -> Res<Vec<VarInfo>> {
        let (_, ek) = element(kind)?;
        Ok(match &self.results {
            Some(lr) => {
                let m = lr.results.meta();
                m.var_names(ek)
                    .into_iter()
                    .enumerate()
                    .map(|(v, name)| VarInfo { name, unit: m.unit(ek, v).to_string() })
                    .collect()
            }
            None => ek.base_variables().iter().map(|n| VarInfo { name: n.to_string(), unit: String::new() }).collect(),
        })
    }

    fn observed_link(&self, kind: &str, id: &str) -> Option<&ObservedLink> {
        self.project.observed.iter().find(|o| o.kind == kind && o.id == id)
    }

    /// Links a file to an object (`None`: removes the link) and saves the project. The file
    /// is read first: its dates and its mapped columns must be there.
    pub fn set_observed(&mut self, kind: &str, id: &str, link: Option<ObservedLink>) -> Res<()> {
        let (ok, _) = element(kind)?;
        if let Some(l) = &link {
            if self.net.find(ok, id).is_none() {
                return Err(format!("no {} {id}", ok.name()));
            }
            let s = self.observed_cache.get(l)?;
            if let Some(c) = l.columns.values().find(|c| s.column(c).is_none()) {
                return Err(format!("no column of numbers “{c}” in {}", l.file.display()));
            }
        }
        self.project.observed.retain(|o| !(o.kind == kind && o.id == id));
        if let Some(l) = link {
            self.project.observed.push(ObservedLink { kind: kind.to_string(), id: id.to_string(), ..l });
        }
        self.save_project()
    }

    /// Observed values of variable `var` of an object between `t0` and `t1` (ms), about
    /// a minimum and a maximum per bucket when there are many: `[n: u32][0: u32]`, `n` times
    /// (ms, `f64`), `n` values (`f32`).
    pub fn observed_series(&self, kind: &str, id: &str, var: &str, t0: i64, t1: i64, buckets: usize) -> Res<Vec<u8>> {
        let link = self.observed_link(kind, id).ok_or_else(|| format!("no observed data for {id}"))?;
        let col = link.columns.get(var).ok_or_else(|| format!("no observed {var} for {id}"))?;
        let s = self.observed_cache.get(link)?;
        let ci = s
            .columns
            .iter()
            .position(|c| c == col)
            .ok_or_else(|| format!("observed data of {id}: no column “{col}”"))?;
        let (ts, vs) = s.window(ci, t0, t1, buckets);
        let mut out = Vec::with_capacity(8 + 12 * ts.len());
        out.extend((ts.len() as u32).to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(ts.iter().flat_map(|&t| (t as f64).to_le_bytes()));
        out.extend(vs.iter().flat_map(|&v| (v as f32).to_le_bytes()));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_and_read() {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("tiny.inp");
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/tiny.inp"), &inp).unwrap();
        let mut s = Session::open(&inp).unwrap();
        let link_id = s.ids(ObjKind::Link)[0].to_string();
        let csv = dir.path().join("obs.csv");
        std::fs::write(
            &csv,
            format!("Date;{link_id} Q;{link_id} H;Other\n01/01/2020 00:00;1;0,1;5\n01/01/2020 00:10;3;0,2;5\n"),
        )
        .unwrap();

        let vars = s.observed_variables("link").unwrap();
        let f = inspect(&csv, None, None, DateOrder::Auto, "link", &link_id, vars).unwrap();
        assert_eq!(f.inspection.time_column.as_deref(), Some("Date"));
        assert_eq!(f.series, [format!("{link_id} Q"), format!("{link_id} H"), "Other".into()]);
        assert_eq!(f.mapping.get("flow"), Some(&format!("{link_id} Q")));
        assert_eq!(f.mapping.get("depth"), Some(&format!("{link_id} H")));
        assert_eq!(f.end_ms.unwrap() - f.start_ms.unwrap(), 600_000);

        let link = ObservedLink {
            kind: "link".into(),
            id: link_id.clone(),
            file: csv.clone(),
            sheet: None,
            time_column: "Date".into(),
            date_order: DateOrder::Auto,
            columns: f.mapping.clone(),
        };
        assert!(s.set_observed("link", "nope", Some(link.clone())).is_err());
        let bad = ObservedLink { columns: [("flow".to_string(), "Missing".to_string())].into(), ..link.clone() };
        assert!(s.set_observed("link", &link_id, Some(bad)).is_err());
        s.set_observed("link", &link_id, Some(link)).unwrap();

        let buf = s.observed_series("link", &link_id, "flow", 0, i64::MAX, 100).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
        assert_eq!(f32::from_le_bytes(buf[8 + 16 + 4..8 + 16 + 8].try_into().unwrap()), 3.0);
        assert!(s.observed_series("link", &link_id, "velocity", 0, i64::MAX, 100).is_err());

        // Kept in the project, relative to it, and found again on opening.
        let text = std::fs::read_to_string(inp.with_extension("swproj")).unwrap();
        assert!(text.contains("\"file\": \"obs.csv\""), "{text}");
        let s = Session::open(&inp).unwrap();
        assert_eq!(s.project.observed.len(), 1);
        assert!(s.observed_series("link", &link_id, "depth", 0, i64::MAX, 100).is_ok());
        let mut s = s;
        s.set_observed("link", &link_id, None).unwrap();
        assert!(s.project.observed.is_empty());
    }
}
