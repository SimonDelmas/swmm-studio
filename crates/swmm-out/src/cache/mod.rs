//! Object-major results cache (`<file>.out.swcache`).
//!
//! A `.out` file is period-major: reading the time series of one object means touching
//! every period of the file. The cache is built in one sequential pass and stores each
//! series in chunks of `chunk_len` periods, losslessly compressed (XOR with the previous
//! value, byte shuffle, zstd), with per-chunk min / max / time of max / sum / non-zero
//! count. Constant chunks (e.g. all-zero rainfall) take no space at all.
//!
//! # File layout (little-endian)
//!
//! ```text
//! [0..128)        header (see `Header`)
//! [128..index)    chunk data, chunk-major (all series of chunk 0, then chunk 1, ...)
//! [index..end)    one 40-byte `ChunkEntry` per (series, chunk), series-major
//! ```
//!
//! The header is written last, so an interrupted build never leaves a valid-looking file.

mod build;
mod codec;

use std::fs::File;
use std::ops::Range;
use std::path::{Path, PathBuf};

use memmap2::Mmap;
use rayon::prelude::*;

use crate::format::ElementKind;
use crate::reader::{Layout, OutFile};
use crate::OutError;

pub use build::{build, BuildProgress, BuildReport};
use codec::*;
pub use codec::{ChunkEntry, Fingerprint};

/// Path of the cache next to a `.out` file: `model.out` → `model.out.swcache`.
pub fn default_cache_path(out: &Path) -> PathBuf {
    let mut s = out.as_os_str().to_owned();
    s.push(".swcache");
    PathBuf::from(s)
}

#[derive(Debug, Clone)]
pub struct CacheOptions {
    /// Periods per chunk (default 4096 ≈ 14 days at a 5-min step).
    pub chunk_len: usize,
    /// Approximate RAM used by the build (default 768 MB).
    pub memory_budget: usize,
    /// zstd level (default 1: fastest, already 3-10x on typical results).
    pub level: i32,
}

impl Default for CacheOptions {
    fn default() -> Self {
        CacheOptions { chunk_len: 4096, memory_budget: 768 << 20, level: 1 }
    }
}

/// Whole-series statistics, computed from chunk summaries only.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeriesStats {
    pub min: f32,
    pub max: f32,
    /// Period of the (first) maximum.
    pub argmax: usize,
    pub mean: f64,
    pub sum: f64,
    pub nonzero: u64,
}

impl SeriesStats {
    /// Statistics of no value: where an accumulation starts.
    const EMPTY: SeriesStats =
        SeriesStats { min: f32::INFINITY, max: f32::NEG_INFINITY, argmax: 0, mean: 0.0, sum: 0.0, nonzero: 0 };

    /// Statistics of the values of a series (periods `0..values.len()`). NaN values are
    /// never a minimum or a maximum, but they make the sum and the mean NaN.
    pub fn of(values: &[f32]) -> SeriesStats {
        let mut s = SeriesStats::EMPTY;
        for (i, &v) in values.iter().enumerate() {
            if v < s.min {
                s.min = v;
            }
            if v > s.max {
                s.max = v;
                s.argmax = i;
            }
            s.sum += v as f64;
            s.nonzero += (v != 0.0) as u64;
        }
        s.mean = s.sum / values.len().max(1) as f64;
        s
    }

    /// Adds the periods of a chunk starting at period `first`, from its summary.
    fn add_chunk(&mut self, first: usize, e: &ChunkEntry) {
        if e.min < self.min {
            self.min = e.min;
        }
        if e.max > self.max {
            self.max = e.max;
            self.argmax = first + e.argmax as usize;
        }
        self.sum += e.sum;
        self.nonzero += e.nonzero as u64;
    }
}

/// A piece of a series met by [`ResultsCache::walk`].
pub enum Piece<'a> {
    /// A chunk wholly inside the range, known by its summary alone.
    Chunk { periods: Range<usize>, summary: ChunkEntry },
    /// Decoded values, starting at period `start`.
    Values { start: usize, values: &'a [f32] },
}

