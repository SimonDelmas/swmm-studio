//! Periods grouped by calendar day, month or year, in the model clock.
//!
//! SWMM reports the state at the end of each reporting step: period `p` stands for the
//! interval `(time(p) - step, time(p)]`, so the value stamped at midnight belongs to the
//! day that ends then.

use std::ops::Range;

use chrono::{Datelike, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use swmm_out::OutMeta;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Calendar {
    Day,
    Month,
    Year,
}

/// Periods whose time falls in one calendar interval.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bucket {
    /// Start of the interval (midnight, first of the month or of the year).
    pub start: NaiveDateTime,
    /// Start of the next interval.
    pub end: NaiveDateTime,
    pub periods: Range<usize>,
}

fn floor(t: NaiveDateTime, unit: Calendar) -> NaiveDate {
    let d = t.date();
    match unit {
        Calendar::Day => d,
        Calendar::Month => d.with_day(1).unwrap(),
        Calendar::Year => NaiveDate::from_ymd_opt(d.year(), 1, 1).unwrap(),
    }
}

fn next(d: NaiveDate, unit: Calendar) -> NaiveDate {
    match unit {
        Calendar::Day => d.succ_opt().unwrap(),
        Calendar::Month => d.checked_add_months(chrono::Months::new(1)).unwrap(),
        Calendar::Year => NaiveDate::from_ymd_opt(d.year() + 1, 1, 1).unwrap(),
    }
}

/// Start of the interval of period `p`.
pub fn interval_start(meta: &OutMeta, p: usize) -> NaiveDateTime {
    meta.time(p) - chrono::TimeDelta::seconds(meta.report_step_secs as i64)
}

/// First period whose interval starts at or after `t`.
fn first_at(meta: &OutMeta, t: NaiveDateTime) -> usize {
    let step = meta.report_step_secs.max(1) as i64;
    let secs = (t - interval_start(meta, 0)).num_seconds();
    if secs <= 0 {
        0
    } else {
        (secs.div_euclid(step) + (secs.rem_euclid(step) > 0) as i64) as usize
    }
}

/// The calendar intervals covering the run (each with at least one period).
pub fn buckets(meta: &OutMeta, unit: Calendar) -> Vec<Bucket> {
    let n = meta.n_periods;
    let mut out = Vec::new();
    if n == 0 {
        return out;
    }
    let mut d = floor(interval_start(meta, 0), unit);
    let mut p = 0;
    while p < n {
        let e = next(d, unit);
        let end = first_at(meta, e.and_hms_opt(0, 0, 0).unwrap()).min(n);
        if end > p {
            out.push(Bucket {
                start: d.and_hms_opt(0, 0, 0).unwrap(),
                end: e.and_hms_opt(0, 0, 0).unwrap(),
                periods: p..end,
            });
        }
        p = end.max(p);
        d = e;
    }
    out
}

/// The interval containing period `p`.
pub fn bucket_of(meta: &OutMeta, unit: Calendar, p: usize) -> Bucket {
    let d = floor(interval_start(meta, p.min(meta.n_periods.saturating_sub(1))), unit);
    let a = first_at(meta, d.and_hms_opt(0, 0, 0).unwrap());
    let b = first_at(meta, next(d, unit).and_hms_opt(0, 0, 0).unwrap()).min(meta.n_periods);
    let end = next(d, unit).and_hms_opt(0, 0, 0).unwrap();
    Bucket { start: d.and_hms_opt(0, 0, 0).unwrap(), end, periods: a..b.max(a) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn days_months_years() {
        let dir = tempfile::tempdir().unwrap();
        // Hourly, ending at 2024-01-01 01:00 … 2024-03-01 00:00 (60 days).
        let path = testutil::results(dir.path(), 24 * 60, 3600, |_, _| 0.0);
        let r = testutil::open(&path, None);
        let m = r.meta();
        let days = buckets(m, Calendar::Day);
        assert_eq!(days.len(), 60);
        assert_eq!(days[0].periods, 0..24);
        assert_eq!(days[1].start.to_string(), "2024-01-02 00:00:00");
        let months = buckets(m, Calendar::Month);
        assert_eq!(months.iter().map(|b| b.periods.len()).collect::<Vec<_>>(), [31 * 24, 29 * 24]);
        assert_eq!(buckets(m, Calendar::Year).len(), 1);
        let b = bucket_of(m, Calendar::Month, 31 * 24 + 5);
        assert_eq!((b.start.to_string().as_str(), b.periods), ("2024-02-01 00:00:00", 744..1440));
    }
}
