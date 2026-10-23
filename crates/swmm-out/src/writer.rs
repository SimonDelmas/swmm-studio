//! Writes valid `.out` files, byte-compatible with SWMM 5.2 (`output.c`).
//!
//! Used by the synthetic data generator and by tests.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use crate::format::{ElementKind, FlowUnits, LinkType, NodeType, MAGIC};
use crate::reader::Layout;
use crate::OutError;

/// Static content of a file to write.
#[derive(Debug, Clone)]
pub struct OutSpec {
    pub version: i32,
    pub flow_units: FlowUnits,
    pub subcatchments: Vec<String>,
    pub subcatch_area: Vec<f32>,
    pub nodes: Vec<String>,
    pub node_type: Vec<NodeType>,
    pub node_invert: Vec<f32>,
    pub node_max_depth: Vec<f32>,
    pub links: Vec<String>,
    pub link_type: Vec<LinkType>,
    /// Offset 1, offset 2, max depth, length per link.
    pub link_props: Vec<[f32; 4]>,
    pub pollutants: Vec<String>,
    pub pollutant_units: Vec<i32>,
    /// SWMM date one report step before the first period.
    pub start_date: f64,
    pub report_step_secs: i32,
}

impl OutSpec {
    /// A spec with `n` objects of each kind named `S1…`, `N1…`, `L1…`, no pollutants.
    pub fn simple(nsub: usize, nnode: usize, nlink: usize, start_date: f64, report_step_secs: i32) -> OutSpec {
        let ids = |p: &str, n: usize| (1..=n).map(|i| format!("{p}{i}")).collect::<Vec<_>>();
        OutSpec {
            version: 52004,
            flow_units: FlowUnits::Cms,
            subcatchments: ids("S", nsub),
            subcatch_area: vec![1.0; nsub],
            nodes: ids("N", nnode),
            node_type: (0..nnode)
                .map(|i| if i + 1 == nnode { NodeType::Outfall } else { NodeType::Junction })
                .collect(),
            node_invert: (0..nnode).map(|i| 100.0 - i as f32 * 0.05).collect(),
            node_max_depth: vec![3.0; nnode],
            links: ids("L", nlink),
            link_type: vec![LinkType::Conduit; nlink],
            link_props: vec![[0.0, 0.0, 1.0, 50.0]; nlink],
            pollutants: Vec::new(),
            pollutant_units: Vec::new(),
            start_date,
            report_step_secs,
        }
    }

    pub fn nvars(&self) -> [usize; 4] {
        let p = self.pollutants.len();
        [
            ElementKind::Subcatchment.base_variables().len() + p,
            ElementKind::Node.base_variables().len() + p,
            ElementKind::Link.base_variables().len() + p,
            ElementKind::System.base_variables().len(),
        ]
    }
}

/// Streaming writer: header on creation, one call per period, epilogue on [`OutWriter::finish`].
pub struct OutWriter {
    file: BufWriter<File>,
    layout: Layout,
    id_pos: u64,
    input_pos: u64,
    periods: usize,
    path: std::path::PathBuf,
    scratch: Vec<u8>,
}

fn w_i32(w: &mut impl Write, v: i32) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

fn w_f32(w: &mut impl Write, v: f32) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

fn count(n: usize) -> i32 {
    i32::try_from(n).expect("object count fits in i32")
}

impl OutWriter {
    pub fn create(path: impl AsRef<Path>, spec: &OutSpec) -> Result<OutWriter, OutError> {
        let path = path.as_ref().to_path_buf();
        let io = |e| OutError::io(&path, e);
        let file = File::create(&path).map_err(io)?;
        let mut w = BufWriter::with_capacity(8 << 20, file);
        let nvars = spec.nvars();
        let (id_pos, input_pos, output_start) = Self::header(&mut w, spec, nvars).map_err(io)?;
        let layout =
            Layout { output_start, counts: [spec.subcatchments.len(), spec.nodes.len(), spec.links.len(), 1], nvars };
        Ok(OutWriter { file: w, layout, id_pos, input_pos, periods: 0, path, scratch: Vec::new() })
    }

