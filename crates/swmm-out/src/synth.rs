//! Synthetic `.out` generator for tests and benchmarks.
//!
//! Values follow a crude but plausible hydrology: random rain events drive a set of
//! lagged responses (fast urban runoff to slow RDII), objects pick one response and a
//! scale, links carry a daily dry-weather pattern. Most rain/flooding values are zero,
//! like in real continuous simulations, so compression ratios are representative.

use std::path::Path;

use chrono::{NaiveDateTime, TimeDelta};

use crate::format::{self, ElementKind};
use crate::writer::{OutSpec, OutWriter};
use crate::OutError;

#[derive(Debug, Clone)]
pub struct SynthSpec {
    pub subcatchments: usize,
    pub nodes: usize,
    pub links: usize,
    pub periods: usize,
    pub report_step_secs: i32,
    pub start: NaiveDateTime,
    pub seed: u64,
}

impl SynthSpec {
    /// Size of the generated file in bytes.
    pub fn file_size(&self) -> u64 {
        let spec = OutSpec::simple(self.subcatchments, self.nodes, self.links, 0.0, self.report_step_secs);
        let nv = spec.nvars();
        let per = 8 + 4 * (self.subcatchments * nv[0] + self.nodes * nv[1] + self.links * nv[2] + nv[3]) as u64;
        // Header size is approximate (IDs), but small.
        per * self.periods as u64 + 1024 + 32 * (self.subcatchments + self.nodes + self.links) as u64
    }
}

/// xorshift64*: deterministic, dependency-free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in [0, 1).
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
}

const RESPONSES: usize = 8;

struct Object {
    response: usize,
    scale: f32,
    base: f32,
}

fn objects(rng: &mut Rng, n: usize) -> Vec<Object> {
    (0..n)
        .map(|_| Object {
            response: (rng.next() % RESPONSES as u64) as usize,
            scale: 0.05 + rng.unit() * 2.0,
            base: rng.unit() * 0.02,
        })
        .collect()
}

