//! Memory-mapped reader for `.out` files of any size.

use std::collections::HashMap;
use std::fs::File;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{NaiveDateTime, TimeDelta};
use memmap2::Mmap;

use crate::format::{self, ElementKind, FlowUnits, LinkType, NodeType, EPILOGUE_BYTES, HEADER_BYTES, MAGIC};
use crate::OutError;

/// Byte layout of the results section, shared by the reader, writer and cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub output_start: u64,
    /// Objects per kind (system = 1).
    pub counts: [usize; 4],
    /// Variables per kind.
    pub nvars: [usize; 4],
}

impl Layout {
    pub fn values_per_period(&self) -> usize {
        (0..4).map(|k| self.counts[k] * self.nvars[k]).sum()
    }

    /// Date (8 bytes) + all values.
    pub fn bytes_per_period(&self) -> u64 {
        8 + 4 * self.values_per_period() as u64
    }

    /// Index of the first value of `kind` within a period's value block.
    pub fn kind_start(&self, kind: ElementKind) -> usize {
        (0..kind as usize).map(|k| self.counts[k] * self.nvars[k]).sum()
    }

    /// Global series index: the position of the value inside a period, so series are
    /// numbered in file order (subcatchments, nodes, links, system; object-major).
    pub fn series(&self, kind: ElementKind, obj: usize, var: usize) -> usize {
        self.kind_start(kind) + obj * self.nvars[kind as usize] + var
    }

    /// Inverse of [`Layout::series`].
    pub fn locate(&self, series: usize) -> Option<(ElementKind, usize, usize)> {
        let mut start = 0;
        for kind in ElementKind::ALL {
            let n = self.counts[kind as usize] * self.nvars[kind as usize];
            if series < start + n {
                let local = series - start;
                let nv = self.nvars[kind as usize];
                return Some((kind, local / nv, local % nv));
            }
            start += n;
        }
        None
    }

    pub fn period_offset(&self, period: usize) -> u64 {
        self.output_start + period as u64 * self.bytes_per_period()
    }
}

/// Everything stored in the file besides the results themselves.
#[derive(Debug, Clone, PartialEq)]
pub struct OutMeta {
    pub version: i32,
    pub flow_units: FlowUnits,
    pub subcatchments: Vec<String>,
    pub nodes: Vec<String>,
    pub links: Vec<String>,
    pub pollutants: Vec<String>,
    pub pollutant_units: Vec<i32>,
    pub subcatch_area: Vec<f32>,
    pub node_type: Vec<NodeType>,
    pub node_invert: Vec<f32>,
    pub node_max_depth: Vec<f32>,
    pub link_type: Vec<LinkType>,
    pub link_offset1: Vec<f32>,
    pub link_offset2: Vec<f32>,
    pub link_max_depth: Vec<f32>,
    pub link_length: Vec<f32>,
    /// Variable codes per kind, as written in the file.
    pub var_codes: [Vec<i32>; 4],
    /// Raw SWMM date one report step before the first period.
    pub start_date: f64,
    pub report_step_secs: i32,
    pub n_periods: usize,
    pub error_code: i32,
    /// `false` when the epilogue is missing (simulation running or crashed): the number of
    /// periods is then derived from the file size.
    pub complete: bool,
    pub layout: Layout,
}

impl OutMeta {
    pub fn ids(&self, kind: ElementKind) -> &[String] {
        static SYSTEM: OnceLock<Vec<String>> = OnceLock::new();
        match kind {
            ElementKind::Subcatchment => &self.subcatchments,
            ElementKind::Node => &self.nodes,
            ElementKind::Link => &self.links,
            ElementKind::System => SYSTEM.get_or_init(|| vec!["system".to_string()]),
        }
    }

    pub fn count(&self, kind: ElementKind) -> usize {
        self.layout.counts[kind as usize]
    }

    pub fn nvars(&self, kind: ElementKind) -> usize {
        self.layout.nvars[kind as usize]
    }

