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

use std::cell::RefCell;
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use memmap2::Mmap;
use rayon::prelude::*;
use xxhash_rust::xxh3::Xxh3;

use crate::format::ElementKind;
use crate::reader::{Layout, OutFile};
use crate::OutError;

const MAGIC: &[u8; 8] = b"SWCACHE1";
const FORMAT_VERSION: u32 = 1;
const HEADER_BYTES: u64 = 128;
const ENTRY_BYTES: usize = 40;
/// Series transposed together (cache-friendly gather from period rows).
const TILE: usize = 64;

const ENC_ZSTD: u8 = 0;
const ENC_CONSTANT: u8 = 1;

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

/// Identity of the `.out` file a cache was built from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub len: u64,
    pub mtime_ns: u64,
    pub hash: u64,
}

impl Fingerprint {
    /// Size + modification time + hash of the header, epilogue and first/last periods.
    pub fn of(out: &OutFile) -> Result<Fingerprint, OutError> {
        let md = std::fs::metadata(out.path()).map_err(|e| OutError::io(out.path(), e))?;
        let mtime_ns =
            md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64);
        let bytes = out.bytes();
        let mut h = Xxh3::new();
        let l = out.layout();
        h.update(&bytes[..l.output_start as usize]);
        h.update(&bytes[bytes.len().saturating_sub(24)..]);
        let n = out.n_periods();
        if n > 0 {
            h.update(out.period_bytes(0));
            h.update(out.period_bytes(n / 2));
            h.update(out.period_bytes(n - 1));
        }
        Ok(Fingerprint { len: bytes.len() as u64, mtime_ns, hash: h.digest() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Header {
    chunk_len: u32,
    n_periods: u64,
    n_series: u64,
    n_chunks: u64,
    source: Fingerprint,
    index_offset: u64,
    level: i32,
}

impl Header {
    fn encode(&self) -> [u8; HEADER_BYTES as usize] {
        let mut b = [0u8; HEADER_BYTES as usize];
        b[0..8].copy_from_slice(MAGIC);
        b[8..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        b[12..16].copy_from_slice(&self.chunk_len.to_le_bytes());
        b[16..24].copy_from_slice(&self.n_periods.to_le_bytes());
        b[24..32].copy_from_slice(&self.n_series.to_le_bytes());
        b[32..40].copy_from_slice(&self.n_chunks.to_le_bytes());
        b[40..48].copy_from_slice(&self.source.len.to_le_bytes());
        b[48..56].copy_from_slice(&self.source.mtime_ns.to_le_bytes());
        b[56..64].copy_from_slice(&self.source.hash.to_le_bytes());
        b[64..72].copy_from_slice(&self.index_offset.to_le_bytes());
        b[72..80].copy_from_slice(&HEADER_BYTES.to_le_bytes());
        b[80..84].copy_from_slice(&self.level.to_le_bytes());
        b
    }

    fn decode(b: &[u8]) -> Option<Header> {
        if b.len() < HEADER_BYTES as usize || &b[0..8] != MAGIC {
            return None;
        }
        let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        let u64_at = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
        if u32_at(8) != FORMAT_VERSION {
            return None;
        }
        Some(Header {
            chunk_len: u32_at(12),
            n_periods: u64_at(16),
            n_series: u64_at(24),
            n_chunks: u64_at(32),
            source: Fingerprint { len: u64_at(40), mtime_ns: u64_at(48), hash: u64_at(56) },
            index_offset: u64_at(64),
            level: u32_at(80) as i32,
        })
    }
}

/// Summary of one chunk of one series.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChunkEntry {
    offset: u64,
    clen: u32,
    encoding: u8,
    pub min: f32,
    pub max: f32,
    /// Index of the (first) maximum within the chunk.
    pub argmax: u32,
    pub sum: f64,
    /// Values different from zero.
    pub nonzero: u32,
}

impl ChunkEntry {
    fn encode(&self, b: &mut [u8]) {
        b[0..8].copy_from_slice(&self.offset.to_le_bytes());
        b[8..12].copy_from_slice(&self.clen.to_le_bytes());
        b[12] = self.encoding;
        b[13..16].fill(0);
        b[16..20].copy_from_slice(&self.min.to_le_bytes());
        b[20..24].copy_from_slice(&self.max.to_le_bytes());
        b[24..28].copy_from_slice(&self.argmax.to_le_bytes());
        b[28..32].copy_from_slice(&self.nonzero.to_le_bytes());
        b[32..40].copy_from_slice(&self.sum.to_le_bytes());
    }

    fn decode(b: &[u8]) -> ChunkEntry {
        let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        let u = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        ChunkEntry {
            offset: u64::from_le_bytes(b[0..8].try_into().unwrap()),
            clen: u(8),
            encoding: b[12],
            min: f(16),
            max: f(20),
            argmax: u(24),
            nonzero: u(28),
            sum: f64::from_le_bytes(b[32..40].try_into().unwrap()),
        }
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

thread_local! {
    static COMPRESSOR: RefCell<Option<(i32, zstd::bulk::Compressor<'static>)>> = const { RefCell::new(None) };
    static DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
    /// Per-thread buffers: fresh large allocations page-fault on every use, and Windows
    /// serializes page faults across threads.
    static SCRATCH: RefCell<(Vec<u8>, Vec<u8>)> = const { RefCell::new((Vec::new(), Vec::new())) };
    static TILE_BUF: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

/// Encodes one chunk; returns the summary (offset left at 0) and the payload.
fn encode_chunk(values: &[f32], level: i32) -> (ChunkEntry, Vec<u8>) {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut argmax = 0u32;
    let mut sum = 0.0f64;
    let mut nonzero = 0u32;
    let first = values[0].to_bits();
    let mut constant = true;
    for (i, &v) in values.iter().enumerate() {
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
            argmax = i as u32;
        }
        sum += v as f64;
        nonzero += (v != 0.0) as u32;
        constant &= v.to_bits() == first;
    }
    if !min.is_finite() {
        min = values[0];
    }
    if !max.is_finite() {
        max = values[0];
    }
    let mut entry = ChunkEntry { offset: 0, clen: 0, encoding: ENC_CONSTANT, min, max, argmax, sum, nonzero };
    if constant {
        entry.min = values[0];
        entry.max = values[0];
        return (entry, Vec::new());
    }
    // XOR with previous value, then split into 4 byte planes.
    let n = values.len();
    let payload = SCRATCH.with(|s| {
        let (shuffled, compressed) = &mut *s.borrow_mut();
        shuffled.resize(4 * n, 0);
        let mut prev = 0u32;
        for (i, &v) in values.iter().enumerate() {
            let bits = v.to_bits();
            let x = (bits ^ prev).to_le_bytes();
            prev = bits;
            for (plane, byte) in x.into_iter().enumerate() {
                shuffled[plane * n + i] = byte;
            }
        }
        compressed.clear();
        compressed.reserve(zstd::zstd_safe::compress_bound(4 * n));
        COMPRESSOR.with(|c| {
            let mut c = c.borrow_mut();
            if c.as_ref().is_none_or(|(l, _)| *l != level) {
                *c = Some((level, zstd::bulk::Compressor::new(level).expect("zstd compressor")));
            }
            c.as_mut().unwrap().1.compress_to_buffer(&shuffled[..], compressed).expect("zstd compress")
        });
        compressed.clone()
    });
    entry.encoding = ENC_ZSTD;
    entry.clen = payload.len() as u32;
    (entry, payload)
}

fn decode_chunk(entry: &ChunkEntry, payload: &[u8], n: usize, out: &mut Vec<f32>) -> Result<(), OutError> {
    if entry.encoding == ENC_CONSTANT {
        out.extend(std::iter::repeat_n(entry.min, n));
        return Ok(());
    }
    let raw = DECOMPRESSOR.with(|d| {
        let mut d = d.borrow_mut();
        let d = d.get_or_insert_with(|| zstd::bulk::Decompressor::new().expect("zstd decompressor"));
        d.decompress(payload, 4 * n)
    });
    let raw = raw.map_err(|e| OutError::Corrupt(format!("cache chunk: {e}")))?;
    if raw.len() != 4 * n {
        return Err(OutError::Corrupt("cache chunk has wrong length".into()));
    }
    let mut prev = 0u32;
    out.reserve(n);
    for i in 0..n {
        let x = u32::from_le_bytes([raw[i], raw[n + i], raw[2 * n + i], raw[3 * n + i]]);
        prev ^= x;
        out.push(f32::from_bits(prev));
    }
    Ok(())
}

/// Progress of a cache build.
#[derive(Debug, Clone, Copy)]
pub struct BuildProgress {
    pub bytes_done: u64,
    pub bytes_total: u64,
}

/// Outcome of a cache build.
#[derive(Debug, Clone, Copy)]
pub struct BuildReport {
    pub source_bytes: u64,
    pub cache_bytes: u64,
    pub n_series: usize,
    pub n_chunks: usize,
    pub constant_chunks: u64,
    pub seconds: f64,
    /// Time spent reading the `.out` (reader thread, overlaps with encoding).
    pub read_seconds: f64,
    /// Time spent transposing and compressing.
    pub encode_seconds: f64,
    /// Time spent writing compressed chunks.
    pub write_seconds: f64,
}

impl BuildReport {
    pub fn ratio(&self) -> f64 {
        self.source_bytes as f64 / self.cache_bytes.max(1) as f64
    }
}

/// A block of raw period rows for one chunk and one group of series.
struct Block {
    chunk: usize,
    series: Range<usize>,
    rows: usize,
    buf: Vec<u8>,
    /// Bytes between consecutive rows in `buf`, and offset of the group's first value.
    stride: usize,
    offset: usize,
}

#[cfg(windows)]
fn read_at(f: &File, buf: &mut [u8], mut pos: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < buf.len() {
        let n = f.seek_read(&mut buf[done..], pos)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        done += n;
        pos += n as u64;
    }
    Ok(())
}

#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], pos: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.read_exact_at(buf, pos)
}

/// Parallel positional reads of the source file.
const READERS: usize = 8;
/// Size of each read of a contiguous block.
const READ_PIECE: usize = 4 << 20;

/// Fills each buffer from its file offset, spreading the reads over `files`.
fn read_parallel(files: &[File], mut jobs: Vec<(u64, &mut [u8])>) -> std::io::Result<()> {
    let per = jobs.len().div_ceil(files.len()).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = jobs
            .chunks_mut(per)
            .zip(files)
            .map(|(part, f)| s.spawn(move || part.iter_mut().try_for_each(|(at, buf)| read_at(f, buf, *at))))
            .collect();
        handles.into_iter().try_for_each(|h| h.join().expect("reader thread"))
    })
}

/// Splits series into contiguous groups whose chunk fits in `budget` bytes.
fn groups(n_series: usize, chunk_len: usize, budget: usize) -> Vec<Range<usize>> {
    let per_group = (budget / (4 * chunk_len)).max(TILE);
    (0..n_series.div_ceil(per_group)).map(|g| g * per_group..((g + 1) * per_group).min(n_series)).collect()
}

/// Builds the cache of `out` at `path` (written atomically through a temporary file).
pub fn build(
    out: &OutFile,
    path: &Path,
    opts: &CacheOptions,
    progress: impl Fn(BuildProgress) + Sync,
    cancel: &AtomicBool,
) -> Result<BuildReport, OutError> {
    let t0 = Instant::now();
    if !out.meta().complete {
        return Err(OutError::Incomplete);
    }
    let layout = *out.layout();
    let n_periods = out.n_periods();
    let n_series = layout.values_per_period();
    let chunk_len = opts.chunk_len.clamp(16, 1 << 20).min(n_periods.max(1));
    let n_chunks = n_periods.div_ceil(chunk_len);
    let bpp = layout.bytes_per_period() as usize;
    let fingerprint = Fingerprint::of(out)?;
    // Raw block, transposed tiles and compressed output live at the same time.
    let groups = groups(n_series, chunk_len, opts.memory_budget / 3);
    let single = groups.len() == 1;

    let tmp = path.with_extension("swcache.tmp");
    let io = |e| OutError::io(&tmp, e);
    let file = File::create(&tmp).map_err(io)?;
    let mut w = BufWriter::with_capacity(4 << 20, file);
    w.write_all(&[0u8; HEADER_BYTES as usize]).map_err(io)?;
    let mut offset = HEADER_BYTES;
    let mut index = vec![0u8; n_series * n_chunks * ENTRY_BYTES];
    let mut constant_chunks = 0u64;
    let total = n_periods as u64 * bpp as u64;
    let done = AtomicU64::new(0);
    let read_ns = AtomicU64::new(0);
    let mut encode_time = Duration::ZERO;
    let mut write_time = Duration::ZERO;

    let result = std::thread::scope(|scope| -> Result<(), OutError> {
        let (tx, rx) = crossbeam_channel::bounded::<Result<Block, OutError>>(1);
        // Block buffers go back to the reader once encoded: allocating and zeroing a fresh
        // buffer per block costs as much as reading it.
        let (free_tx, free_rx) = crossbeam_channel::unbounded::<Vec<u8>>();
        for _ in 0..3 {
            let _ = free_tx.send(Vec::new());
        }
        let src = out.path().to_path_buf();
        let groups_ref = &groups;
        let read_ns = &read_ns;
        scope.spawn(move || {
            let send = |b| tx.send(b).is_ok();
            // Several handles read in parallel: one synchronous read at a time leaves the
            // SSD idle between requests (strided reads of the many-objects layout).
            let files: Vec<File> = match (0..READERS).map(|_| File::open(&src)).collect() {
                Ok(f) => f,
                Err(e) => {
                    send(Err(OutError::io(&src, e)));
                    return;
                }
            };
            for c in 0..n_chunks {
                let p0 = c * chunk_len;
                let rows = chunk_len.min(n_periods - p0);
                for g in groups_ref {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(mut buf) = free_rx.recv() else { return };
                    let tr = Instant::now();
                    let block = if single {
                        buf.resize(rows * bpp, 0);
                        let base = layout.period_offset(p0);
                        let jobs = buf
                            .chunks_mut(READ_PIECE)
                            .enumerate()
                            .map(|(i, piece)| (base + (i * READ_PIECE) as u64, piece))
                            .collect();
                        read_parallel(&files, jobs).map(|_| Block {
                            chunk: c,
                            series: g.clone(),
                            rows,
                            buf,
                            stride: bpp,
                            offset: 8,
                        })
                    } else {
                        let width = 4 * g.len();
                        buf.resize(rows * width, 0);
                        let jobs = buf
                            .chunks_mut(width)
                            .enumerate()
                            .map(|(r, row)| (layout.period_offset(p0 + r) + 8 + 4 * g.start as u64, row))
                            .collect();
                        read_parallel(&files, jobs).map(|_| Block {
                            chunk: c,
                            series: g.clone(),
                            rows,
                            buf,
                            stride: width,
                            offset: 0,
                        })
                    };
                    read_ns.fetch_add(tr.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    if !send(block.map_err(|e| OutError::io(&src, e))) {
                        return;
                    }
                }
            }
        });

        for block in rx {
            let b = block?;
            if cancel.load(Ordering::Relaxed) {
                return Err(OutError::Cancelled);
            }
            let local = b.series.len();
            let te = Instant::now();
            let encoded: Vec<(ChunkEntry, Vec<u8>)> = (0..local.div_ceil(TILE))
                .into_par_iter()
                .flat_map_iter(|t| {
                    let s0 = t * TILE;
                    let n = TILE.min(local - s0);
                    TILE_BUF.with(|t| {
                        let tile = &mut *t.borrow_mut();
                        tile.resize(n * b.rows, 0.0);
                        for r in 0..b.rows {
                            let row = &b.buf[b.offset + r * b.stride + 4 * s0..][..4 * n];
                            for (j, v) in row.chunks_exact(4).enumerate() {
                                tile[j * b.rows + r] = f32::from_le_bytes(v.try_into().unwrap());
                            }
                        }
                        (0..n)
                            .map(|j| encode_chunk(&tile[j * b.rows..(j + 1) * b.rows], opts.level))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            encode_time += te.elapsed();
            let tw = Instant::now();
            for (j, (mut entry, payload)) in encoded.into_iter().enumerate() {
                let s = b.series.start + j;
                entry.offset = offset;
                if entry.encoding == ENC_CONSTANT {
                    constant_chunks += 1;
                } else {
                    w.write_all(&payload).map_err(io)?;
                    offset += payload.len() as u64;
                }
                let at = (s * n_chunks + b.chunk) * ENTRY_BYTES;
                entry.encode(&mut index[at..at + ENTRY_BYTES]);
            }
            write_time += tw.elapsed();
            let _ = free_tx.send(b.buf);
            let d = done.fetch_add((b.rows * 4 * local) as u64, Ordering::Relaxed) + (b.rows * 4 * local) as u64;
            progress(BuildProgress {
                bytes_done: d * total / (n_periods as u64 * 4 * n_series as u64).max(1),
                bytes_total: total,
            });
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(OutError::Cancelled);
        }
        Ok(())
    });
    if let Err(e) = result {
        drop(w);
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    let header = Header {
        chunk_len: chunk_len as u32,
        n_periods: n_periods as u64,
        n_series: n_series as u64,
        n_chunks: n_chunks as u64,
        source: fingerprint,
        index_offset: offset,
        level: opts.level,
    };
    w.write_all(&index).map_err(io)?;
    let mut file = w.into_inner().map_err(|e| io(e.into_error()))?;
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    file.write_all(&header.encode()).map_err(io)?;
    file.sync_all().map_err(io)?;
    let cache_bytes = file.seek(SeekFrom::End(0)).map_err(io)?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| OutError::io(path, e))?;
    Ok(BuildReport {
        source_bytes: out.bytes().len() as u64,
        cache_bytes,
        n_series,
        n_chunks,
        constant_chunks,
        seconds: t0.elapsed().as_secs_f64(),
        read_seconds: read_ns.load(Ordering::Relaxed) as f64 * 1e-9,
        encode_seconds: encode_time.as_secs_f64(),
        write_seconds: write_time.as_secs_f64(),
    })
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
        let index_len = header.n_series * header.n_chunks * ENTRY_BYTES as u64;
        if header.index_offset + index_len != map.len() as u64 {
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
        let payload = &self.map[e.offset as usize..e.offset as usize + e.clen as usize];
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
        let mut s =
            SeriesStats { min: f32::INFINITY, max: f32::NEG_INFINITY, argmax: 0, mean: 0.0, sum: 0.0, nonzero: 0 };
        for c in 0..self.n_chunks() {
            let e = self.entry(series, c);
            s.min = s.min.min(e.min);
            if e.max > s.max {
                s.max = e.max;
                s.argmax = c * self.chunk_len() + e.argmax as usize;
            }
            s.sum += e.sum;
            s.nonzero += e.nonzero as u64;
        }
        s.mean = s.sum / self.n_periods().max(1) as f64;
        s
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
        assert_eq!(groups(10, 4096, 1 << 30), vec![0..10]);
        let g = groups(1_000_000, 4096, 256 << 20);
        assert_eq!(g.len(), 62);
        assert_eq!(g.last().unwrap().end, 1_000_000);
    }
}
