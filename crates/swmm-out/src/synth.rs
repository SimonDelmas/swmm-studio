//! Synthetic `.out` generator for tests and benchmarks.
//!
//! Values follow a crude but plausible hydrology: random rain events drive a set of
//! lagged responses (fast urban runoff to slow RDII), objects pick one response and a
//! scale, links carry a daily dry-weather pattern. Most rain/flooding values are zero,
//! like in real continuous simulations, so compression ratios are representative.

use std::path::Path;

use chrono::NaiveDateTime;

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
