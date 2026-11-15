//! Edits of the fields and lines of the sections.

use super::*;

/// Fields and lines of the sections.
impl Session {
    pub(super) fn set_field(&mut self, section_name: &str, key: &[String], field: usize, value: &str) -> Res<Effect> {
        let kind = section(section_name)?;
        let label = format!("Edit {}", first_key(key));
        let a = self.history.edit(&mut self.inp, label, |tx| ops::set_field(tx, &kind, key, field, value))?;
        Ok(a.into())
    }

    pub(super) fn set_field_bulk(
        &mut self,
        objects: &[ObjRef],
        section_name: &str,
        field: &str,
        value: &str,
    ) -> Res<Effect> {
        let kind = section(section_name)?;
        let ids: Vec<String> = self.ids_of(objects).into_iter().map(|(_, id)| id).collect();
        let a = self.history.edit(&mut self.inp, format!("Edit {} objects", ids.len()), |tx| {
            ops::set_field_bulk(tx, &kind, &ids, field, value)
        })?;
        let message = format!("{} of {} objects changed", a.value, ids.len());
        Ok(Effect::from(a).message(message))
    }

    pub(super) fn add_line(&mut self, section_name: &str, key: &[String]) -> Res<Effect> {
        let kind = section(section_name)?;
        let label = format!("Add [{}] to {}", kind.name(), first_key(key));
        Ok(self.history.edit(&mut self.inp, label, |tx| ops::add_line(tx, &kind, key))?.into())
    }

    pub(super) fn remove_line(&mut self, section_name: &str, key: &[String]) -> Res<Effect> {
        let kind = section(section_name)?;
        let label = format!("Remove [{}] of {}", kind.name(), first_key(key));
        Ok(self.history.edit(&mut self.inp, label, |tx| ops::remove_line(tx, &kind, key))?.into())
    }

    /// Renames an object with every reference to it; it stays selected.
    pub(super) fn rename(&mut self, kind: RefKind, old: &str, new: &str, keep: &Named) -> Res<Effect> {
        let label = format!("Rename {old} to {new}");
        let a = self.history.edit(&mut self.inp, label, |tx| ops::rename(tx, kind, old, new))?;
        let focus =
            keep.iter().map(|(k, id)| (*k, if id.eq_ignore_ascii_case(old) { new.to_string() } else { id.clone() }));
        Ok(Effect { focus: Some(focus.collect()), ..a.into() })
    }

    pub(super) fn set_cells(&mut self, section_name: &str, cells: &[swmm_model::grid::Cell]) -> Res<Effect> {
        let kind = section(section_name)?;
        let label = match cells {
            [cell] => format!("Edit {}", first_key(&cell.key)),
            _ => format!("Edit {} cells of [{}]", cells.len(), kind.name()),
        };
        let a = self.history.edit(&mut self.inp, label, |tx| swmm_model::grid::set_cells(tx, &kind, cells))?;
        let message = (cells.len() > 1).then(|| format!("{} line(s) changed", a.value));
        Ok(Effect { message, ..a.into() })
    }

    pub(super) fn set_section_text(&mut self, section_name: &str, text: &str) -> Res<Effect> {
        // Unknown sections (extensions) can be edited as text too.
        let kind = SectionKind::from_name(section_name);
        let label = format!("Edit [{}]", kind.name());
        Ok(self.history.edit(&mut self.inp, label, |tx| swmm_model::grid::set_section_text(tx, &kind, text))?.into())
    }

    pub(super) fn set_options(&mut self, values: &[(String, String)]) -> Res<Effect> {
        Ok(self.history.edit(&mut self.inp, "Simulation options", |tx| ops::set_options(tx, values))?.into())
    }

    pub(super) fn set_title(&mut self, text: &str) -> Res<Effect> {
        Ok(self.history.edit(&mut self.inp, "Title", |tx| ops::set_title(tx, text))?.into())
    }

    pub(super) fn set_climate(&mut self, climate: &swmm_model::climate::Climate) -> Res<Effect> {
        Ok(self.history.edit(&mut self.inp, "Climatology", |tx| climate.write(tx))?.into())
    }
}
