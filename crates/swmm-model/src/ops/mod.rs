//! Editing operations: each runs inside a [`Tx`](crate::edit::Tx) and is undone as a whole.
//!
//! - [`fields`]: fields and optional lines of the sections;
//! - [`bulk`]: one field of many objects, by key (bulk edits with expressions);
//! - [`delete`]: rename and delete, with the references;
//! - [`create`]: new objects and map geometry;
//! - [`settings`]: options, title, RDII.

mod bulk;
mod create;
mod delete;
mod fields;
mod settings;

pub use bulk::*;
pub use create::*;
pub use delete::*;
pub use fields::*;
pub use settings::*;

#[cfg(test)]
mod tests;
