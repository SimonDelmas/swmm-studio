use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use swmm_inp::InpFile;

/// Synthetic model with `n` junctions and conduits (with coordinates and cross-sections).
fn synthetic(n: usize) -> String {
    let mut s = String::from(
        "[TITLE]\r\nBench\r\n\r\n[OPTIONS]\r\nFLOW_UNITS CMS\r\n\r\n[JUNCTIONS]\r\n;;Name Elev MaxDepth\r\n",
    );
    for i in 0..n {
        s += &format!("J{i:<15} {:<10.3} 2.5        0          0          0\r\n", 100.0 - i as f64 * 0.01);
    }
    s += "\r\n[CONDUITS]\r\n";
    for i in 1..n {
        s += &format!("C{i:<15} J{:<15} J{i:<15} 50         0.013      0          0          0          0\r\n", i - 1);
    }
    s += "\r\n[XSECTIONS]\r\n";
    for i in 1..n {
        s += &format!("C{i:<15} CIRCULAR     0.6              0          0          0          1\r\n");
    }
    s += "\r\n[COORDINATES]\r\n";
    for i in 0..n {
        s += &format!("J{i:<15} {:<18.3} {:<18.3}\r\n", 650000.0 + i as f64, 6860000.0 + i as f64);
    }
    s
}

fn bench(c: &mut Criterion) {
    let text = synthetic(50_000);
    let bytes = text.as_bytes().to_vec();
    let mut g = c.benchmark_group("inp");
    g.throughput(Throughput::Bytes(bytes.len() as u64));
    g.sample_size(10);
    g.bench_function("parse_50k_nodes", |b| b.iter(|| InpFile::parse_bytes(&bytes)));
    let inp = InpFile::parse_bytes(&bytes);
    g.bench_function("write_50k_nodes", |b| b.iter(|| inp.to_bytes().unwrap()));
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