/// An opened cache, validated against its `.out` file.
pub struct ResultsCache {
    map: Mmap,
    header: Header,
    layout: Layout,
    path: PathBuf,
}

impl std::fmt::Debug for ResultsCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResultsCache").field("path", &self.path).field("header", &self.header).finish()
    }
}

impl ResultsCache {
    /// Opens the cache at `path`. Fails with [`OutError::StaleCache`] if it was built from
    /// another version of `out`.
    pub fn open(path: &Path, out: &OutFile) -> Result<ResultsCache, OutError> {
        let file = File::open(path).map_err(|e| OutError::io(path, e))?;
        // SAFETY: read-only map of a file only this application writes (atomically, by rename).
        let map = unsafe { Mmap::map(&file) }.map_err(|e| OutError::io(path, e))?;
        let header = Header::decode(&map).ok_or_else(|| OutError::Corrupt("not a results cache".into()))?;
        let layout = *out.layout();
        if header.source != Fingerprint::of(out)?
            || header.n_periods != out.n_periods() as u64
            || header.n_series != layout.values_per_period() as u64
        {
            return Err(OutError::StaleCache);
        }
        if header.chunk_len == 0 || header.n_chunks != header.n_periods.div_ceil(header.chunk_len as u64) {
            return Err(OutError::Corrupt("results cache has an inconsistent header".into()));
        }
        let index_len = header.n_series.checked_mul(header.n_chunks).and_then(|n| n.checked_mul(ENTRY_BYTES as u64));
        if index_len.and_then(|n| n.checked_add(header.index_offset)) != Some(map.len() as u64) {
            return Err(OutError::Corrupt("results cache is truncated".into()));
        }
        Ok(ResultsCache { map, header, layout, path: path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn chunk_len(&self) -> usize {
        self.header.chunk_len as usize
    }

    pub fn n_chunks(&self) -> usize {
        self.header.n_chunks as usize
    }

    pub fn n_periods(&self) -> usize {
        self.header.n_periods as usize
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    fn check_series(&self, series: usize) -> Result<(), OutError> {
        if series as u64 >= self.header.n_series {
            return Err(OutError::Corrupt(format!("series {series} out of range")));
        }
        Ok(())
    }

    /// Summary of chunk `c` of a series.
    pub fn entry(&self, series: usize, chunk: usize) -> ChunkEntry {
        let at = self.header.index_offset as usize + (series * self.n_chunks() + chunk) * ENTRY_BYTES;
        ChunkEntry::decode(&self.map[at..at + ENTRY_BYTES])
    }

    /// Periods covered by chunk `c`.
    pub fn chunk_periods(&self, chunk: usize) -> Range<usize> {
        let a = chunk * self.chunk_len();
        a..(a + self.chunk_len()).min(self.n_periods())
    }

    fn decode_into(&self, series: usize, chunk: usize, out: &mut Vec<f32>) -> Result<(), OutError> {
        let e = self.entry(series, chunk);
        let n = self.chunk_periods(chunk).len();
        // The index is read from the file: an entry that points outside it is a damaged cache.
        let payload = (e.offset as usize)
            .checked_add(e.clen as usize)
            .and_then(|end| self.map.get(e.offset as usize..end))
            .ok_or_else(|| OutError::Corrupt("results cache index points outside the file".into()))?;
        decode_chunk(&e, payload, n, out)
    }

    /// Values of a series over a range of periods.
    pub fn series(&self, series: usize, periods: Range<usize>) -> Result<Vec<f32>, OutError> {
        self.check_series(series)?;
        let periods = periods.start..periods.end.min(self.n_periods());
        if periods.is_empty() {
            return Ok(Vec::new());
        }
        let cl = self.chunk_len();
        let (c0, c1) = (periods.start / cl, (periods.end - 1) / cl);
        let mut all = Vec::with_capacity((c1 - c0 + 1) * cl);
        for c in c0..=c1 {
            self.decode_into(series, c, &mut all)?;
        }
        let skip = periods.start - c0 * cl;
        all.drain(..skip);
        all.truncate(periods.len());
        Ok(all)
    }

    pub fn series_of(
        &self,
        kind: ElementKind,
        obj: usize,
        var: usize,
        periods: Range<usize>,
    ) -> Result<Vec<f32>, OutError> {
        self.series(self.layout.series(kind, obj, var), periods)
    }

    /// Whole-series statistics from chunk summaries (no decompression).
    pub fn stats(&self, series: usize) -> SeriesStats {
        let mut s = SeriesStats::EMPTY;
        for c in 0..self.n_chunks() {
            s.add_chunk(c * self.chunk_len(), &self.entry(series, c));
        }
        s.mean = s.sum / self.n_periods().max(1) as f64;
        s
    }

    /// Walks a series over a range of periods, chunk by chunk. A chunk wholly inside
    /// the range is first offered as its summary ([`Piece::Chunk`]): when `visit`
    /// returns `false` (the summary is not enough), and for the chunks cut by the ends
    /// of the range, the values are decoded and given as [`Piece::Values`].
    pub fn walk(
        &self,
        series: usize,
        range: Range<usize>,
        mut visit: impl FnMut(Piece<'_>) -> bool,
    ) -> Result<(), OutError> {
        self.check_series(series)?;
        let range = range.start..range.end.min(self.n_periods());
        if range.is_empty() {
            return Ok(());
        }
        let cl = self.chunk_len();
        for chunk in range.start / cl..=(range.end - 1) / cl {
            let periods = self.chunk_periods(chunk);
            let whole = periods.start >= range.start && periods.end <= range.end;
            if whole && visit(Piece::Chunk { periods: periods.clone(), summary: self.entry(series, chunk) }) {
                continue;
            }
            let part = periods.start.max(range.start)..periods.end.min(range.end);
            let values = self.series(series, part.clone())?;
            visit(Piece::Values { start: part.start, values: &values });
        }
        Ok(())
    }

    /// Statistics of one variable for every object of a kind (e.g. a max-depth map).
    pub fn envelope(&self, kind: ElementKind, var: usize) -> Vec<SeriesStats> {
        let n = self.layout.counts[kind as usize];
        (0..n).into_par_iter().map(|o| self.stats(self.layout.series(kind, o, var))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_codec_is_lossless() {
        let values: Vec<f32> =
            (0..1000).map(|i| ((i as f32) * 0.1).sin() * 3.0 + if i % 7 == 0 { f32::NAN } else { 0.0 }).collect();
        let (e, payload) = encode_chunk(&values, 3);
        assert_eq!(e.encoding, ENC_ZSTD);
        let mut out = Vec::new();
        decode_chunk(&e, &payload, values.len(), &mut out).unwrap();
        assert!(values.iter().zip(&out).all(|(a, b)| a.to_bits() == b.to_bits()));
    }

    #[test]
    fn constant_chunk_has_no_payload() {
        let (e, payload) = encode_chunk(&[0.0; 4096], 1);
        assert!(payload.is_empty());
        assert_eq!((e.encoding, e.max, e.nonzero), (ENC_CONSTANT, 0.0, 0));
    }

    #[test]
    fn summaries() {
        let (e, _) = encode_chunk(&[1.0, 5.0, -2.0, 5.0, 0.0], 1);
        assert_eq!((e.min, e.max, e.argmax, e.sum, e.nonzero), (-2.0, 5.0, 1, 9.0, 4));
    }

    #[test]
    fn grouping() {
        assert_eq!(build::groups(10, 4096, 1 << 30), vec![0..10]);
        let g = build::groups(1_000_000, 4096, 256 << 20);
        assert_eq!(g.len(), 62);
        assert_eq!(g.last().unwrap().end, 1_000_000);
    }
}
