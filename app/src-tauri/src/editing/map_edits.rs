//! Edits made on the map: objects drawn, moved, reshaped, reconnected and deleted.

use swmm_model::ops;
use swmm_model::{LinkType, NodeType, ObjKind, ObjRef};

use super::{link_word, node_word, Effect, LinkEnd};
use crate::session::{Res, Session};

/// Objects drawn, moved and deleted on the map.
impl Session {
    pub(super) fn add_node(&mut self, node_type: NodeType, xy: [f64; 2]) -> Res<Effect> {
        let p = self.to_model(&[xy])?[0];
        let (net, decimals) = (&self.net, self.decimals());
        let a = self.history.edit(&mut self.inp, format!("Add {}", node_word(node_type)), |tx| {
            ops::add_node(tx, net, node_type, p, decimals)
        })?;
        Ok(Effect::added(a, ObjKind::Node))
    }

    /// A link between two nodes; its length is the length of the line drawn.
    pub(super) fn add_link(&mut self, link_type: LinkType, from: u32, to: u32, vertices: &[[f64; 2]]) -> Res<Effect> {
        let (fid, tid) = (self.id_at(ObjKind::Node, from)?, self.id_at(ObjKind::Node, to)?);
        let v = self.to_model(vertices)?;
        let mut path: Vec<[f64; 2]> = Vec::new();
        path.extend(self.net.nodes[from as usize].xy);
        path.extend_from_slice(&v);
        path.extend(self.net.nodes[to as usize].xy);
        let length = (path.len() >= 2).then(|| self.model_length(&path));
        let (net, decimals) = (&self.net, self.decimals());
        let a = self.history.edit(&mut self.inp, format!("Add {}", link_word(link_type)), |tx| {
            ops::add_link(tx, net, link_type, [&fid, &tid], &v, length, decimals)
        })?;
        Ok(Effect::added(a, ObjKind::Link))
    }

    /// A subcatchment from its outline: its area is the area drawn, its outlet the
    /// node closest to its centre.
    pub(super) fn add_subcatchment(&mut self, polygon: &[[f64; 2]]) -> Res<Effect> {
        let mut ring = self.to_model(polygon)?;
        if ring.len() > 3 && ring.first() == ring.last() {
            ring.pop();
        }
        if ring.len() < 3 {
            return Err("a subcatchment outline needs at least three points".into());
        }
        let area = self.model_area(&ring);
        let c = [
            ring.iter().map(|p| p[0]).sum::<f64>() / ring.len() as f64,
            ring.iter().map(|p| p[1]).sum::<f64>() / ring.len() as f64,
        ];
        let outlet = self
            .net
            .nodes
            .iter()
            .filter_map(|n| n.xy.map(|p| ((p[0] - c[0]).hypot(p[1] - c[1]), n.id.clone())))
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, id)| id);
        let (net, decimals) = (&self.net, self.decimals());
        let a = self.history.edit(&mut self.inp, "Add subcatchment", |tx| {
            ops::add_subcatchment(tx, net, &ring, outlet.as_deref(), Some(area), decimals)
        })?;
        Ok(Effect::added(a, ObjKind::Subcatchment))
    }

    pub(super) fn add_gage(&mut self, xy: [f64; 2]) -> Res<Effect> {
        let p = self.to_model(&[xy])?[0];
        let (net, decimals) = (&self.net, self.decimals());
        let a = self.history.edit(&mut self.inp, "Add rain gage", |tx| ops::add_gage(tx, net, p, decimals))?;
        Ok(Effect::added(a, ObjKind::Gage))
    }

    /// Deletes objects with the links connected to them; nothing stays selected.
    pub(super) fn delete(&mut self, objects: &[ObjRef]) -> Res<Effect> {
        let label = match self.ids_of(objects).as_slice() {
            [(_, id)] if objects.len() == 1 => format!("Delete {id}"),
            _ if objects.len() == 1 => "Delete ".to_string(),
            _ => format!("Delete {} objects", objects.len()),
        };
        let net = &self.net;
        let a = self.history.edit(&mut self.inp, label, |tx| ops::delete(tx, net, objects))?;
        let p = &a.value;
        let total = p.nodes.len() + p.links.len() + p.subcatchments.len() + p.gages.len();
        let mut message = format!("{total} object(s) deleted");
        if !p.cascade_links.is_empty() {
            message += &format!(", with {} connected link(s)", p.cascade_links.len());
        }
        if p.rules > 0 {
            message += &format!("; {} control rule line(s) still name them", p.rules);
        }
        Ok(Effect { focus: Some(Vec::new()), message: Some(message), ..a.into() })
    }

    /// New map geometry: the point of a node or gage, the interior vertices of a link,
    /// the outline of a subcatchment.
    pub(super) fn set_geometry(&mut self, object: ObjRef, points: &[[f64; 2]]) -> Res<Effect> {
        let id = self.id_at(object.kind, object.index)?;
        let mut pts = self.to_model(points)?;
        if object.kind == ObjKind::Subcatchment && pts.len() > 3 && pts.first() == pts.last() {
            pts.pop();
        }
        let label = match object.kind {
            ObjKind::Node | ObjKind::Gage => format!("Move {id}"),
            _ => format!("Reshape {id}"),
        };
        let decimals = self.decimals();
        let a =
            self.history.edit(&mut self.inp, label, |tx| ops::set_geometry(tx, object.kind, &id, &pts, decimals))?;
        Ok(a.into())
    }

    /// Moves objects by an offset in display coordinates: each object's display
    /// geometry is shifted, then converted back.
    pub(super) fn translate(&mut self, objects: &[ObjRef], dx: f64, dy: f64) -> Res<Effect> {
        let mut moves: Vec<(ObjKind, String, Vec<[f64; 2]>)> = Vec::new();
        for o in objects {
            let id = self.id_at(o.kind, o.index)?;
            let shifted: Vec<[f64; 2]> = self.display_points(*o).into_iter().map(|p| [p[0] + dx, p[1] + dy]).collect();
            if !shifted.is_empty() {
                moves.push((o.kind, id, self.to_model(&shifted)?));
            }
        }
        let label = if objects.len() == 1 {
            format!("Move {}", moves.first().map_or("", |m| m.1.as_str()))
        } else {
            format!("Move {} objects", objects.len())
        };
        let decimals = self.decimals();
        let a = self.history.edit(&mut self.inp, label, |tx| {
            moves.iter().try_for_each(|(k, id, pts)| ops::set_geometry(tx, *k, id, pts, decimals))
        })?;
        Ok(a.into())
    }

    pub(super) fn reconnect(&mut self, link: u32, end: LinkEnd, node: u32) -> Res<Effect> {
        let lid = self.id_at(ObjKind::Link, link)?;
        let nid = self.id_at(ObjKind::Node, node)?;
        let l = &self.net.links[link as usize];
        let (other, field) = match end {
            LinkEnd::From => (l.to, 1),
            LinkEnd::To => (l.from, 2),
        };
        if other == Some(node) {
            return Err("a link needs two different nodes".into());
        }
        let kind = l.kind.section();
        let a = self.history.edit(&mut self.inp, format!("Reconnect {lid} to {nid}"), |tx| {
            ops::set_field(tx, &kind, std::slice::from_ref(&lid), field, &nid)
        })?;
        Ok(a.into())
    }
}
