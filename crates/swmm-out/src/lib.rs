//! Reader, writer and object-major cache for EPA SWMM 5 binary output files (`.out`).
//!
//! - [`OutFile`] memory-maps a file of any size (64-bit offsets) and gives direct access
//!   to frames (all objects at one period, one contiguous read) and series.
//! - [`cache`] builds a compressed, object-major copy in one sequential pass so that
//!   multi-year time series and whole-run statistics are fast.
//! - [`Results`] combines both and picks the fastest path.
//! - [`OutWriter`] and [`synth`] write valid files (tests, benchmarks).

pub mod cache;
pub mod format;
mod reader;
mod results;
pub mod synth;
mod writer;

use std::path::Path;

pub use format::{ElementKind, FlowUnits, LinkType, NodeType};
pub use reader::{Layout, OutFile, OutMeta};
pub use results::{decimate, MinMax, Results};
pub use writer::{OutSpec, OutWriter};

#[derive(Debug, thiserror::Error)]
pub enum OutError {
    #[error("{path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("not a SWMM binary output file")]
    NotSwmm,
    #[error("file is truncated")]
    Truncated,
    #[error("corrupt file: {0}")]
    Corrupt(String),
    #[error("{} {obj} / variable {var} / period {period} is out of range", kind.name())]
    OutOfRange { kind: ElementKind, obj: usize, var: usize, period: usize },
    #[error("the simulation did not finish writing this file")]
    Incomplete,
    #[error("the results cache was built from another version of the .out file")]
    StaleCache,
    #[error("no results cache: build it first")]
    NoCache,
    #[error("cancelled")]
    Cancelled,
}

impl OutError {
    pub(crate) fn io(path: &Path, source: std::io::Error) -> OutError {
        OutError::Io { path: path.display().to_string(), source }
    }
}
