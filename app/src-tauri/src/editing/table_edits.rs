//! Edits of curves, time series, patterns, unit hydrographs, transects and RDII.

use super::*;

/// Curves, time series, patterns, unit hydrographs, transects and RDII.
impl Session {
    /// Writes a table; `old_name` renames it first (with every reference).
    pub(super) fn set_table(&mut self, table: &Table, old_name: Option<&str>) -> Res<Effect> {
        let kind = table.ref_kind();
        let label = format!("Edit {} {}", table_word(kind), table.name());
        let a = self.history.edit(&mut self.inp, label, |tx| {
            if let Some(old) = old_name.filter(|o| *o != table.name()) {
                ops::rename(tx, kind, old, table.name())?;
            }
            tables::write(tx, table)
        })?;
        Ok(Effect::from(a).created(table.name().to_string()))
    }

    /// Adds an empty table under the first free name (`Curve1`, `TS2`...).
    pub(super) fn add_table(&mut self, kind: RefKind) -> Res<Effect> {
        let used = tables::used_names(&self.inp, kind);
        let prefix = table_prefix(kind);
        let name = (1..)
            .map(|n| format!("{prefix}{n}"))
            .find(|n| !used.contains(&n.to_ascii_uppercase()))
            .expect("an unbounded range of names");
        let table = Table::empty(kind, &name).ok_or("not a table")?;
        let label = format!("Add {} {name}", table_word(kind));
        let a = self.history.edit(&mut self.inp, label, |tx| tables::write(tx, &table))?;
        Ok(Effect::from(a).created(name))
    }

    pub(super) fn delete_table(&mut self, kind: RefKind, name: &str) -> Res<Effect> {
        let label = format!("Delete {} {name}", table_word(kind));
        Ok(self.history.edit(&mut self.inp, label, |tx| tables::delete(tx, kind, name))?.into())
    }

    pub(super) fn node_ids(&self, nodes: &[u32]) -> Res<Vec<String>> {
        nodes.iter().map(|&n| self.id_at(ObjKind::Node, n)).collect()
    }

    pub(super) fn assign_rdii(&mut self, nodes: &[u32], hydrograph: &str, area: Option<&str>) -> Res<Effect> {
        let ids = self.node_ids(nodes)?;
        let area = area.filter(|a| !a.trim().is_empty());
        let label = format!("Assign RDII to {} node(s)", ids.len());
        let a = self.history.edit(&mut self.inp, label, |tx| ops::assign_rdii(tx, &ids, hydrograph, area))?;
        let message = format!("{} node(s) assigned to {hydrograph}", a.value);
        Ok(Effect::from(a).message(message))
    }

    pub(super) fn remove_rdii(&mut self, nodes: &[u32]) -> Res<Effect> {
        let ids = self.node_ids(nodes)?;
        let a = self.history.edit(&mut self.inp, "Remove RDII", |tx| Ok(ops::remove_rdii(tx, &ids)))?;
        let message = format!("RDII removed from {} node(s)", a.value);
        Ok(Effect::from(a).message(message))
    }
}
