//! [`Results`]: one entry point over a `.out` file and its optional cache.

use std::ops::Range;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use crate::cache::{self, BuildProgress, BuildReport, CacheOptions, ResultsCache, SeriesStats};
use crate::format::ElementKind;
use crate::reader::{OutFile, OutMeta};
use crate::OutError;

/// Min/max envelope of a series per bucket of periods, for plotting.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MinMax {
    /// First period of each bucket.
    pub periods: Vec<usize>,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
}

impl MinMax {
    pub fn len(&self) -> usize {
        self.periods.len()
    }

    pub fn is_empty(&self) -> bool {
        self.periods.is_empty()
    }
}

/// Reduces `values` (starting at period `first`) to at most `buckets` min/max pairs.
/// Short series are returned unchanged (min = max).
pub fn decimate(values: &[f32], first: usize, buckets: usize) -> MinMax {
    let buckets = buckets.max(1);
    if values.len() <= 2 * buckets {
        return MinMax { periods: (first..first + values.len()).collect(), min: values.to_vec(), max: values.to_vec() };
    }
    let size = values.len().div_ceil(buckets);
    let mut out = MinMax::default();
    for (i, chunk) in values.chunks(size).enumerate() {
        let (lo, hi) = chunk.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| (lo.min(v), hi.max(v)));
        out.periods.push(first + i * size);
        out.min.push(lo);
        out.max.push(hi);
    }
    out
}