    /// Variable names: fixed variables, then one per pollutant (`washoff_<p>` for subcatchments).
    pub fn var_names(&self, kind: ElementKind) -> Vec<String> {
        let base = kind.base_variables();
        (0..self.nvars(kind))
            .map(|v| match base.get(v) {
                Some(n) => n.to_string(),
                None => {
                    let p = self.pollutants.get(v - base.len()).map_or("pollutant", String::as_str);
                    if kind == ElementKind::Subcatchment {
                        format!("washoff_{p}")
                    } else {
                        p.to_string()
                    }
                }
            })
            .collect()
    }

    /// Variable index by name (case-insensitive).
    pub fn var_index(&self, kind: ElementKind, name: &str) -> Option<usize> {
        self.var_names(kind).iter().position(|n| n.eq_ignore_ascii_case(name))
    }

    pub fn report_step(&self) -> TimeDelta {
        TimeDelta::seconds(self.report_step_secs as i64)
    }

    /// Date of the first reporting step minus one step.
    pub fn start(&self) -> NaiveDateTime {
        format::to_datetime(self.start_date)
    }

    /// Time of period `p` (computed, no disk access).
    pub fn time(&self, period: usize) -> NaiveDateTime {
        self.start() + TimeDelta::seconds(self.report_step_secs as i64 * (period as i64 + 1))
    }

    /// Period index at or just before `t` (clamped to the valid range).
    pub fn period_at(&self, t: NaiveDateTime) -> usize {
        let secs = (t - self.start()).num_seconds() / self.report_step_secs.max(1) as i64 - 1;
        secs.clamp(0, self.n_periods.saturating_sub(1) as i64) as usize
    }
}

/// An opened `.out` file.
pub struct OutFile {
    path: PathBuf,
    map: Mmap,
    meta: OutMeta,
    index: [OnceLock<HashMap<String, usize>>; 4],
}

