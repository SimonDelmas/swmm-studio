//! What the UI asks (`EditRequest`) and what it gets back (`EditOutcome`).

use serde::{Deserialize, Serialize};
use swmm_model::schema::RefKind;
use swmm_model::tables::Table;
use swmm_model::{LinkType, NodeType, ObjRef};

use crate::session::{GeometryPatch, ModelInfo};

/// An edit asked by the UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditRequest {
    /// Sets one field of the line `key` of a section.
    SetField {
        section: String,
        key: Vec<String>,
        field: usize,
        value: String,
    },
    /// Sets a field (by key) on the lines of many objects.
    SetFieldBulk {
        objects: Vec<ObjRef>,
        section: String,
        field: String,
        value: String,
    },
    AddLine {
        section: String,
        key: Vec<String>,
    },
    RemoveLine {
        section: String,
        key: Vec<String>,
    },
    Rename {
        kind: RefKind,
        old: String,
        new: String,
    },
    AddNode {
        node_type: NodeType,
        xy: [f64; 2],
    },
    AddLink {
        link_type: LinkType,
        from: u32,
        to: u32,
        vertices: Vec<[f64; 2]>,
    },
    AddSubcatchment {
        polygon: Vec<[f64; 2]>,
    },
    AddGage {
        xy: [f64; 2],
    },
    Delete {
        objects: Vec<ObjRef>,
    },
    /// New map geometry: the point of a node or gage, the interior vertices of a link,
    /// the outline of a subcatchment.
    SetGeometry {
        object: ObjRef,
        points: Vec<[f64; 2]>,
    },
    /// Moves objects by an offset in display coordinates.
    Translate {
        objects: Vec<ObjRef>,
        dx: f64,
        dy: f64,
    },
    Reconnect {
        link: u32,
        end: LinkEnd,
        node: u32,
    },
    SetOptions {
        values: Vec<(String, String)>,
    },
    SetTitle {
        text: String,
    },
    /// Writes a table; `old_name` renames it first (with every reference).
    SetTable {
        table: Table,
        old_name: Option<String>,
    },
    AddTable {
        kind: RefKind,
    },
    DeleteTable {
        kind: RefKind,
        name: String,
    },
    AssignRdii {
        nodes: Vec<u32>,
        hydrograph: String,
        area: Option<String>,
    },
    RemoveRdii {
        nodes: Vec<u32>,
    },
    /// Sets many cells of a section (tabular editor, paste).
    SetCells {
        section: String,
        cells: Vec<swmm_model::grid::Cell>,
    },
    SetClimate {
        climate: swmm_model::climate::Climate,
    },
    /// Replaces the text of a section.
    SetSectionText {
        section: String,
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkEnd {
    From,
    To,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditOutcome {
    /// Label of the edit (shown as "Undo <label>").
    pub label: String,
    pub info: ModelInfo,
    /// The map geometry changed: the UI fetches it again.
    pub geometry: bool,
    /// Or only these objects changed: the UI updates them in place.
    pub patch: Option<GeometryPatch>,
    /// Objects were added, removed or renamed: indices changed.
    pub rebuilt: bool,
    /// Selection after the edit.
    pub selection: Vec<ObjRef>,
    /// Message for the status bar.
    pub message: Option<String>,
    /// Name created by the edit (new table).
    pub created: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionsDto {
    pub values: Vec<(String, String)>,
    pub title: String,
}