/// Min/max per bucket of `per_bucket` periods (rounded up to whole chunks), from chunk
/// summaries; chunks cut by the range ends are decoded.
fn pyramid(c: &ResultsCache, series: usize, periods: Range<usize>, per_bucket: usize) -> Result<MinMax, OutError> {
    let cl = c.chunk_len();
    let k = per_bucket.div_ceil(cl);
    let (c0, c1) = (periods.start / cl, (periods.end - 1) / cl);
    let mut out = MinMax::default();
    for g in (c0..=c1).step_by(k) {
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for chunk in g..(g + k).min(c1 + 1) {
            let cp = c.chunk_periods(chunk);
            if cp.start >= periods.start && cp.end <= periods.end {
                let e = c.entry(series, chunk);
                lo = lo.min(e.min);
                hi = hi.max(e.max);
            } else {
                let part = cp.start.max(periods.start)..cp.end.min(periods.end);
                for v in c.series(series, part)? {
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
        }
        out.periods.push((g * cl).max(periods.start));
        out.min.push(lo);
        out.max.push(hi);
    }
    Ok(out)
}

/// A results file, with its cache when one is available and up to date.
pub struct Results {
    out: OutFile,
    cache: Option<ResultsCache>,
}

impl Results {
    /// Opens a `.out` file and its cache (`<file>.swcache`) if valid. A missing or stale
    /// cache is ignored; see [`Results::cache_status`].
    pub fn open(path: impl AsRef<Path>) -> Result<Results, OutError> {
        let out = OutFile::open(path)?;
        let cache = ResultsCache::open(&cache::default_cache_path(out.path()), &out).ok();
        Ok(Results { out, cache })
    }

    pub fn out(&self) -> &OutFile {
        &self.out
    }

    pub fn meta(&self) -> &OutMeta {
        self.out.meta()
    }

    pub fn cache(&self) -> Option<&ResultsCache> {
        self.cache.as_ref()
    }

    /// Why the cache is not used, if it is not.
    pub fn cache_status(&self) -> Result<(), OutError> {
        match &self.cache {
            Some(_) => Ok(()),
            None => ResultsCache::open(&cache::default_cache_path(self.out.path()), &self.out).map(|_| ()),
        }
    }

    /// Opens the cache again (e.g. after it was built by another thread with
    /// [`cache::build`]).
    pub fn reload_cache(&mut self) -> Result<(), OutError> {
        let c = ResultsCache::open(&cache::default_cache_path(self.out.path()), &self.out)?;
        self.cache = Some(c);
        Ok(())
    }

    /// Builds (or rebuilds) the cache next to the `.out` file and starts using it.
    pub fn build_cache(
        &mut self,
        opts: &CacheOptions,
        progress: impl Fn(BuildProgress) + Sync,
        cancel: &AtomicBool,
    ) -> Result<BuildReport, OutError> {
        let path = cache::default_cache_path(self.out.path());
        self.cache = None;
        let report = cache::build(&self.out, &path, opts, progress, cancel)?;
        self.cache = Some(ResultsCache::open(&path, &self.out)?);
        Ok(report)
    }

    /// One variable for all objects at a period (always read from the `.out`).
    pub fn frame(&self, kind: ElementKind, var: usize, period: usize) -> Result<Vec<f32>, OutError> {
        self.out.frame(kind, var, period)
    }

    /// Time series over a range of periods, from the cache when available.
    pub fn series(
        &self,
        kind: ElementKind,
        obj: usize,
        var: usize,
        periods: Range<usize>,
    ) -> Result<Vec<f32>, OutError> {
        let m = self.out.meta();
        if obj >= m.count(kind) || var >= m.nvars(kind) {
            return Err(OutError::OutOfRange { kind, obj, var, period: periods.start });
        }
        match &self.cache {
            Some(c) => c.series_of(kind, obj, var, periods),
            None => self.out.series(kind, obj, var, periods),
        }
    }

    /// Series reduced to about `buckets` min/max pairs (for plots of any length).
    ///
    /// With the cache, buckets spanning whole chunks come from the chunk summaries
    /// (no decompression), so a multi-year series costs the same as a short one.
    pub fn series_minmax(
        &self,
        kind: ElementKind,
        obj: usize,
        var: usize,
        periods: Range<usize>,
        buckets: usize,
    ) -> Result<MinMax, OutError> {
        let periods = periods.start..periods.end.min(self.out.n_periods());
        let buckets = buckets.max(1);
        if let Some(c) = &self.cache {
            let per_bucket = periods.len().div_ceil(buckets);
            if per_bucket >= c.chunk_len() && !periods.is_empty() {
                self.check(kind, obj, var, periods.start)?;
                return pyramid(c, self.out.layout().series(kind, obj, var), periods, per_bucket);
            }
        }
        let first = periods.start;
        let values = self.series(kind, obj, var, periods)?;
        Ok(decimate(&values, first, buckets))
    }

    fn check(&self, kind: ElementKind, obj: usize, var: usize, period: usize) -> Result<(), OutError> {
        let m = self.out.meta();
        if obj >= m.count(kind) || var >= m.nvars(kind) {
            return Err(OutError::OutOfRange { kind, obj, var, period });
        }
        Ok(())
    }

    /// Statistics of one series over the whole run: from the chunk summaries with the
    /// cache, otherwise by reading the series.
    pub fn stats(&self, kind: ElementKind, obj: usize, var: usize) -> Result<SeriesStats, OutError> {
        self.check(kind, obj, var, 0)?;
        if let Some(c) = &self.cache {
            return Ok(c.stats(self.out.layout().series(kind, obj, var)));
        }
        let values = self.out.series(kind, obj, var, 0..self.out.n_periods())?;
        let mut s =
            SeriesStats { min: f32::INFINITY, max: f32::NEG_INFINITY, argmax: 0, mean: 0.0, sum: 0.0, nonzero: 0 };
        for (i, &v) in values.iter().enumerate() {
            s.min = s.min.min(v);
            if v > s.max {
                s.max = v;
                s.argmax = i;
            }
            s.sum += v as f64;
            s.nonzero += (v != 0.0) as u64;
        }
        s.mean = s.sum / values.len().max(1) as f64;
        Ok(s)
    }

    /// First period after `from` where the series rises above `threshold` (start of the
    /// next event). With the cache, chunks that stay below the threshold are skipped
    /// without decompression.
    pub fn next_rise(
        &self,
        kind: ElementKind,
        obj: usize,
        var: usize,
        from: usize,
        threshold: f32,
    ) -> Result<Option<usize>, OutError> {
        self.check(kind, obj, var, from)?;
        let n = self.out.n_periods();
        if from + 1 >= n {
            return Ok(None);
        }
        let mut above = self.out.value(kind, obj, var, from)? > threshold;
        let (block, chunk) = match &self.cache {
            Some(c) => (c.chunk_len(), Some(c)),
            None => (1 << 16, None),
        };
        let mut start = from + 1;
        while start < n {
            let end = ((start / block + 1) * block).min(n);
            if let Some(c) = chunk {
                let e = c.entry(self.out.layout().series(kind, obj, var), start / block);
                if e.max <= threshold {
                    above = false;
                    start = end;
                    continue;
                }
            }
            for (i, v) in self.series(kind, obj, var, start..end)?.into_iter().enumerate() {
                if v > threshold && !above {
                    return Ok(Some(start + i));
                }
                above = v > threshold;
            }
            start = end;
        }
        Ok(None)
    }

    /// Whole-run statistics of one variable for every object (needs the cache).
    pub fn envelope(&self, kind: ElementKind, var: usize) -> Result<Vec<SeriesStats>, OutError> {
        let c = self.cache.as_ref().ok_or(OutError::NoCache)?;
        if var >= self.out.meta().nvars(kind) {
            return Err(OutError::OutOfRange { kind, obj: 0, var, period: 0 });
        }
        Ok(c.envelope(kind, var))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimation() {
        let v: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let d = decimate(&v, 10, 10);
        assert_eq!(d.len(), 10);
        assert_eq!((d.periods[1], d.min[1], d.max[1]), (20, 10.0, 19.0));
        let short = decimate(&v[..15], 0, 10);
        assert_eq!(short.len(), 15);
    }
}
