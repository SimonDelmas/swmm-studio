//! On-disk encoding of the cache: header, chunk summaries and chunk payloads.

use std::cell::RefCell;

use xxhash_rust::xxh3::Xxh3;

use super::SeriesStats;
use crate::reader::OutFile;
use crate::OutError;

pub(super) const MAGIC: &[u8; 8] = b"SWCACHE1";
pub(super) const FORMAT_VERSION: u32 = 1;
pub(super) const HEADER_BYTES: u64 = 128;
pub(super) const ENTRY_BYTES: usize = 40;
/// Series transposed together (cache-friendly gather from period rows).
pub(super) const TILE: usize = 64;

pub(super) const ENC_ZSTD: u8 = 0;
pub(super) const ENC_CONSTANT: u8 = 1;

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
        // The time the file had when it was opened: size and hash are those of that moment.
        let mtime_ns = out.modified_ns();
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
pub(super) struct Header {
    pub(super) chunk_len: u32,
    pub(super) n_periods: u64,
    pub(super) n_series: u64,
    pub(super) n_chunks: u64,
    pub(super) source: Fingerprint,
    pub(super) index_offset: u64,
    pub(super) level: i32,
}

impl Header {
    pub(super) fn encode(&self) -> [u8; HEADER_BYTES as usize] {
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

    pub(super) fn decode(b: &[u8]) -> Option<Header> {
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
    pub(super) offset: u64,
    pub(super) clen: u32,
    pub(super) encoding: u8,
    pub min: f32,
    pub max: f32,
    /// Index of the (first) maximum within the chunk.
    pub argmax: u32,
    pub sum: f64,
    /// Values different from zero.
    pub nonzero: u32,
}

impl ChunkEntry {
    pub(super) fn encode(&self, b: &mut [u8]) {
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

    pub(super) fn decode(b: &[u8]) -> ChunkEntry {
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

thread_local! {
    pub(super) static COMPRESSOR: RefCell<Option<(i32, zstd::bulk::Compressor<'static>)>> = const { RefCell::new(None) };
    pub(super) static DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
    /// Per-thread buffers: fresh large allocations page-fault on every use, and Windows
    /// serializes page faults across threads.
    pub(super) static SCRATCH: RefCell<(Vec<u8>, Vec<u8>)> = const { RefCell::new((Vec::new(), Vec::new())) };
    pub(super) static TILE_BUF: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

/// Encodes one chunk; returns the summary (offset left at 0) and the payload.
pub(super) fn encode_chunk(values: &[f32], level: i32) -> (ChunkEntry, Vec<u8>) {
    let stats = SeriesStats::of(values);
    // No value compared below / above the start values: the chunk is all NaN (or all
    // +inf / -inf). Infinite values among finite ones are real extremes and are kept.
    let min = if stats.min == f32::INFINITY { values[0] } else { stats.min };
    let max = if stats.max == f32::NEG_INFINITY { values[0] } else { stats.max };
    let mut entry = ChunkEntry {
        offset: 0,
        clen: 0,
        encoding: ENC_CONSTANT,
        min,
        max,
        argmax: stats.argmax as u32,
        sum: stats.sum,
        nonzero: stats.nonzero as u32,
    };
    let first = values[0].to_bits();
    if values.iter().all(|v| v.to_bits() == first) {
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

pub(super) fn decode_chunk(entry: &ChunkEntry, payload: &[u8], n: usize, out: &mut Vec<f32>) -> Result<(), OutError> {
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
