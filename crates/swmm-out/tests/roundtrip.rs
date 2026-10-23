use std::sync::atomic::AtomicBool;

use chrono::NaiveDate;
use swmm_out::cache::{self, CacheOptions, ResultsCache};
use swmm_out::synth::{self, SynthSpec};
use swmm_out::{ElementKind, OutError, OutFile, OutSpec, OutWriter, Results};

fn spec(nsub: usize, nnode: usize, nlink: usize, periods: usize) -> SynthSpec {
    SynthSpec {
        subcatchments: nsub,
        nodes: nnode,
        links: nlink,
        periods,
        report_step_secs: 300,
        start: NaiveDate::from_ymd_opt(2020, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap(),
        seed: 42,
    }
}

#[test]
fn writer_reader_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.out");
    let mut s = OutSpec::simple(2, 3, 2, 36000.0, 3600);
    s.pollutants = vec!["TSS".into()];
    s.pollutant_units = vec![0];
    let mut w = OutWriter::create(&path, &s).unwrap();
    let layout = *w.layout();
    assert_eq!(layout.nvars, [9, 7, 6, 15]);
    let n = layout.values_per_period();
    for p in 0..5 {
        let values: Vec<f32> = (0..n).map(|i| (p * 1000 + i) as f32).collect();
        w.write_period(36000.0 + (p + 1) as f64 / 24.0, &values).unwrap();
    }
    assert_eq!(w.finish(0).unwrap(), 5);

    let out = OutFile::open(&path).unwrap();
    let m = out.meta();
    assert!(m.complete);
    assert_eq!((m.n_periods, m.version, m.report_step_secs), (5, 52004, 3600));
    assert_eq!(m.nodes, ["N1", "N2", "N3"]);
    assert_eq!(m.pollutants, ["TSS"]);
    assert_eq!(m.var_names(ElementKind::Subcatchment).last().unwrap(), "washoff_TSS");
    assert_eq!(m.var_index(ElementKind::Link, "velocity"), Some(2));
    assert_eq!(m.node_type[2], swmm_out::NodeType::Outfall);
    assert_eq!(out.object_index(ElementKind::Node, "n2"), Some(1));
    for p in 0..5 {
        assert_eq!(out.stored_time(p).unwrap(), m.time(p));
    }
    let l = out.layout();
    let s_n2_head = l.series(ElementKind::Node, 1, 1);
    assert_eq!(out.value(ElementKind::Node, 1, 1, 3).unwrap(), (3000 + s_n2_head) as f32);
    let frame = out.frame(ElementKind::Link, 0, 2).unwrap();
    let expected: Vec<f32> = (0..2).map(|o| (2000 + l.series(ElementKind::Link, o, 0)) as f32).collect();
    assert_eq!(frame, expected);
    let series = out.series(ElementKind::System, 0, 4, 1..4).unwrap();
    let sys = l.series(ElementKind::System, 0, 4);
    assert_eq!(series, vec![(1000 + sys) as f32, (2000 + sys) as f32, (3000 + sys) as f32]);
    assert!(out.value(ElementKind::Node, 3, 0, 0).is_err());
    assert_eq!(m.period_at(m.time(3)), 3);
}

#[test]
fn partial_file_is_readable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.out");
    synth::generate(&path, &spec(2, 3, 3, 50), |_| {}).unwrap();
    let full = std::fs::read(&path).unwrap();
    // Simulate a running simulation: no epilogue and a half-written period.
    let bpp = OutFile::open(&path).unwrap().layout().bytes_per_period() as usize;
    std::fs::write(&path, &full[..full.len() - 24 - 10 * bpp - bpp / 2]).unwrap();
    let out = OutFile::open(&path).unwrap();
    assert!(!out.meta().complete);
    assert_eq!(out.n_periods(), 39);
    let cache_path = cache::default_cache_path(&path);
    assert!(matches!(
        cache::build(&out, &cache_path, &CacheOptions::default(), |_| {}, &AtomicBool::new(false)),
        Err(OutError::Incomplete)
    ));
}