/// Writes a synthetic file. `progress` is called with the number of periods written.
pub fn generate(path: impl AsRef<Path>, s: &SynthSpec, mut progress: impl FnMut(usize)) -> Result<(), OutError> {
    let mut rng = Rng(s.seed.max(1));
    let step = s.report_step_secs as f64;
    let start_date = format::from_datetime(s.start) - step / 86_400.0;
    let spec = OutSpec::simple(s.subcatchments, s.nodes, s.links, start_date, s.report_step_secs);
    let mut w = OutWriter::create(path, &spec)?;
    let layout = *w.layout();
    let nv = layout.nvars;

    let subs = objects(&mut rng, s.subcatchments);
    let nodes = objects(&mut rng, s.nodes);
    let links = objects(&mut rng, s.links);
    // Time constants from 15 min to ~2 days (RDII-like).
    let taus: Vec<f64> = (0..RESPONSES).map(|k| 900.0 * 1.9f64.powi(k as i32)).collect();
    let mut resp = [0.0f64; RESPONSES];
    let mut values = vec![0.0f32; layout.values_per_period()];

    // Rain events: dry spells, then storms of 1-12 h with a triangular hyetograph.
    let mut rain_left = 0usize;
    let mut rain_len = 0usize;
    let mut rain_peak = 0.0f32;
    let mut dry_left = 0usize;

    let sub0 = layout.kind_start(ElementKind::Subcatchment);
    let node0 = layout.kind_start(ElementKind::Node);
    let link0 = layout.kind_start(ElementKind::Link);
    let sys0 = layout.kind_start(ElementKind::System);

    for p in 0..s.periods {
        let t = (p as f64 + 1.0) * step;
        if rain_left == 0 && dry_left == 0 {
            if rng.unit() < 0.1 {
                rain_len = ((1.0 + rng.unit() as f64 * 11.0) * 3600.0 / step).max(1.0) as usize;
                rain_left = rain_len;
                rain_peak = 1.0 + rng.unit().powi(3) * 60.0;
            } else {
                dry_left = ((6.0 + rng.unit() as f64 * 120.0) * 3600.0 / step) as usize;
            }
        }
        let rain = if rain_left > 0 {
            let x = 1.0 - (2.0 * (rain_len - rain_left) as f32 / rain_len as f32 - 1.0).abs();
            rain_left -= 1;
            rain_peak * x
        } else {
            dry_left = dry_left.saturating_sub(1);
            0.0
        };
        for (k, r) in resp.iter_mut().enumerate() {
            let a = (step / taus[k]).min(1.0);
            *r += (rain as f64 / 30.0 - *r) * a;
            if *r < 1e-7 {
                *r = 0.0;
            }
        }
        let hour = (t / 3600.0) % 24.0;
        let dwf = (1.0 + 0.5 * (std::f64::consts::TAU * (hour - 6.0) / 24.0).sin()) as f32;

        for (i, o) in subs.iter().enumerate() {
            let v = &mut values[sub0 + i * nv[0]..sub0 + (i + 1) * nv[0]];
            let r = resp[o.response] as f32;
            v[0] = rain;
            v[1] = 0.0;
            v[2] = 2.0;
            v[3] = rain.min(5.0 + 10.0 * o.base);
            v[4] = o.scale * r;
            v[5] = 0.0;
            v[6] = 0.0;
            v[7] = 0.3 + r.min(0.2);
        }
        for (i, o) in nodes.iter().enumerate() {
            let v = &mut values[node0 + i * nv[1]..node0 + (i + 1) * nv[1]];
            let r = resp[o.response] as f32;
            let depth = (o.base * dwf + o.scale * r).min(3.0);
            v[0] = depth;
            v[1] = spec.node_invert[i] + depth;
            v[2] = depth * 1.2;
            v[3] = if i % 3 == 0 { o.scale * r * 0.5 } else { 0.0 };
            v[4] = o.base * dwf + o.scale * r;
            v[5] = (o.scale * r - 1.5).max(0.0);
        }
        for (i, o) in links.iter().enumerate() {
            let v = &mut values[link0 + i * nv[2]..link0 + (i + 1) * nv[2]];
            let r = resp[o.response] as f32;
            let flow = o.base * dwf + o.scale * r;
            let depth = (0.05 + flow.sqrt() * 0.6).min(1.0);
            v[0] = flow;
            v[1] = depth;
            v[2] = 0.3 + flow.sqrt();
            v[3] = depth * 40.0;
            v[4] = depth;
        }
        let sys = &mut values[sys0..sys0 + nv[3]];
        sys.fill(0.0);
        sys[0] = 15.0 + 8.0 * ((hour - 14.0) / 24.0 * std::f64::consts::TAU).cos() as f32;
        sys[1] = rain;
        sys[4] = resp[0] as f32 * s.subcatchments as f32 * 0.1;
        sys[5] = dwf * 0.01 * s.links as f32;
        sys[7] = resp[RESPONSES - 1] as f32;
        sys[9] = sys[4] + sys[5] + sys[7];
        sys[11] = sys[9];
        sys[13] = 2.0;
        sys[14] = 3.0;

        w.write_period(start_date + t / 86_400.0, &values)?;
        if p % 1024 == 1023 {
            progress(p + 1);
        }
    }
    w.finish(0)?;
    progress(s.periods);
    Ok(())
}

