//! Renaming and deleting objects, with every reference to them.

use std::collections::HashSet;

use serde::Serialize;
use swmm_inp::{InpFile, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::refs::{self, RefLoc, Role};
use crate::schema::{check_id, RefKind};
use crate::{Network, ObjKind, ObjRef};

/// Renames an object and every reference to it.
pub fn rename(tx: &mut Tx, kind: RefKind, old: &str, new: &str) -> EditResult<()> {
    let new = new.trim();
    check_id(new)?;
    if new == old {
        return Ok(());
    }
    let taken = refs::names(tx.inp(), kind).iter().any(|n| n.eq_ignore_ascii_case(new) && !n.eq_ignore_ascii_case(old));
    if taken {
        return Err(format!("the name {new} is already used"));
    }
    let ids: HashSet<String> = [old.to_ascii_uppercase()].into();
    let locs = refs::find_refs(tx.inp(), kind, &ids);
    if !locs.iter().any(|r| r.role == Role::Def) {
        return Err(format!("no object named {old}"));
    }
    for r in locs {
        let mut line = tx.inp().sections()[r.section].lines()[r.line].clone();
        line.set_token(r.token, new);
        tx.replace_line(r.section, r.line, line);
    }
    Ok(())
}

/// What deleting objects also removes or changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DeletePlan {
    pub nodes: Vec<String>,
    pub links: Vec<String>,
    pub subcatchments: Vec<String>,
    pub gages: Vec<String>,
    /// Links deleted because one of their nodes is.
    pub cascade_links: Vec<String>,
    /// References set to `*` or removed: `[section] object`.
    pub cleared: Vec<String>,
    /// Control rules that name a deleted object (left unchanged).
    pub rules: usize,
}

fn ref_kind(k: ObjKind) -> RefKind {
    match k {
        ObjKind::Node => RefKind::Node,
        ObjKind::Link => RefKind::Link,
        ObjKind::Subcatchment => RefKind::Subcatchment,
        ObjKind::Gage => RefKind::Gage,
    }
}

/// Plans (and with `tx`, performs) the deletion of objects.
fn delete_impl(inp: &InpFile, net: &Network, objects: &[ObjRef]) -> (DeletePlan, Vec<RefLoc>) {
    let mut plan = DeletePlan::default();
    let mut sets: [HashSet<String>; 4] = Default::default();
    for o in objects {
        if (o.index as usize) < net.len(o.kind) {
            let id = net.id(*o).to_string();
            if sets[o.kind as usize].insert(id.to_ascii_uppercase()) {
                match o.kind {
                    ObjKind::Node => plan.nodes.push(id),
                    ObjKind::Link => plan.links.push(id),
                    ObjKind::Subcatchment => plan.subcatchments.push(id),
                    ObjKind::Gage => plan.gages.push(id),
                }
            }
        }
    }
    let nodes: HashSet<u32> = objects.iter().filter(|o| o.kind == ObjKind::Node).map(|o| o.index).collect();
    for l in &net.links {
        let attached = l.from.is_some_and(|n| nodes.contains(&n)) || l.to.is_some_and(|n| nodes.contains(&n));
        if attached && sets[ObjKind::Link as usize].insert(l.id.to_ascii_uppercase()) {
            plan.cascade_links.push(l.id.clone());
        }
    }
    let mut locs = Vec::new();
    for k in ObjKind::ALL {
        locs.extend(refs::find_refs(inp, ref_kind(k), &sets[k as usize]));
    }
    // Lines that go away entirely.
    let removed: HashSet<(usize, usize)> =
        locs.iter().filter(|r| matches!(r.role, Role::Def | Role::Owned)).map(|r| (r.section, r.line)).collect();
    // Links of deleted nodes are removed with their own lines.
    locs.retain(|r| !(r.role == Role::Ref && removed.contains(&(r.section, r.line))));
    for r in &locs {
        match r.role {
            Role::Ref | Role::List => {
                let s = &inp.sections()[r.section];
                let by = s.lines()[r.line].token(0).unwrap_or("");
                plan.cleared.push(format!("[{}] {by}", s.name()));
            }
            Role::Rule => plan.rules += 1,
            _ => {}
        }
    }
    plan.cleared.dedup();
    (plan, locs)
}

pub fn delete_plan(inp: &InpFile, net: &Network, objects: &[ObjRef]) -> DeletePlan {
    delete_impl(inp, net, objects).0
}

/// Deletes objects, the links attached to deleted nodes and every line that belongs to
/// them; references from other objects are set to `*` (lists lose the name).
pub fn delete(tx: &mut Tx, net: &Network, objects: &[ObjRef]) -> EditResult<DeletePlan> {
    let (plan, locs) = delete_impl(tx.inp(), net, objects);
    let mut by_line: std::collections::BTreeMap<(usize, usize), Vec<RefLoc>> = Default::default();
    for r in locs.into_iter().filter(|r| r.role != Role::Rule) {
        by_line.entry((r.section, r.line)).or_default().push(r);
    }
    // Bottom-up so that indices stay valid.
    for ((s, l), rs) in by_line.into_iter().rev() {
        if rs.iter().any(|r| matches!(r.role, Role::Def | Role::Owned)) {
            tx.remove_line(s, l);
            continue;
        }
        let line = tx.inp().sections()[s].lines()[l].clone();
        let kind = tx.inp().sections()[s].kind().clone();
        let mut tokens: Vec<Option<String>> = line.tokens().map(|t| Some(t.to_string())).collect();
        for r in &rs {
            let last = r.token + 1 == tokens.len();
            let optional_tail =
                last && matches!(kind, SectionKind::Outfalls | SectionKind::Labels | SectionKind::Groundwater);
            if r.role == Role::List || optional_tail {
                tokens[r.token] = None;
            } else {
                tokens[r.token] = Some("*".into());
            }
        }
        let kept: Vec<String> = tokens.into_iter().flatten().collect();
        if kept.len() <= 1 && kind == SectionKind::Report {
            tx.remove_line(s, l);
        } else {
            let mut nl = line;
            nl.set_tokens(&kept);
            tx.replace_line(s, l, nl);
        }
    }
    Ok(plan)
}
