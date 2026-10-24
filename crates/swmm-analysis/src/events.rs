//! Event detection for long-term statistics (overflow frequency of CSOs, flooding of
//! nodes…).
//!
//! An event starts when the value rises above the threshold and ends at the last value
//! above it; two events closer than the minimum inter-event time are one event. With
//! the results cache, chunks that stay below the threshold are skipped without
//! decompression, so a multi-year run of mostly dry weather is scanned quickly.

use std::ops::Range;

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use swmm_out::{ElementKind, OutError, OutMeta, Results};

use crate::reduce::integral;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EventParams {
    /// Values strictly above it are "in an event".
    pub threshold: f32,
    /// Minimum number of periods below the threshold between two events.
    pub min_gap: usize,
}

/// One event (periods are indices of the results file).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Event {
    pub start: usize,
    /// One past the last period above the threshold.
    pub end: usize,
    pub peak: f32,
    pub peak_period: usize,
    /// Sum of the values from start to end (including short dips below the threshold).
    pub sum: f64,
}

impl Event {
    pub fn periods(&self) -> usize {
        self.end - self.start
    }
}

struct Detector {
    params: EventParams,
    events: Vec<Event>,
    open: Option<Event>,
    /// Sum of the values since the last one above the threshold (added to the event if
    /// it goes on).
    pending: f64,
}

impl Detector {
    fn push(&mut self, p: usize, v: f32) {
        if v > self.params.threshold {
            match &mut self.open {
                Some(e) if p - e.end < self.params.min_gap => {
                    e.sum += self.pending + v as f64;
                    e.end = p + 1;
                    if v > e.peak {
                        e.peak = v;
                        e.peak_period = p;
                    }
                }
                _ => {
                    self.events.extend(self.open.take());
                    self.open = Some(Event { start: p, end: p + 1, peak: v, peak_period: p, sum: v as f64 });
                }
            }
            self.pending = 0.0;
        } else if self.open.is_some() && !v.is_nan() {
            self.pending += v as f64;
        }
    }

    /// Periods known to be below the threshold, with the sum of their values.
    fn skip(&mut self, sum: f64) {
        if self.open.is_some() {
            self.pending += sum;
        }
    }

    fn finish(mut self) -> Vec<Event> {
        self.events.extend(self.open.take());
        self.events
    }
}

/// Events of one series over `range`.
pub fn detect(
    r: &Results,
    kind: ElementKind,
    obj: usize,
    var: usize,
    range: Range<usize>,
    params: EventParams,
) -> Result<Vec<Event>, OutError> {
    let mut d = Detector {
        params: EventParams { min_gap: params.min_gap.max(1), ..params },
        events: Vec::new(),
        open: None,
        pending: 0.0,
    };
    let range = range.start..range.end.min(r.out().n_periods());
    if range.is_empty() {
        return Ok(Vec::new());
    }
    match r.cache() {
        None => {
            for (i, v) in r.series(kind, obj, var, range.clone())?.into_iter().enumerate() {
                d.push(range.start + i, v);
            }
        }
        Some(c) => {
            if obj >= r.meta().count(kind) || var >= r.meta().nvars(kind) {
                return Err(OutError::OutOfRange { kind, obj, var, period: range.start });
            }
            let series = r.out().layout().series(kind, obj, var);
            let cl = c.chunk_len();
            for chunk in range.start / cl..=(range.end - 1) / cl {
                let cp = c.chunk_periods(chunk);
                let e = c.entry(series, chunk);
                let whole = cp.start >= range.start && cp.end <= range.end;
                if whole && e.max <= params.threshold && e.sum.is_finite() {
                    d.skip(e.sum);
                    continue;
                }
                let part = cp.start.max(range.start)..cp.end.min(range.end);
                for (i, v) in c.series(series, part.clone())?.into_iter().enumerate() {
                    d.push(part.start + i, v);
                }
            }
        }
    }
    Ok(d.finish())
}

/// Statistics of the events starting in one calendar year.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct YearStats {
    pub year: i32,
    pub count: usize,
    /// Integral of the values over the events (volume of a flow), see [`integral`].
    pub total: f64,
    pub hours: f64,
    pub peak: f32,
}

/// Integral of an event's values (volume for flows, depth for intensities, value × s otherwise).
pub fn event_total(meta: &OutMeta, kind: ElementKind, var: usize, e: &Event) -> f64 {
    let unit = swmm_out::format::unit(kind, var, meta.flow_units);
    let factor = integral(unit, meta.flow_units).map_or(1.0, |f| f.0);
    e.sum * meta.report_step_secs as f64 * factor
}

