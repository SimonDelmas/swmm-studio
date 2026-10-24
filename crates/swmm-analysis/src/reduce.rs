//! One statistic of a series over a range of periods.
//!
//! With the results cache, chunks that lie wholly inside the range are summarised
//! from their stored min / max / sum (and, for time above a threshold, chunks that
//! are entirely above or below it); only the chunks cut by the range ends, or that
//! straddle the threshold, are decompressed. Without the cache, every object of a
//! kind is reduced in one sequential pass over the periods (frames are contiguous).

use std::ops::Range;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use swmm_out::{ElementKind, FlowUnits, OutError, Results};

/// Statistic of a series.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "stat", rename_all = "snake_case")]
pub enum Stat {
    Max,
    Min,
    Mean,
    /// Period of the (first) maximum.
    TimeOfMax,
    /// Integral over time (volume of a flow, depth of a rainfall intensity), see [`integral`].
    Total,
    /// Number of periods with a value above the threshold.
    PeriodsAbove {
        threshold: f32,
    },
}

/// Running statistics. NaN values are ignored.
#[derive(Debug, Clone, Copy)]
struct Acc {
    min: f32,
    max: f32,
    argmax: usize,
    sum: f64,
    n: u64,
    above: u64,
}

impl Acc {
    fn new() -> Acc {
        Acc { min: f32::INFINITY, max: f32::NEG_INFINITY, argmax: 0, sum: 0.0, n: 0, above: 0 }
    }

    fn push(&mut self, p: usize, v: f32, threshold: f32) {
        if v.is_nan() {
            return;
        }
        if v < self.min {
            self.min = v;
        }
        if v > self.max {
            self.max = v;
            self.argmax = p;
        }
        self.sum += v as f64;
        self.n += 1;
        self.above += (v > threshold) as u64;
    }

    fn value(&self, stat: Stat, step_secs: f64, factor: f64) -> f64 {
        if self.n == 0 {
            return f64::NAN;
        }
        match stat {
            Stat::Max => self.max as f64,
            Stat::Min => self.min as f64,
            Stat::Mean => self.sum / self.n as f64,
            Stat::TimeOfMax => self.argmax as f64,
            Stat::Total => self.sum * step_secs * factor,
            Stat::PeriodsAbove { .. } => self.above as f64,
        }
    }
}

fn threshold(stat: Stat) -> f32 {
    match stat {
        Stat::PeriodsAbove { threshold } => threshold,
        _ => f32::INFINITY,
    }
}

/// Factor and unit of the integral over time of a variable with unit `unit`: flows
/// give a volume (m³ or ft³), intensities a depth (mm or in). `None` when the integral
/// has no meaning (depths, velocities…).
pub fn integral(unit: &str, flow: FlowUnits) -> Option<(f64, &'static str)> {
    const FT3_PER_GAL: f64 = 0.133_680_556;
    Some(match unit {
        "CMS" => (1.0, "m3"),
        "LPS" => (1e-3, "m3"),
        "MLD" => (1e3 / 86_400.0, "m3"),
        "CFS" => (1.0, "ft3"),
        "GPM" => (FT3_PER_GAL / 60.0, "ft3"),
        "MGD" => (1e6 * FT3_PER_GAL / 86_400.0, "ft3"),
        "mm/hr" => (1.0 / 3600.0, "mm"),
        "in/hr" => (1.0 / 3600.0, "in"),
        "mm/day" => (1.0 / 86_400.0, "mm"),
        "in/day" => (1.0 / 86_400.0, "in"),
        _ => {
            let _ = flow;
            return None;
        }
    })
}

fn total_factor(r: &Results, kind: ElementKind, var: usize) -> f64 {
    let m = r.meta();
    integral(swmm_out::format::unit(kind, var, m.flow_units), m.flow_units).map_or(1.0, |f| f.0)
}

/// Statistics of one series over `range`.
fn accumulate(
    r: &Results,
    kind: ElementKind,
    obj: usize,
    var: usize,
    range: Range<usize>,
    stat: Stat,
) -> Result<Acc, OutError> {
    let thr = threshold(stat);
    let mut acc = Acc::new();
    let range = range.start..range.end.min(r.out().n_periods());
    if range.is_empty() {
        return Ok(acc);
    }
    let Some(c) = r.cache() else {
        for (i, v) in r.series(kind, obj, var, range.clone())?.into_iter().enumerate() {
            acc.push(range.start + i, v, thr);
        }
        return Ok(acc);
    };
    if obj >= r.meta().count(kind) || var >= r.meta().nvars(kind) {
        return Err(OutError::OutOfRange { kind, obj, var, period: range.start });
    }
    let series = r.out().layout().series(kind, obj, var);
    let cl = c.chunk_len();
    for chunk in range.start / cl..=(range.end - 1) / cl {
        let cp = c.chunk_periods(chunk);
        let whole = cp.start >= range.start && cp.end <= range.end;
        if whole {
            let e = c.entry(series, chunk);
            // Summaries hold for chunks without NaN (sum is finite) that are wholly on
            // one side of the threshold.
            let side_known = e.max <= thr || e.min > thr;
            if e.sum.is_finite() && e.min.is_finite() && side_known {
                let n = cp.len() as u64;
                if e.min < acc.min {
                    acc.min = e.min;
                }
                if e.max > acc.max {
                    acc.max = e.max;
                    acc.argmax = cp.start + e.argmax as usize;
                }
                acc.sum += e.sum;
                acc.n += n;
                if e.min > thr {
                    acc.above += n;
                }
                continue;
            }
        }
        let part = cp.start.max(range.start)..cp.end.min(range.end);
        for (i, v) in c.series(series, part.clone())?.into_iter().enumerate() {
            acc.push(part.start + i, v, thr);
        }
    }
    Ok(acc)
}

