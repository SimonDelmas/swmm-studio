//! Analysis of SWMM results, on top of [`swmm_out::Results`] (which uses the results
//! cache when it is built).
//!
//! - [`reduce`]: one statistic (max, min, mean, time of max, total, time above a
//!   threshold) of a series over any range of periods, or of every object of a kind
//!   (envelope maps). Whole chunks come from the cache's summaries.
//! - [`calendar`]: periods grouped by day, month or year (time aggregation).
//! - [`events`]: event detection with a threshold and a minimum inter-event time, and
//!   per-year statistics (e.g. overflow frequency of CSOs).
//! - [`profile`]: shortest path between nodes and the longitudinal profile along it.

pub mod calendar;
pub mod events;
pub mod profile;
pub mod reduce;

pub use calendar::{bucket_of, buckets, interval_start, Bucket, Calendar};
pub use events::{detect, event_total, summarize, yearly, Event, EventParams, Summary, YearStats};
pub use profile::{path_through, shortest_path, Profile, ProfileLink, ProfileNode};
pub use reduce::{integral, reduce_all, reduce_series, Stat};

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};

    use swmm_out::{OutSpec, OutWriter, Results};

    /// A results file with 2 subcatchments, 3 nodes, 2 links and `values(series, period)`.
    pub fn results(dir: &Path, n: usize, step: i32, values: impl Fn(usize, usize) -> f32) -> PathBuf {
        let path = dir.join("r.out");
        // The first period ends one step after 2024-01-01 00:00.
        let start = 45_292.0;
        let spec = OutSpec::simple(2, 3, 2, start, step);
        let mut w = OutWriter::create(&path, &spec).unwrap();
        let nv = w.layout().values_per_period();
        for p in 0..n {
            let v: Vec<f32> = (0..nv).map(|s| values(s, p)).collect();
            w.write_period(start + (p + 1) as f64 * step as f64 / 86_400.0, &v).unwrap();
        }
        w.finish(0).unwrap();
        path
    }

    /// Opens a results file, with its cache built in chunks of `chunk` periods.
    pub fn open(path: &Path, chunk: Option<usize>) -> Results {
        let mut r = Results::open(path).unwrap();
        if let Some(chunk_len) = chunk {
            let opts = swmm_out::cache::CacheOptions { chunk_len, ..Default::default() };
            r.build_cache(&opts, |_| {}, &Default::default()).unwrap();
        }
        r
    }
}
