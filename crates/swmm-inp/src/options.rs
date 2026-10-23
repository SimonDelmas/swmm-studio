//! Typed access to the `[OPTIONS]` section.

use chrono::{NaiveDateTime, TimeDelta};

use crate::datetime::{parse_datetime, parse_time};
use crate::{InpFile, SectionKind};

/// `FLOW_UNITS` option. The discriminant is the code SWMM writes in `.out` files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlowUnits {
    #[default]
    Cfs = 0,
    Gpm = 1,
    Mgd = 2,
    Cms = 3,
    Lps = 4,
    Mld = 5,
}

impl FlowUnits {
    pub fn from_name(s: &str) -> Option<FlowUnits> {
        Some(match s.to_ascii_uppercase().as_str() {
            "CFS" => FlowUnits::Cfs,
            "GPM" => FlowUnits::Gpm,
            "MGD" => FlowUnits::Mgd,
            "CMS" => FlowUnits::Cms,
            "LPS" => FlowUnits::Lps,
            "MLD" => FlowUnits::Mld,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"][self as usize]
    }

    /// SI units (CMS, LPS, MLD) vs US customary units.
    pub fn is_metric(self) -> bool {
        self as u8 >= 3
    }
}

/// Simulation and reporting time window from `[OPTIONS]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SimulationPeriod {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    pub report_start: NaiveDateTime,
    pub report_step: TimeDelta,
}

impl SimulationPeriod {
    pub fn duration(&self) -> TimeDelta {
        self.end - self.start
    }
}

impl InpFile {
    /// Value of an option (tokens after the key, joined by a space), case-insensitive key.
    pub fn option(&self, key: &str) -> Option<String> {
        self.rows(&SectionKind::Options)
            .filter(|l| l.token(0).is_some_and(|k| k.eq_ignore_ascii_case(key)))
            .last()
            .map(|l| l.tokens().skip(1).collect::<Vec<_>>().join(" "))
    }

    /// Sets an option, editing the existing line or appending a new one.
    pub fn set_option(&mut self, key: &str, value: &str) {
        let ending = self.line_ending();
        let section = self.section_or_insert(SectionKind::Options);
        match section.find(key) {
            Some(i) => {
                let line = section.line_mut(i).expect("index from find");
                if line.len() == 2 {
                    line.set_token(1, value);
                } else {
                    let k = line.token(0).unwrap_or(key).to_string();
                    line.set_tokens(&[k.as_str(), value]);
                }
            }
            None => {
                section.push_tokens(&[key, value], ending);
            }
        }
    }

    pub fn flow_units(&self) -> FlowUnits {
        self.option("FLOW_UNITS").and_then(|v| FlowUnits::from_name(&v)).unwrap_or_default()
    }

    /// Simulation period, or `None` if start/end dates are missing or invalid.
    pub fn simulation_period(&self) -> Option<SimulationPeriod> {
        let dt = |d: &str, t: &str| {
            let date = self.option(d)?;
            parse_datetime(&date, self.option(t).as_deref())
        };
        let start = dt("START_DATE", "START_TIME")?;
        let end = dt("END_DATE", "END_TIME")?;
        let report_start = dt("REPORT_START_DATE", "REPORT_START_TIME").unwrap_or(start);
        let report_step = self.option("REPORT_STEP").and_then(|s| parse_time(&s)).unwrap_or(TimeDelta::minutes(15));
        Some(SimulationPeriod { start, end, report_start, report_step })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    const SRC: &str = "[OPTIONS]\nFLOW_UNITS  LPS\nSTART_DATE 01/01/1998\nSTART_TIME 00:00:00\nEND_DATE 01/02/1998\nEND_TIME 12:00\nREPORT_STEP 00:05:00\n";

    #[test]
    fn reads_options() {
        let inp = InpFile::parse_str(SRC);
        assert_eq!(inp.flow_units(), FlowUnits::Lps);
        assert!(inp.flow_units().is_metric());
        assert_eq!(inp.option("flow_units").as_deref(), Some("LPS"));
        let p = inp.simulation_period().unwrap();
        assert_eq!(p.start, NaiveDate::from_ymd_opt(1998, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap());
        assert_eq!(p.duration(), TimeDelta::hours(36));
        assert_eq!(p.report_start, p.start);
        assert_eq!(p.report_step, TimeDelta::minutes(5));
    }

    #[test]
    fn sets_options() {
        let mut inp = InpFile::parse_str(SRC);
        inp.set_option("FLOW_UNITS", "CMS");
        inp.set_option("THREADS", "4");
        assert_eq!(inp.flow_units(), FlowUnits::Cms);
        assert_eq!(inp.option("THREADS").as_deref(), Some("4"));
        assert!(inp.to_string_lossy().starts_with("[OPTIONS]\nFLOW_UNITS  CMS\n"));
    }
}
