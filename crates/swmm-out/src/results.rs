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

    /// Series reduced to at most `buckets` min/max pairs (for plots of any length).
    pub fn series_minmax(
        &self,
        kind: ElementKind,
        obj: usize,
        var: usize,
        periods: Range<usize>,
        buckets: usize,
    ) -> Result<MinMax, OutError> {
        let first = periods.start;
        let values = self.series(kind, obj, var, periods)?;
        Ok(decimate(&values, first, buckets))
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