impl std::fmt::Debug for OutFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutFile").field("path", &self.path).field("meta", &self.meta.layout).finish()
    }
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn bytes(&mut self, n: usize) -> Result<&[u8], OutError> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len()).ok_or(OutError::Truncated)?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn i32(&mut self) -> Result<i32, OutError> {
        Ok(i32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }

    fn f32(&mut self) -> Result<f32, OutError> {
        Ok(f32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }

    fn f64(&mut self) -> Result<f64, OutError> {
        Ok(f64::from_le_bytes(self.bytes(8)?.try_into().unwrap()))
    }

    fn count(&mut self) -> Result<usize, OutError> {
        let n = self.i32()?;
        usize::try_from(n).map_err(|_| OutError::Corrupt(format!("negative count {n} at byte {}", self.pos - 4)))
    }

    fn id(&mut self) -> Result<String, OutError> {
        let n = self.count()?;
        Ok(String::from_utf8_lossy(self.bytes(n)?).into_owned())
    }
}

fn parse_meta(buf: &[u8]) -> Result<OutMeta, OutError> {
    let len = buf.len() as u64;
    if len < HEADER_BYTES {
        return Err(OutError::NotSwmm);
    }
    let mut c = Cursor { buf, pos: 0 };
    if c.i32()? != MAGIC {
        return Err(OutError::NotSwmm);
    }
    let version = c.i32()?;
    let flow_code = c.i32()?;
    let flow_units =
        FlowUnits::from_code(flow_code).ok_or_else(|| OutError::Corrupt(format!("flow units code {flow_code}")))?;
    let (nsub, nnode, nlink, npoll) = (c.count()?, c.count()?, c.count()?, c.count()?);

    let mut read_ids = |n: usize| (0..n).map(|_| c.id()).collect::<Result<Vec<_>, _>>();
    let subcatchments = read_ids(nsub)?;
    let nodes = read_ids(nnode)?;
    let links = read_ids(nlink)?;
    let pollutants = read_ids(npoll)?;
    let pollutant_units = (0..npoll).map(|_| c.i32()).collect::<Result<Vec<_>, _>>()?;

    // Input properties: subcatchment area, node type/invert/depth, link type/offsets/depth/length.
    let n = c.count()?;
    c.bytes(4 * n)?;
    let subcatch_area = (0..nsub).map(|_| c.f32()).collect::<Result<Vec<_>, _>>()?;
    let n = c.count()?;
    c.bytes(4 * n)?;
    let (mut node_type, mut node_invert, mut node_max_depth) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..nnode {
        node_type.push(NodeType::from_code(c.i32()?));
        node_invert.push(c.f32()?);
        node_max_depth.push(c.f32()?);
    }
    let n = c.count()?;
    c.bytes(4 * n)?;
    let mut link = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut link_type = Vec::new();
    for _ in 0..nlink {
        link_type.push(LinkType::from_code(c.i32()?));
        for v in link.iter_mut() {
            v.push(c.f32()?);
        }
    }
    let [link_offset1, link_offset2, link_max_depth, link_length] = link;

    let mut var_codes: [Vec<i32>; 4] = Default::default();
    for codes in var_codes.iter_mut() {
        let n = c.count()?;
        *codes = (0..n).map(|_| c.i32()).collect::<Result<_, _>>()?;
    }
    let start_date = c.f64()?;
    let report_step_secs = c.i32()?;
    let output_start = c.pos as u64;

    let layout = Layout {
        output_start,
        counts: [nsub, nnode, nlink, 1],
        nvars: [var_codes[0].len(), var_codes[1].len(), var_codes[2].len(), var_codes[3].len()],
    };
    let bpp = layout.bytes_per_period();

    // Epilogue (absent if the run is still going or crashed).
    let mut complete = false;
    let mut error_code = 0;
    let mut n_periods = None;
    if len >= output_start + EPILOGUE_BYTES {
        let mut e = Cursor { buf, pos: (len - EPILOGUE_BYTES) as usize };
        let (_ids, _input, out_pos, np, err, magic) = (e.i32()?, e.i32()?, e.i32()?, e.i32()?, e.i32()?, e.i32()?);
        let np = usize::try_from(np).unwrap_or(usize::MAX);
        if magic == MAGIC
            && out_pos as u32 as u64 == output_start & 0xFFFF_FFFF
            && output_start + np as u64 * bpp + EPILOGUE_BYTES == len
        {
            complete = true;
            error_code = err;
            n_periods = Some(np);
        }
    }
    let n_periods = n_periods.unwrap_or(((len - output_start) / bpp) as usize);

    Ok(OutMeta {
        version,
        flow_units,
        subcatchments,
        nodes,
        links,
        pollutants,
        pollutant_units,
        subcatch_area,
        node_type,
        node_invert,
        node_max_depth,
        link_type,
        link_offset1,
        link_offset2,
        link_max_depth,
        link_length,
        var_codes,
        start_date,
        report_step_secs,
        n_periods,
        error_code,
        complete,
        layout,
    })
}

#[inline]
fn f32_at(buf: &[u8], at: usize) -> f32 {
    f32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
}

impl OutFile {
    pub fn open(path: impl AsRef<Path>) -> Result<OutFile, OutError> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path).map_err(|e| OutError::io(&path, e))?;
        // SAFETY: the file is opened read-only; SWMM files are not modified while read
        // (a concurrent run writes a new file in another folder).
        let map = unsafe { Mmap::map(&file) }.map_err(|e| OutError::io(&path, e))?;
        let meta = parse_meta(&map)?;
        Ok(OutFile { path, map, meta, index: Default::default() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn meta(&self) -> &OutMeta {
        &self.meta
    }

    pub fn layout(&self) -> &Layout {
        &self.meta.layout
    }

    pub fn n_periods(&self) -> usize {
        self.meta.n_periods
    }

    /// Raw file bytes (for hashing and the cache builder).
    pub fn bytes(&self) -> &[u8] {
        &self.map
    }

    /// Object index by ID (case-insensitive, like SWMM).
    pub fn object_index(&self, kind: ElementKind, id: &str) -> Option<usize> {
        let map = self.index[kind as usize]
            .get_or_init(|| self.meta.ids(kind).iter().enumerate().map(|(i, s)| (s.to_ascii_uppercase(), i)).collect());
        map.get(&id.to_ascii_uppercase()).copied()
    }

    fn check(&self, kind: ElementKind, obj: usize, var: usize, period: usize) -> Result<(), OutError> {
        if obj >= self.meta.count(kind) || var >= self.meta.nvars(kind) || period >= self.meta.n_periods {
            return Err(OutError::OutOfRange { kind, obj, var, period });
        }
        Ok(())
    }

    fn value_at(&self, kind: ElementKind, obj: usize, var: usize) -> usize {
        8 + 4 * self.meta.layout.series(kind, obj, var)
    }

    /// Date stored with period `p` (reads the file; [`OutMeta::time`] is usually enough).
    pub fn stored_time(&self, period: usize) -> Result<NaiveDateTime, OutError> {
        self.check(ElementKind::System, 0, 0, period)?;
        let at = self.meta.layout.period_offset(period) as usize;
        Ok(format::to_datetime(f64::from_le_bytes(self.map[at..at + 8].try_into().unwrap())))
    }

    /// Bytes of one period (date followed by all values).
    pub fn period_bytes(&self, period: usize) -> &[u8] {
        let l = &self.meta.layout;
        let at = l.period_offset(period) as usize;
        &self.map[at..at + l.bytes_per_period() as usize]
    }

    pub fn value(&self, kind: ElementKind, obj: usize, var: usize, period: usize) -> Result<f32, OutError> {
        self.check(kind, obj, var, period)?;
        Ok(f32_at(self.period_bytes(period), self.value_at(kind, obj, var)))
    }

    /// One variable for every object of `kind` at period `p` (one contiguous read).
    pub fn frame(&self, kind: ElementKind, var: usize, period: usize) -> Result<Vec<f32>, OutError> {
        let mut out = Vec::new();
        self.frame_into(kind, var, period, &mut out)?;
        Ok(out)
    }

    pub fn frame_into(&self, kind: ElementKind, var: usize, period: usize, out: &mut Vec<f32>) -> Result<(), OutError> {
        let n = self.meta.count(kind);
        if n == 0 {
            out.clear();
            return Ok(());
        }
        self.check(kind, 0, var, period)?;
        let buf = self.period_bytes(period);
        let stride = 4 * self.meta.nvars(kind);
        let first = self.value_at(kind, 0, var);
        out.clear();
        out.extend((0..n).map(|i| f32_at(buf, first + i * stride)));
        Ok(())
    }

    /// All variables of one object at period `p`.
    pub fn object_values(&self, kind: ElementKind, obj: usize, period: usize) -> Result<Vec<f32>, OutError> {
        self.check(kind, obj, 0, period)?;
        let buf = self.period_bytes(period);
        let first = self.value_at(kind, obj, 0);
        Ok((0..self.meta.nvars(kind)).map(|v| f32_at(buf, first + 4 * v)).collect())
    }

    /// Time series read straight from the file: one 4-byte read per period.
    ///
    /// On multi-year files this touches every page of the file; prefer
    /// [`crate::Results::series`], which uses the cache when available.
    pub fn series(
        &self,
        kind: ElementKind,
        obj: usize,
        var: usize,
        periods: Range<usize>,
    ) -> Result<Vec<f32>, OutError> {
        let periods = periods.start..periods.end.min(self.meta.n_periods);
        if periods.is_empty() {
            return Ok(Vec::new());
        }
        self.check(kind, obj, var, periods.start)?;
        let l = &self.meta.layout;
        let bpp = l.bytes_per_period() as usize;
        let mut at = l.period_offset(periods.start) as usize + self.value_at(kind, obj, var);
        let mut out = Vec::with_capacity(periods.len());
        for _ in periods {
            out.push(f32_at(&self.map, at));
            at += bpp;
        }
        Ok(out)
    }
}
