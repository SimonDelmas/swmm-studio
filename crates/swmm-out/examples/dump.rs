//! Dumps every series of a `.out` file as `kind,id,var,v0,v1,...` lines (through the
//! cache when one exists). Used to cross-check against the EPA output library.
//!
//! `cargo run --release -p swmm-out --example dump -- model.out > dump.csv`

use std::io::Write;

use swmm_out::{ElementKind, Results};

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump <file.out>");
    let r = Results::open(&path).expect("open");
    let m = r.meta();
    let n = m.n_periods;
    eprintln!("cache: {}", r.cache().is_some());
    let mut w = std::io::BufWriter::new(std::io::stdout().lock());
    for kind in ElementKind::ALL {
        for (o, id) in m.ids(kind).iter().enumerate() {
            for v in 0..m.nvars(kind) {
                let s = r.series(kind, o, v, 0..n).expect("series");
                let vals: Vec<String> = s.iter().map(|x| format!("{:?}", *x as f64)).collect();
                writeln!(w, "{},{id},{v},{}", kind.name(), vals.join(",")).unwrap();
            }
        }
    }
}