    fn header(w: &mut BufWriter<File>, s: &OutSpec, nvars: [usize; 4]) -> std::io::Result<(u64, u64, u64)> {
        for v in [
            MAGIC,
            s.version,
            s.flow_units.code(),
            count(s.subcatchments.len()),
            count(s.nodes.len()),
            count(s.links.len()),
            count(s.pollutants.len()),
        ] {
            w_i32(w, v)?;
        }
        let id_pos = w.stream_position()?;
        for id in s.subcatchments.iter().chain(&s.nodes).chain(&s.links).chain(&s.pollutants) {
            w_i32(w, count(id.len()))?;
            w.write_all(id.as_bytes())?;
        }
        for &u in &s.pollutant_units {
            w_i32(w, u)?;
        }
        let input_pos = w.stream_position()?;
        // Input properties, same codes as output.c (INPUT_AREA = 1, TYPE = 0, INVERT = 2, MAX_DEPTH = 3, OFFSET = 4, LENGTH = 5).
        for v in [1, 1] {
            w_i32(w, v)?;
        }
        for &a in &s.subcatch_area {
            w_f32(w, a)?;
        }
        for v in [3, 0, 2, 3] {
            w_i32(w, v)?;
        }
        for i in 0..s.nodes.len() {
            w_i32(w, s.node_type[i].code())?;
            w_f32(w, s.node_invert[i])?;
            w_f32(w, s.node_max_depth[i])?;
        }
        for v in [5, 0, 4, 4, 3, 5] {
            w_i32(w, v)?;
        }
        for i in 0..s.links.len() {
            w_i32(w, s.link_type[i].code())?;
            for p in s.link_props[i] {
                w_f32(w, p)?;
            }
        }
        // Variable codes: subcatchment washoff codes start at 8, node quality at 6, link quality at 5.
        for n in nvars {
            w_i32(w, count(n))?;
            for k in 0..n {
                w_i32(w, count(k))?;
            }
        }
        w.write_all(&s.start_date.to_le_bytes())?;
        w_i32(w, s.report_step_secs)?;
        let output_start = w.stream_position()?;
        Ok((id_pos, input_pos, output_start))
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// Appends one period. `values` holds all values in file order
    /// (see [`Layout::series`]); its length must be [`Layout::values_per_period`].
    pub fn write_period(&mut self, date: f64, values: &[f32]) -> Result<(), OutError> {
        assert_eq!(values.len(), self.layout.values_per_period(), "wrong number of values for one period");
        let io = |e| OutError::io(&self.path, e);
        self.file.write_all(&date.to_le_bytes()).map_err(io)?;
        // f32 slices are little-endian on all supported targets (x86_64 / aarch64 Windows).
        self.scratch.clear();
        self.scratch.extend(values.iter().flat_map(|v| v.to_le_bytes()));
        self.file.write_all(&self.scratch).map_err(io)?;
        self.periods += 1;
        Ok(())
    }

    /// Writes the epilogue and flushes. Returns the number of periods written.
    pub fn finish(mut self, error_code: i32) -> Result<usize, OutError> {
        let path = self.path.clone();
        let io = |e| OutError::io(&path, e);
        // output.c writes the positions as 4-byte integers.
        for v in [
            self.id_pos as i32,
            self.input_pos as i32,
            self.layout.output_start as i32,
            count(self.periods),
            error_code,
            MAGIC,
        ] {
            w_i32(&mut self.file, v).map_err(io)?;
        }
        self.file.flush().map_err(io)?;
        let end = self.file.seek(SeekFrom::End(0)).map_err(io)?;
        debug_assert_eq!(end, self.layout.output_start + self.periods as u64 * self.layout.bytes_per_period() + 24);
        Ok(self.periods)
    }
}
