//! Times the main access patterns on a (large) `.out` file.
//!
//! `cargo run --release -p swmm-out --example bench_large -- big.out`
//! Build the cache first (`swmm-cli out cache big.out`) to time cached access.

use std::time::Instant;

use swmm_out::{ElementKind, Results};

fn time<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let t0 = Instant::now();
    let r = f();
    println!("{label:<48} {:>10.2} ms", t0.elapsed().as_secs_f64() * 1000.0);
    r
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench_large <file.out>");
    let r = time("open (header, IDs, epilogue)", || Results::open(&path).unwrap());
    let m = r.meta();
    let n = m.n_periods;
    println!(
        "{} periods, {} subcatchments, {} nodes, {} links, {:.2} GB, cache: {}",
        n,
        m.count(ElementKind::Subcatchment),
        m.count(ElementKind::Node),
        m.count(ElementKind::Link),
        r.out().bytes().len() as f64 / 1e9,
        r.cache().is_some()
    );
    let mid = n / 2;
    time("frame: link flow, all links, 1 period", || r.frame(ElementKind::Link, 0, mid).unwrap());
    time("frame: node depth, all nodes, 1 period", || r.frame(ElementKind::Node, 0, mid + 1).unwrap());
    time("100 consecutive frames (playback)", || {
        for p in mid..mid + 100.min(n - mid) {
            r.frame(ElementKind::Link, 0, p).unwrap();
        }
    });
    let nodes = m.count(ElementKind::Node);
    time("series direct: 1 node depth, full run", || r.out().series(ElementKind::Node, nodes / 3, 0, 0..n).unwrap());
    time("series direct: 1 node depth, last 7 days", || {
        let week = (7 * 86_400 / m.report_step_secs.max(1)) as usize;
        r.out().series(ElementKind::Node, nodes / 3 + 1, 0, n.saturating_sub(week)..n).unwrap()
    });
    if r.cache().is_some() {
        time("series cached: 1 node depth, full run", || r.series(ElementKind::Node, nodes / 4, 0, 0..n).unwrap());
        time("series cached: 1 link flow, 1 month", || {
            let month = (30 * 86_400 / m.report_step_secs.max(1)) as usize;
            r.series(ElementKind::Link, 7, 0, mid..mid + month).unwrap()
        });
        time("min/max 2000 px: link flow, full run", || r.series_minmax(ElementKind::Link, 9, 0, 0..n, 2000).unwrap());
        time("10 series cached, full run", || {
            for o in 0..10.min(nodes) {
                r.series(ElementKind::Node, o * 3, 0, 0..n).unwrap();
            }
        });
        let env = time("envelope: max node depth, all nodes", || r.envelope(ElementKind::Node, 0).unwrap());
        time("envelope: max link flow, all links", || r.envelope(ElementKind::Link, 0).unwrap());
        let worst = env.iter().enumerate().max_by(|a, b| a.1.max.total_cmp(&b.1.max)).unwrap();
        println!("deepest node: {} ({:.3} at {})", m.nodes[worst.0], worst.1.max, m.time(worst.1.argmax));
    }
}