/// A statistic of one series over a range of periods (NaN when the range is empty).
/// [`Stat::TimeOfMax`] gives a period index; [`Stat::Total`] is in the unit of
/// [`integral`] (or value × seconds when it has none).
pub fn reduce_series(
    r: &Results,
    kind: ElementKind,
    obj: usize,
    var: usize,
    range: Range<usize>,
    stat: Stat,
) -> Result<f64, OutError> {
    let acc = accumulate(r, kind, obj, var, range, stat)?;
    Ok(acc.value(stat, r.meta().report_step_secs as f64, total_factor(r, kind, var)))
}

/// A statistic of one variable for every object of a kind (in `.out` order).
pub fn reduce_all(
    r: &Results,
    kind: ElementKind,
    var: usize,
    range: Range<usize>,
    stat: Stat,
) -> Result<Vec<f64>, OutError> {
    let m = r.meta();
    if var >= m.nvars(kind) {
        return Err(OutError::OutOfRange { kind, obj: 0, var, period: range.start });
    }
    let step = m.report_step_secs as f64;
    let factor = total_factor(r, kind, var);
    let n = m.count(kind);
    if r.cache().is_some() {
        return (0..n)
            .into_par_iter()
            .map(|o| accumulate(r, kind, o, var, range.clone(), stat).map(|a| a.value(stat, step, factor)))
            .collect();
    }
    let thr = threshold(stat);
    let mut accs = vec![Acc::new(); n];
    let mut frame = Vec::new();
    for p in range.start..range.end.min(r.out().n_periods()) {
        r.out().frame_into(kind, var, p, &mut frame)?;
        for (a, &v) in accs.iter_mut().zip(&frame) {
            a.push(p, v, thr);
        }
    }
    Ok(accs.iter().map(|a| a.value(stat, step, factor)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    /// Series `s` at period `p`: a sawtooth with a few NaN-free spikes.
    fn value(s: usize, p: usize) -> f32 {
        ((p * (s + 1)) % 37) as f32 * 0.5 - 3.0
    }

    #[test]
    fn cached_and_direct_agree_with_brute_force() {
        let dir = tempfile::tempdir().unwrap();
        let path = testutil::results(dir.path(), 1000, 300, value);
        let direct = testutil::open(&path, None);
        let cached = testutil::open(&path, Some(64));
        let layout = *direct.out().layout();
        let stats = [
            Stat::Max,
            Stat::Min,
            Stat::Mean,
            Stat::TimeOfMax,
            Stat::Total,
            Stat::PeriodsAbove { threshold: 2.0 },
            Stat::PeriodsAbove { threshold: -10.0 },
        ];
        for range in [0..1000, 10..900, 64..128, 70..71, 999..1000] {
            for stat in stats {
                let all_d = reduce_all(&direct, ElementKind::Link, 0, range.clone(), stat).unwrap();
                let all_c = reduce_all(&cached, ElementKind::Link, 0, range.clone(), stat).unwrap();
                for o in 0..2 {
                    let s = layout.series(ElementKind::Link, o, 0);
                    let v: Vec<f32> = range.clone().map(|p| value(s, p)).collect();
                    let max = v.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                    let expect = match stat {
                        Stat::Max => max as f64,
                        Stat::Min => v.iter().copied().fold(f32::INFINITY, f32::min) as f64,
                        Stat::Mean => v.iter().map(|&x| x as f64).sum::<f64>() / v.len() as f64,
                        Stat::TimeOfMax => (range.start + v.iter().position(|&x| x == max).unwrap()) as f64,
                        Stat::Total => v.iter().map(|&x| x as f64).sum::<f64>() * 300.0,
                        Stat::PeriodsAbove { threshold } => v.iter().filter(|&&x| x > threshold).count() as f64,
                    };
                    let d = reduce_series(&direct, ElementKind::Link, o, 0, range.clone(), stat).unwrap();
                    let c = reduce_series(&cached, ElementKind::Link, o, 0, range.clone(), stat).unwrap();
                    for got in [d, c, all_d[o], all_c[o]] {
                        assert!(
                            (got - expect).abs() < 1e-6 * expect.abs().max(1.0),
                            "{stat:?} {range:?} {got} {expect}"
                        );
                    }
                }
            }
        }
        assert!(reduce_series(&cached, ElementKind::Link, 0, 0, 5..5, Stat::Max).unwrap().is_nan());
    }

    #[test]
    fn integral_units() {
        assert_eq!(integral("LPS", FlowUnits::Lps), Some((1e-3, "m3")));
        assert_eq!(integral("mm/hr", FlowUnits::Lps).unwrap().1, "mm");
        assert_eq!(integral("m", FlowUnits::Lps), None);
    }
}
