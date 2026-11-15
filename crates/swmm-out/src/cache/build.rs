//! Building the cache from a `.out` file in one sequential pass.

use std::cell::RefCell;
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rayon::prelude::*;

use super::codec::*;
use super::CacheOptions;
use crate::reader::OutFile;
use crate::OutError;

/// Series transposed together (cache-friendly gather from period rows).
const TILE: usize = 64;

thread_local! {
    /// Per-thread transposition buffer (see the scratch buffers of the codec).
    static TILE_BUF: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

/// File a cache is written to before it takes its name: one per build (process and
/// build number), so that two builds of the same cache never write over each other.
fn temp_path(path: &Path) -> std::path::PathBuf {
    static BUILDS: AtomicU64 = AtomicU64::new(0);
    let n = BUILDS.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("swcache.{}-{n}.tmp", std::process::id()))
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
pub(super) fn groups(n_series: usize, chunk_len: usize, budget: usize) -> Vec<Range<usize>> {
    let per_group = (budget / (4 * chunk_len)).max(TILE);
    (0..n_series.div_ceil(per_group)).map(|g| g * per_group..((g + 1) * per_group).min(n_series)).collect()
}

/// Builds the cache of `out` at `path` (written atomically through a temporary file). For
/// a file the simulation did not finish, it holds the periods written; the fingerprint
/// makes it stale once the file changes.
pub fn build(
    out: &OutFile,
    path: &Path,
    opts: &CacheOptions,
    progress: impl Fn(BuildProgress) + Sync,
    cancel: &AtomicBool,
) -> Result<BuildReport, OutError> {
    let t0 = Instant::now();
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

    let tmp = temp_path(path);
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
                // In 128 bits: the product overflows 64 bits for files above about 4 GB.
                bytes_done: (d as u128 * total as u128 / (n_periods as u128 * 4 * n_series as u128).max(1)) as u64,
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
    // Index and header, then the file takes its name: a failure leaves no partial cache.
    let finish = || -> Result<u64, OutError> {
        w.write_all(&index).map_err(io)?;
        let mut file = w.into_inner().map_err(|e| io(e.into_error()))?;
        file.seek(SeekFrom::Start(0)).map_err(io)?;
        file.write_all(&header.encode()).map_err(io)?;
        file.sync_all().map_err(io)?;
        let cache_bytes = file.seek(SeekFrom::End(0)).map_err(io)?;
        drop(file);
        // An older cache is replaced; where that is refused (Windows, while it is still
        // mapped by another reader) it is removed first.
        if std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&tmp, path).map_err(|e| OutError::io(path, e))?;
        }
        Ok(cache_bytes)
    };
    let cache_bytes = finish().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
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