/// Events per calendar year of the run (years without events are listed with zeros).
pub fn yearly(meta: &OutMeta, kind: ElementKind, var: usize, range: Range<usize>, events: &[Event]) -> Vec<YearStats> {
    let range = range.start..range.end.min(meta.n_periods);
    if range.is_empty() {
        return Vec::new();
    }
    let year = |p: usize| crate::calendar::interval_start(meta, p).year();
    let (y0, y1) = (year(range.start), year(range.end - 1));
    let mut out: Vec<YearStats> =
        (y0..=y1).map(|year| YearStats { year, count: 0, total: 0.0, hours: 0.0, peak: f32::NAN }).collect();
    let step_h = meta.report_step_secs as f64 / 3600.0;
    for e in events {
        let y = &mut out[(year(e.start) - y0) as usize];
        y.count += 1;
        y.total += event_total(meta, kind, var, e);
        y.hours += e.periods() as f64 * step_h;
        if y.peak.is_nan() || e.peak > y.peak {
            y.peak = e.peak;
        }
    }
    out
}

/// Event statistics of one object over the run.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Summary {
    /// Object index in the results file.
    pub obj: usize,
    pub count: usize,
    pub total: f64,
    pub hours: f64,
    pub peak: f32,
    pub years: Vec<YearStats>,
}

/// Event statistics of many objects (in parallel).
pub fn summarize(
    r: &Results,
    kind: ElementKind,
    objs: &[usize],
    var: usize,
    range: Range<usize>,
    params: EventParams,
) -> Result<Vec<Summary>, OutError> {
    use rayon::prelude::*;
    let meta = r.meta();
    objs.par_iter()
        .map(|&obj| {
            let events = detect(r, kind, obj, var, range.clone(), params)?;
            let years = yearly(meta, kind, var, range.clone(), &events);
            Ok(Summary {
                obj,
                count: events.len(),
                total: years.iter().map(|y| y.total).sum(),
                hours: years.iter().map(|y| y.hours).sum(),
                peak: events.iter().map(|e| e.peak).fold(f32::NAN, f32::max),
                years,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn events_merge_within_the_gap_and_match_with_cache() {
        let dir = tempfile::tempdir().unwrap();
        // Link 0 flow: spikes at 100-102, 105 (merged with gap 4), 300, 2000-2004.
        let spikes = |p: usize| matches!(p, 100..=102 | 105 | 300 | 2000..=2004);
        let path = testutil::results(dir.path(), 3000, 3600, move |s, p| {
            if s == 2 * 8 + 3 * 6 && spikes(p) {
                2.0 + (p % 3) as f32
            } else if s == 2 * 8 + 3 * 6 {
                0.1
            } else {
                0.0
            }
        });
        let params = EventParams { threshold: 1.0, min_gap: 4 };
        let direct = testutil::open(&path, None);
        let cached = testutil::open(&path, Some(128));
        let a = detect(&direct, ElementKind::Link, 0, 0, 0..3000, params).unwrap();
        let b = detect(&cached, ElementKind::Link, 0, 0, 0..3000, params).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.iter().map(|e| (e.start, e.end)).collect::<Vec<_>>(), [(100, 106), (300, 301), (2000, 2005)]);
        // 2 + 3 + 4 (100..=102), two dips at 0.1, 2 + (105 % 3 = 0).
        assert!((a[0].sum - (2.0 + 3.0 + 4.0 + 0.2 + 2.0)).abs() < 1e-5, "{}", a[0].sum);
        assert_eq!((a[0].peak, a[0].peak_period), (4.0, 101));
        let gap1 = detect(&cached, ElementKind::Link, 0, 0, 0..3000, EventParams { min_gap: 1, ..params }).unwrap();
        assert_eq!(gap1.len(), 4);
        // Range cut inside an event.
        let cut = detect(&cached, ElementKind::Link, 0, 0, 101..2002, params).unwrap();
        assert_eq!(cut.iter().map(|e| (e.start, e.end)).collect::<Vec<_>>(), [(101, 106), (300, 301), (2000, 2002)]);
        let y = yearly(direct.meta(), ElementKind::Link, 0, 0..3000, &a);
        assert_eq!(y.len(), 1);
        assert_eq!((y[0].year, y[0].count, y[0].hours, y[0].peak), (2024, 3, 12.0, 4.0));
        // CMS × 3600 s.
        assert!((y[0].total - a.iter().map(|e| e.sum).sum::<f64>() * 3600.0).abs() < 1e-3);
    }
}
