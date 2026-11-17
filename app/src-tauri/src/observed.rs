//! Observed data on a [`Session`]: files of measured series linked to objects in the
//! project, with the column of each variable, read once and kept while unchanged.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Serialize;
use swmm_model::ObjKind;
use swmm_obs::{DateOrder, Inspection, Series};
use swmm_out::{ElementKind, FlowUnits};

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
    /// Units each variable's series can be in (the model's unit first; none: no conversion).
    pub unit_options: BTreeMap<String, Vec<String>>,
    /// Unit written in the title of a column, when there is one.
    pub column_units: BTreeMap<String, String>,
    /// Default unit of the series of each mapped variable (from its column's title).
    pub units: BTreeMap<String, String>,
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
    let unit_options: BTreeMap<String, Vec<String>> = variables
        .iter()
        .map(|v| (v.name.clone(), swmm_obs::units::options(&v.unit).into_iter().map(str::to_string).collect()))
        .collect();
    let column_units: BTreeMap<String, String> =
        columns.iter().filter_map(|c| Some((c.clone(), swmm_obs::units::from_title(c)?.to_string()))).collect();
    let units = default_units(&mapping, &column_units, &unit_options);
    Ok(ObservedFile {
        path: path.to_path_buf(),
        inspection: swmm_obs::Inspection { time_column: time, ..inspection },
        start_ms: series.as_ref().and_then(|s| s.times.first().copied()),
        end_ms: series.as_ref().and_then(|s| s.times.last().copied()),
        skipped: series.as_ref().map_or(0, |s| s.skipped),
        series: columns,
        variables,
        mapping,
        unit_options,
        column_units,
        units,
        time_error,
    })
}

/// Unit of each mapped variable read from its column's title, when the variable can be in it
/// (none: the model's unit).
fn default_units(
    mapping: &BTreeMap<String, String>,
    column_units: &BTreeMap<String, String>,
    options: &BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, String> {
    mapping
        .iter()
        .filter_map(|(v, c)| {
            let u = column_units.get(c)?;
            let own = options.get(v)?;
            (own.contains(u) && own.first() != Some(u)).then(|| (v.clone(), u.clone()))
        })
        .collect()
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
            None => {
                // Units of the model's flow units, as the results will have them.
                let flow = ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"]
                    .iter()
                    .position(|n| *n == self.inp.flow_units().name())
                    .and_then(|i| FlowUnits::from_code(i as i32))
                    .unwrap_or(FlowUnits::Cms);
                ek.base_variables()
                    .iter()
                    .enumerate()
                    .map(|(v, n)| VarInfo {
                        name: n.to_string(),
                        unit: swmm_out::format::unit(ek, v, flow).to_string(),
                    })
                    .collect()
            }
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
            let vars = self.observed_variables(kind)?;
            for (v, u) in &l.units {
                let model = vars.iter().find(|x| &x.name == v).map_or("", |x| x.unit.as_str());
                if swmm_obs::units::factor(u, model).is_none() {
                    return Err(format!("{v}: {u} cannot be converted to {model}"));
                }
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
        // In the units of the results.
        let factor = match link.units.get(var) {
            Some(u) => {
                let vars = self.observed_variables(kind)?;
                let model = vars.iter().find(|x| x.name == var).map_or("", |x| x.unit.as_str());
                swmm_obs::units::factor(u, model)
                    .ok_or_else(|| format!("observed {var} of {id}: {u} cannot be converted to {model}"))?
            }
            None => 1.0,
        };
        let mut out = Vec::with_capacity(8 + 12 * ts.len());
        out.extend((ts.len() as u32).to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(ts.iter().flat_map(|&t| (t as f64).to_le_bytes()));
        out.extend(vs.iter().flat_map(|&v| ((v * factor) as f32).to_le_bytes()));
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
            format!(
                "Date;{link_id} Q (m3/s);{link_id} H [cm];Other\n01/01/2020 00:00;1;0,1;5\n01/01/2020 00:10;3;0,2;5\n"
            ),
        )
        .unwrap();

        let vars = s.observed_variables("link").unwrap();
        let f = inspect(&csv, None, None, DateOrder::Auto, "link", &link_id, vars).unwrap();
        assert_eq!(f.inspection.time_column.as_deref(), Some("Date"));
        let (q, h) = (format!("{link_id} Q (m3/s)"), format!("{link_id} H [cm]"));
        assert_eq!(f.series, [q.clone(), h.clone(), "Other".into()]);
        assert_eq!(f.mapping.get("flow"), Some(&q));
        assert_eq!(f.mapping.get("depth"), Some(&h));
        // Without results, the units of the model (LPS); those of the titles are proposed.
        assert_eq!(f.unit_options["flow"][0], "LPS");
        assert_eq!(f.unit_options["depth"][0], "m");
        assert_eq!(f.units, [("depth".to_string(), "cm".to_string()), ("flow".to_string(), "CMS".to_string())].into());
        assert_eq!(f.end_ms.unwrap() - f.start_ms.unwrap(), 600_000);

        let link = ObservedLink {
            kind: "link".into(),
            id: link_id.clone(),
            file: csv.clone(),
            sheet: None,
            time_column: "Date".into(),
            date_order: DateOrder::Auto,
            columns: f.mapping.clone(),
            units: f.units.clone(),
        };
        assert!(s.set_observed("link", "nope", Some(link.clone())).is_err());
        let bad = ObservedLink { columns: [("flow".to_string(), "Missing".to_string())].into(), ..link.clone() };
        assert!(s.set_observed("link", &link_id, Some(bad)).is_err());
        let bad = ObservedLink { units: [("flow".to_string(), "m".to_string())].into(), ..link.clone() };
        assert!(s.set_observed("link", &link_id, Some(bad)).is_err());
        s.set_observed("link", &link_id, Some(link)).unwrap();

        let buf = s.observed_series("link", &link_id, "flow", 0, i64::MAX, 100).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
        assert_eq!(f32::from_le_bytes(buf[8 + 16 + 4..8 + 16 + 8].try_into().unwrap()), 3000.0, "m3/s to LPS");
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
