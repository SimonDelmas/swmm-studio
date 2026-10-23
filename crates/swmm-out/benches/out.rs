use std::sync::atomic::AtomicBool;

use chrono::NaiveDate;
use criterion::{criterion_group, criterion_main, Criterion};
use swmm_out::cache::CacheOptions;
use swmm_out::synth::{self, SynthSpec};
use swmm_out::{ElementKind, Results};

fn bench(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bench.out");
    // ~2 years at 5 min for a 500-object model (~400 MB).
    let spec = SynthSpec {
        subcatchments: 100,
        nodes: 200,
        links: 200,
        periods: 210_000,
        report_step_secs: 300,
        start: NaiveDate::from_ymd_opt(2020, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap(),
        seed: 1,
    };
    synth::generate(&path, &spec, |_| {}).unwrap();
    let mut results = Results::open(&path).unwrap();
    let n = results.meta().n_periods;

    let mut g = c.benchmark_group("out");
    g.sample_size(10);
    g.bench_function("frame_all_links", |b| b.iter(|| results.frame(ElementKind::Link, 0, n / 2).unwrap()));
    g.bench_function("series_direct_full", |b| {
        b.iter(|| results.out().series(ElementKind::Node, 17, 0, 0..n).unwrap())
    });
    results.build_cache(&CacheOptions::default(), |_| {}, &AtomicBool::new(false)).unwrap();
    g.bench_function("series_cached_full", |b| b.iter(|| results.series(ElementKind::Node, 17, 0, 0..n).unwrap()));
    g.bench_function("minmax_cached_full_2000px", |b| {
        b.iter(|| results.series_minmax(ElementKind::Link, 3, 0, 0..n, 2000).unwrap())
    });
    g.bench_function("envelope_node_depth", |b| b.iter(|| results.envelope(ElementKind::Node, 0).unwrap()));
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