/// A SWMM model matching a synthetic results file: same IDs (`S1…`, `N1…`, `L1…`),
/// nodes on a grid (`spacing` apart, starting at `origin`), links along the rows then
/// down the columns, one square subcatchment per node. Used to test viewers at scale.
pub fn model_inp(s: &SynthSpec, origin: [f64; 2], spacing: f64) -> String {
    use std::fmt::Write;
    let cols = (s.nodes as f64).sqrt().ceil().max(1.0) as usize;
    let xy = |i: usize| (origin[0] + (i % cols) as f64 * spacing, origin[1] - (i / cols) as f64 * spacing);
    let mut t = String::new();
    let dt = |d: NaiveDateTime| d.format("%m/%d/%Y").to_string();
    let tm = |d: NaiveDateTime| d.format("%H:%M:%S").to_string();
    let step = TimeDelta::seconds(s.report_step_secs as i64);
    let end = s.start + step * s.periods as i32;
    let rs = s.report_step_secs;
    let _ = writeln!(
        t,
        "[TITLE]\nSynthetic network: {} nodes, {} links, {} subcatchments\n",
        s.nodes, s.links, s.subcatchments
    );
    let _ = writeln!(
        t,
        "[OPTIONS]\nFLOW_UNITS CMS\nSTART_DATE {}\nSTART_TIME {}\nREPORT_START_DATE {}\nREPORT_START_TIME {}\nEND_DATE {}\nEND_TIME {}\nREPORT_STEP {:02}:{:02}:{:02}\n",
        dt(s.start),
        tm(s.start),
        dt(s.start),
        tm(s.start),
        dt(end),
        tm(end),
        rs / 3600,
        rs / 60 % 60,
        rs % 60
    );
    let _ = writeln!(t, "[RAINGAGES]\nRG1 INTENSITY 0:05 1.0 TIMESERIES TS1\n");
    t.push_str("[SUBCATCHMENTS]\n");
    for i in 0..s.subcatchments {
        let _ = writeln!(t, "S{} RG1 N{} 1 50 100 1 0", i + 1, i % s.nodes.max(1) + 1);
    }
    t.push_str("\n[JUNCTIONS]\n");
    for i in 0..s.nodes.saturating_sub(1) {
        let _ = writeln!(t, "N{} {:.2} 3 0 0 0", i + 1, 100.0 - i as f64 * 0.05);
    }
    if s.nodes > 0 {
        let _ = writeln!(t, "\n[OUTFALLS]\nN{} {:.2} FREE NO", s.nodes, 100.0 - (s.nodes - 1) as f64 * 0.05);
    }
    // Links: along each row, then down the first column, then extra cross links.
    let mut pairs = Vec::with_capacity(s.links);
    for i in 0..s.nodes.saturating_sub(1) {
        if (i + 1) % cols != 0 {
            pairs.push((i, i + 1));
        }
    }
    for r in 0..s.nodes / cols {
        if (r + 1) * cols < s.nodes {
            pairs.push((r * cols, (r + 1) * cols));
        }
    }
    let mut k = 0;
    while pairs.len() < s.links && s.nodes > cols {
        pairs.push((k % (s.nodes - cols), k % (s.nodes - cols) + cols));
        k += 1;
    }
    pairs.truncate(s.links);
    t.push_str("\n[CONDUITS]\n");
    for (i, (a, b)) in pairs.iter().enumerate() {
        let _ = writeln!(t, "L{} N{} N{} {spacing} 0.013 0 0 0 0", i + 1, a + 1, b + 1);
    }
    t.push_str("\n[XSECTIONS]\n");
    for i in 0..pairs.len() {
        let _ = writeln!(t, "L{} CIRCULAR {} 0 0 0 1", i + 1, [0.3, 0.4, 0.6, 0.8, 1.0][i % 5]);
    }
    t.push_str("\n[TIMESERIES]\nTS1 0 0\nTS1 1 10\nTS1 2 0\n\n[COORDINATES]\n");
    for i in 0..s.nodes {
        let (x, y) = xy(i);
        let _ = writeln!(t, "N{} {x:.2} {y:.2}", i + 1);
    }
    t.push_str("\n[POLYGONS]\n");
    let h = spacing * 0.35;
    for i in 0..s.subcatchments {
        let (x, y) = xy(i % s.nodes.max(1));
        let (x, y) = (x + spacing / 2.0, y - spacing / 2.0);
        for (dx, dy) in [(-h, -h), (h, -h), (h, h), (-h, h)] {
            let _ = writeln!(t, "S{} {:.2} {:.2}", i + 1, x + dx, y + dy);
        }
    }
    let _ = writeln!(t, "\n[SYMBOLS]\nRG1 {:.2} {:.2}", origin[0] - spacing, origin[1] + spacing);
    t
}