fn check_cache(spec: &SynthSpec, opts: &CacheOptions) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.out");
    synth::generate(&path, spec, |_| {}).unwrap();
    let mut results = Results::open(&path).unwrap();
    assert!(matches!(results.cache_status(), Err(OutError::Io { .. })));
    let report = results.build_cache(opts, |_| {}, &AtomicBool::new(false)).unwrap();
    assert!(report.ratio() > 1.0, "{report:?}");
    let out = results.out();
    let cache = results.cache().unwrap();
    let n = out.n_periods();
    for s in 0..out.layout().values_per_period() {
        let (kind, obj, var) = out.layout().locate(s).unwrap();
        let direct = out.series(kind, obj, var, 0..n).unwrap();
        let cached = cache.series(s, 0..n).unwrap();
        assert!(direct.iter().zip(&cached).all(|(a, b)| a.to_bits() == b.to_bits()), "series {s} differs");
        // Sub-ranges crossing chunk boundaries.
        let r = n / 3..n - n / 5;
        assert_eq!(cache.series(s, r.clone()).unwrap(), direct[r].to_vec());
        let st = cache.stats(s);
        let max = direct.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert_eq!(st.max, max);
        assert_eq!(direct[st.argmax], max);
        let sum: f64 = direct.iter().map(|&v| v as f64).sum();
        assert!((st.sum - sum).abs() <= 1e-9 * sum.abs().max(1.0));
        assert_eq!(st.nonzero as usize, direct.iter().filter(|&&v| v != 0.0).count());
    }
    let env = results.envelope(ElementKind::Node, 0).unwrap();
    assert_eq!(env.len(), spec.nodes);
    // Reopening picks the cache up automatically.
    let again = Results::open(&path).unwrap();
    assert!(again.cache().is_some());
}

#[test]
fn cache_single_group() {
    check_cache(&spec(3, 10, 12, 5000), &CacheOptions { chunk_len: 512, ..Default::default() });
}

#[test]
fn cache_many_groups() {
    // A tiny budget forces several series groups per chunk (the many-objects layout).
    check_cache(
        &spec(40, 300, 300, 700),
        &CacheOptions { chunk_len: 256, memory_budget: 3 * 64 * 4 * 256 * 5, level: 3 },
    );
}

#[test]
fn stale_cache_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.out");
    let s = spec(1, 2, 2, 300);
    synth::generate(&path, &s, |_| {}).unwrap();
    let out = OutFile::open(&path).unwrap();
    let cp = cache::default_cache_path(&path);
    cache::build(&out, &cp, &CacheOptions::default(), |_| {}, &AtomicBool::new(false)).unwrap();
    assert!(ResultsCache::open(&cp, &out).is_ok());
    drop(out);
    std::thread::sleep(std::time::Duration::from_millis(20));
    synth::generate(&path, &SynthSpec { seed: 7, ..s }, |_| {}).unwrap();
    let out = OutFile::open(&path).unwrap();
    assert!(matches!(ResultsCache::open(&cp, &out), Err(OutError::StaleCache)));
}

#[test]
fn cancel_leaves_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.out");
    synth::generate(&path, &spec(1, 2, 2, 300), |_| {}).unwrap();
    let out = OutFile::open(&path).unwrap();
    let cp = cache::default_cache_path(&path);
    let r = cache::build(&out, &cp, &CacheOptions::default(), |_| {}, &AtomicBool::new(true));
    assert!(matches!(r, Err(OutError::Cancelled)));
    assert!(!cp.exists());
    assert!(!cp.with_extension("swcache.tmp").exists());
}

/// Cross-check on a file written by the real engine: set `SWMM_OUT_SAMPLE` to a `.out` path.
#[test]
fn real_engine_file() {
    let Some(p) = std::env::var_os("SWMM_OUT_SAMPLE") else { return };
    let out = OutFile::open(&p).unwrap();
    let m = out.meta();
    assert!(m.complete);
    for p in 0..m.n_periods {
        assert_eq!(out.stored_time(p).unwrap(), m.time(p));
    }
    eprintln!(
        "{} subcatchments, {} nodes, {} links, {} periods",
        m.subcatchments.len(),
        m.nodes.len(),
        m.links.len(),
        m.n_periods
    );
}
