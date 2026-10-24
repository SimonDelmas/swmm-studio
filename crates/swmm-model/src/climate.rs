//! Climatology: `[EVAPORATION]`, `[TEMPERATURE]` (temperature, wind speed, snowmelt,
//! areal depletion) and `[ADJUSTMENTS]`, read into one structure and written back.
//!
//! Each line has a key (`MONTHLY`, `WINDSPEED`, `ADC IMPERVIOUS`…). Writing replaces the
//! lines of the keys this editor manages and leaves every other line (comments,
//! per-subcatchment adjustments of SWMM 5.2) as it is.

use serde::{Deserialize, Serialize};
use swmm_inp::{InpFile, Line, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::refs;
use crate::schema::{check_id, RefKind};

pub const EVAP_SOURCES: &[&str] = &["CONSTANT", "MONTHLY", "TIMESERIES", "TEMPERATURE", "FILE"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Climate {
    /// `[EVAPORATION]` source: one of [`EVAP_SOURCES`], or empty (no evaporation line).
    pub evap_source: String,
    /// CONSTANT: the rate; MONTHLY: 12 rates; TIMESERIES: the series; FILE: 12 pan
    /// coefficients (optional); TEMPERATURE: none.
    pub evap_values: Vec<String>,
    /// Soil recovery pattern (empty: none).
    pub evap_recovery: String,
    pub evap_dry_only: bool,
    /// `[TEMPERATURE]` source: `TIMESERIES`, `FILE` or empty.
    pub temp_source: String,
    pub temp_series: String,
    pub temp_file: String,
    /// Start date of the climate file (optional).
    pub temp_file_start: String,
    /// `MONTHLY`, `FILE` or empty.
    pub wind_source: String,
    pub wind_monthly: Vec<String>,
    /// Dividing temperature, ATI weight, negative melt ratio, elevation, latitude,
    /// longitude correction (empty: no line).
    pub snowmelt: Vec<String>,
    /// Areal depletion curves, 10 values each (empty: no line).
    pub adc_impervious: Vec<String>,
    pub adc_pervious: Vec<String>,
    /// `[ADJUSTMENTS]`, 12 monthly values each (empty: no line).
    pub adj_temperature: Vec<String>,
    pub adj_evaporation: Vec<String>,
    pub adj_rainfall: Vec<String>,
    pub adj_conductivity: Vec<String>,
}

/// Key of a line this editor manages (`None`: left alone).
fn line_key(kind: &SectionKind, l: &Line) -> Option<String> {
    let t0 = l.token(0)?.to_ascii_uppercase();
    let key = match kind {
        SectionKind::Evaporation if EVAP_SOURCES.contains(&t0.as_str()) => "SOURCE".to_string(),
        SectionKind::Evaporation if matches!(t0.as_str(), "RECOVERY" | "DRY_ONLY") => t0,
        SectionKind::Temperature if matches!(t0.as_str(), "TIMESERIES" | "FILE") => "SOURCE".to_string(),
        SectionKind::Temperature if matches!(t0.as_str(), "WINDSPEED" | "SNOWMELT") => t0,
        SectionKind::Temperature if t0 == "ADC" => format!("ADC {}", l.token(1)?.to_ascii_uppercase()),
        SectionKind::Adjustments
            if matches!(t0.as_str(), "TEMPERATURE" | "EVAPORATION" | "RAINFALL" | "CONDUCTIVITY") =>
        {
            t0
        }
        _ => return None,
    };
    Some(key)
}

fn tail(l: &Line, from: usize) -> Vec<String> {
    l.tokens().skip(from).map(str::to_string).collect()
}

impl Climate {
    pub fn read(inp: &InpFile) -> Climate {
        let mut c = Climate::default();
        for l in inp.rows(&SectionKind::Evaporation) {
            match line_key(&SectionKind::Evaporation, l).as_deref() {
                Some("SOURCE") => {
                    c.evap_source = l.token(0).unwrap_or("").to_ascii_uppercase();
                    c.evap_values = tail(l, 1);
                }
                Some("RECOVERY") => c.evap_recovery = l.token(1).unwrap_or("").to_string(),
                Some("DRY_ONLY") => c.evap_dry_only = l.token(1).is_some_and(|v| v.eq_ignore_ascii_case("YES")),
                _ => {}
            }
        }
        for l in inp.rows(&SectionKind::Temperature) {
            match line_key(&SectionKind::Temperature, l).as_deref() {
                Some("SOURCE") => {
                    c.temp_source = l.token(0).unwrap_or("").to_ascii_uppercase();
                    if c.temp_source == "TIMESERIES" {
                        c.temp_series = l.token(1).unwrap_or("").to_string();
                    } else {
                        c.temp_file = l.token(1).unwrap_or("").to_string();
                        c.temp_file_start = l.token(2).unwrap_or("").to_string();
                    }
                }
                Some("WINDSPEED") => {
                    c.wind_source = l.token(1).unwrap_or("").to_ascii_uppercase();
                    c.wind_monthly = if c.wind_source == "MONTHLY" { tail(l, 2) } else { Vec::new() };
                }
                Some("SNOWMELT") => c.snowmelt = tail(l, 1),
                Some("ADC IMPERVIOUS") => c.adc_impervious = tail(l, 2),
                Some("ADC PERVIOUS") => c.adc_pervious = tail(l, 2),
                _ => {}
            }
        }
        for l in inp.rows(&SectionKind::Adjustments) {
            let v = tail(l, 1);
            match line_key(&SectionKind::Adjustments, l).as_deref() {
                Some("TEMPERATURE") => c.adj_temperature = v,
                Some("EVAPORATION") => c.adj_evaporation = v,
                Some("RAINFALL") => c.adj_rainfall = v,
                Some("CONDUCTIVITY") => c.adj_conductivity = v,
                _ => {}
            }
        }
        c
    }

    fn check(&self, inp: &InpFile) -> EditResult<()> {
        let nums = |what: &str, v: &[String], n: Option<usize>| -> EditResult<()> {
            if let Some(n) = n {
                if v.len() != n {
                    return Err(format!("{what}: {n} values expected, {} given", v.len()));
                }
            }
            for (i, x) in v.iter().enumerate() {
                if !x.trim().parse::<f64>().is_ok_and(f64::is_finite) {
                    return Err(format!("{what}: value {} ({x:?}) is not a number", i + 1));
                }
            }
            Ok(())
        };
        let named = |what: &str, kind: RefKind, name: &str| -> EditResult<()> {
            check_id(name).map_err(|e| format!("{what}: {e}"))?;
            let known = refs::names(inp, kind).iter().any(|n| n.eq_ignore_ascii_case(name));
            if !known {
                return Err(format!(
                    "{what}: no {} named {name}",
                    if kind == RefKind::Pattern { "pattern" } else { "time series" }
                ));
            }
            Ok(())
        };
        match self.evap_source.as_str() {
            "" | "TEMPERATURE" => {}
            "CONSTANT" => nums("Evaporation rate", &self.evap_values, Some(1))?,
            "MONTHLY" => nums("Monthly evaporation", &self.evap_values, Some(12))?,
            "TIMESERIES" => {
                named("Evaporation time series", RefKind::Timeseries, self.evap_values.first().map_or("", |s| s))?
            }
            "FILE" => {
                if !self.evap_values.is_empty() {
                    nums("Pan coefficients", &self.evap_values, Some(12))?;
                }
            }
            s => return Err(format!("unknown evaporation source {s:?}")),
        }
        if !self.evap_recovery.is_empty() {
            named("Recovery pattern", RefKind::Pattern, &self.evap_recovery)?;
        }
        match self.temp_source.as_str() {
            "" => {}
            "TIMESERIES" => named("Temperature time series", RefKind::Timeseries, &self.temp_series)?,
            "FILE" => {
                if self.temp_file.trim().is_empty() {
                    return Err("give the climate file".into());
                }
                if !self.temp_file_start.is_empty() && swmm_inp::datetime::parse_date(&self.temp_file_start).is_none() {
                    return Err(format!("climate file start {:?} is not a date (MM/DD/YYYY)", self.temp_file_start));
                }
            }
            s => return Err(format!("unknown temperature source {s:?}")),
        }
        match self.wind_source.as_str() {
            "" | "FILE" => {}
            "MONTHLY" => nums("Monthly wind speed", &self.wind_monthly, Some(12))?,
            s => return Err(format!("unknown wind speed source {s:?}")),
        }
        for (what, v, n) in [
            ("Snowmelt parameters", &self.snowmelt, 6),
            ("Areal depletion (impervious)", &self.adc_impervious, 10),
            ("Areal depletion (pervious)", &self.adc_pervious, 10),
            ("Temperature adjustments", &self.adj_temperature, 12),
            ("Evaporation adjustments", &self.adj_evaporation, 12),
            ("Rainfall adjustments", &self.adj_rainfall, 12),
            ("Conductivity adjustments", &self.adj_conductivity, 12),
        ] {
            if !v.is_empty() {
                nums(what, v, Some(n))?;
            }
        }
        Ok(())
    }

    /// Lines of each section, by key.
    fn rows(&self) -> Vec<(SectionKind, &'static str, Option<Vec<String>>)> {
        let line = |head: &[&str], v: &[String]| -> Vec<String> {
            head.iter().map(|s| s.to_string()).chain(v.iter().map(|s| s.trim().to_string())).collect()
        };
        let opt = |head: &[&str], v: &[String]| (!v.is_empty()).then(|| line(head, v));
        let evap = (!self.evap_source.is_empty()).then(|| line(&[self.evap_source.as_str()], &self.evap_values));
        let temp = match self.temp_source.as_str() {
            "TIMESERIES" => Some(vec!["TIMESERIES".to_string(), self.temp_series.clone()]),
            "FILE" => {
                let mut v = vec!["FILE".to_string(), self.temp_file.trim().to_string()];
                if !self.temp_file_start.trim().is_empty() {
                    v.push(self.temp_file_start.trim().to_string());
                }
                Some(v)
            }
            _ => None,
        };
        let wind = match self.wind_source.as_str() {
            "MONTHLY" => Some(line(&["WINDSPEED", "MONTHLY"], &self.wind_monthly)),
            "FILE" => Some(vec!["WINDSPEED".to_string(), "FILE".to_string()]),
            _ => None,
        };
        use SectionKind as S;
        vec![
            (S::Evaporation, "SOURCE", evap),
            (
                S::Evaporation,
                "RECOVERY",
                (!self.evap_recovery.is_empty())
                    .then(|| line(&["RECOVERY"], std::slice::from_ref(&self.evap_recovery))),
            ),
            (S::Evaporation, "DRY_ONLY", self.evap_dry_only.then(|| line(&["DRY_ONLY", "YES"], &[]))),
            (S::Temperature, "SOURCE", temp),
            (S::Temperature, "WINDSPEED", wind),
            (S::Temperature, "SNOWMELT", opt(&["SNOWMELT"], &self.snowmelt)),
            (S::Temperature, "ADC IMPERVIOUS", opt(&["ADC", "IMPERVIOUS"], &self.adc_impervious)),
            (S::Temperature, "ADC PERVIOUS", opt(&["ADC", "PERVIOUS"], &self.adc_pervious)),
            (S::Adjustments, "TEMPERATURE", opt(&["TEMPERATURE"], &self.adj_temperature)),
            (S::Adjustments, "EVAPORATION", opt(&["EVAPORATION"], &self.adj_evaporation)),
            (S::Adjustments, "RAINFALL", opt(&["RAINFALL"], &self.adj_rainfall)),
            (S::Adjustments, "CONDUCTIVITY", opt(&["CONDUCTIVITY"], &self.adj_conductivity)),
        ]
    }

    /// Writes the climatology: changed lines are replaced in place, new ones appended,
    /// lines of keys left empty removed.
    pub fn write(&self, tx: &mut Tx) -> EditResult<()> {
        self.check(tx.inp())?;
        for (kind, key, row) in self.rows() {
            let at = tx.inp().sections().iter().enumerate().filter(|(_, s)| s.kind() == &kind).find_map(|(si, s)| {
                s.data().find(|(_, l)| line_key(&kind, l).as_deref() == Some(key)).map(|(li, _)| (si, li))
            });
            // An explicit `DRY_ONLY NO` stays.
            let row = match (key, &row, at) {
                ("DRY_ONLY", None, Some(_)) => Some(vec!["DRY_ONLY".to_string(), "NO".to_string()]),
                _ => row,
            };
            match (at, row) {
                (Some((s, i)), Some(row)) => {
                    let line = &tx.inp().sections()[s].lines()[i];
                    let same =
                        line.tokens().map(|t| t.to_ascii_uppercase()).eq(row.iter().map(|t| t.to_ascii_uppercase()));
                    if !same {
                        let mut l = line.clone();
                        l.set_tokens(&row);
                        tx.replace_line(s, i, l);
                    }
                }
                (None, Some(row)) => {
                    tx.append(&kind, &row);
                }
                (Some((s, i)), None) => tx.remove_line(s, i),
                (None, None) => {}
            }
            // Duplicate lines of the key (later ones) go away.
            loop {
                let dup =
                    tx.inp().sections().iter().enumerate().filter(|(_, s)| s.kind() == &kind).find_map(|(si, s)| {
                        s.data()
                            .filter(|(_, l)| line_key(&kind, l).as_deref() == Some(key))
                            .nth(1)
                            .map(|(li, _)| (si, li))
                    });
                match dup {
                    Some((s, i)) => tx.remove_line(s, i),
                    None => break,
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::History;

    const SRC: &str = "\
[EVAPORATION]
;;Data Source    Parameters
CONSTANT         0.0
DRY_ONLY         NO

[TEMPERATURE]
TIMESERIES T1
SNOWMELT 34 0.5 0.6 0 50 0

[ADJUSTMENTS]
N-PERV S1 P1

[TIMESERIES]
T1 0:00 10
E1 0:00 2
[PATTERNS]
REC MONTHLY 1 1 1 1 1 1 1 1 1 1 1 1
";

    #[test]
    fn read_and_write_back() {
        let mut inp = InpFile::parse_str(SRC);
        let c = Climate::read(&inp);
        assert_eq!(
            (c.evap_source.as_str(), c.evap_values.as_slice(), c.evap_dry_only),
            ("CONSTANT", &["0.0".to_string()][..], false)
        );
        assert_eq!((c.temp_source.as_str(), c.temp_series.as_str(), c.snowmelt.len()), ("TIMESERIES", "T1", 6));
        // Unchanged: nothing written.
        let mut h = History::default();
        let a = h.edit(&mut inp, "c", |tx| c.write(tx)).unwrap();
        assert!(a.changes.is_empty());
        let mut d = c.clone();
        d.evap_source = "MONTHLY".into();
        d.evap_values = (1..=12).map(|m| format!("{}", m as f64 / 10.0)).collect();
        d.evap_recovery = "REC".into();
        d.evap_dry_only = true;
        d.temp_source.clear();
        d.adj_rainfall = vec!["1.1".into(); 12];
        h.edit(&mut inp, "c", |tx| d.write(tx)).unwrap();
        assert_eq!(Climate::read(&inp), Climate { temp_series: String::new(), ..d.clone() });
        let text = inp.to_string_lossy();
        assert!(text.contains(";;Data Source"), "comments are kept");
        assert!(text.contains("N-PERV S1 P1"), "unknown keys are kept");
        assert!(!text.contains("TIMESERIES T1"));
        // Errors.
        let mut bad = d.clone();
        bad.evap_values.pop();
        assert!(h.edit(&mut inp, "c", |tx| bad.write(tx)).is_err());
        let mut bad = d.clone();
        bad.evap_recovery = "NOPE".into();
        assert!(h.edit(&mut inp, "c", |tx| bad.write(tx)).unwrap_err().contains("NOPE"));
        // Undo restores the source.
        h.undo(&mut inp).unwrap();
        assert_eq!(inp.to_string_lossy(), SRC);
    }
}
