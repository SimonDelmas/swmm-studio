// The network upstream of objects: what drains to them, following links from their
// to node to their from node, and subcatchments to their outlet.

import { useStore } from "../store";
import type { Geometry, ObjKind, ObjRef } from "../types";
import type { LayerStyle, StyledKind } from "../uiTypes";
import { isShown } from "./shown";

const NONE = 0xffffffff;

/** Objects upstream of the roots (the roots included), as sorted index lists. */
export interface Upstream {
  nodes: number[];
  links: number[];
  subcatchments: number[];
}

/** For each target, the sources pointing to it (compressed rows). */
function reverse(nTargets: number, nSources: number, targetOf: (i: number) => number) {
  const starts = new Uint32Array(nTargets + 1);
  for (let i = 0; i < nSources; i++) {
    const t = targetOf(i);
    if (t < nTargets) starts[t + 1]++;
  }
  for (let t = 0; t < nTargets; t++) starts[t + 1] += starts[t];
  const items = new Uint32Array(starts[nTargets]);
  const fill = starts.slice(0, nTargets);
  for (let i = 0; i < nSources; i++) {
    const t = targetOf(i);
    if (t < nTargets) items[fill[t]++] = i;
  }
  return { starts, items };
}

/**
 * The network upstream of the selected nodes, links and subcatchments: the links whose to node
 * is upstream and their from nodes, and the subcatchments draining to an upstream node or
 * subcatchment. A link's upstream starts at its from node. Gages have none.
 */
export function upstreamOf(g: Geometry, roots: ObjRef[]): Upstream {
  const nNodes = g.nodeTypes.length;
  const nLinks = g.linkTypes.length;
  const nSubs = g.subStarts.length - 1;
  const node = new Uint8Array(nNodes);
  const link = new Uint8Array(nLinks);
  const sub = new Uint8Array(nSubs);
  const nodeStack: number[] = [];
  const subStack: number[] = [];
  const addNode = (n: number) => {
    if (n < nNodes && !node[n]) ((node[n] = 1), nodeStack.push(n));
  };
  const addSub = (s: number) => {
    if (s < nSubs && !sub[s]) ((sub[s] = 1), subStack.push(s));
  };
  for (const o of roots) {
    if (o.kind === "node") addNode(o.index);
    else if (o.kind === "subcatchment") addSub(o.index);
    else if (o.kind === "link" && o.index < nLinks) {
      link[o.index] = 1;
      addNode(g.linkEnds[2 * o.index]);
    }
  }
  const marked = (a: Uint8Array) => {
    const out: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i]) out.push(i);
    return out;
  };
  const result = () => ({ nodes: marked(node), links: marked(link), subcatchments: marked(sub) });
  if (nodeStack.length === 0 && subStack.length === 0) return result();

  const toNode = reverse(nNodes, nLinks, (i) => g.linkEnds[2 * i + 1]);
  const outletOf = (kind: number) => (i: number) => (g.subOutlets[2 * i] === kind ? g.subOutlets[2 * i + 1] : NONE);
  const subToNode = reverse(nNodes, nSubs, outletOf(0));
  const subToSub = reverse(nSubs, nSubs, outletOf(1));

  while (nodeStack.length > 0 || subStack.length > 0) {
    const n = nodeStack.pop();
    if (n !== undefined) {
      for (let k = toNode.starts[n]; k < toNode.starts[n + 1]; k++) {
        const l = toNode.items[k];
        link[l] = 1;
        addNode(g.linkEnds[2 * l]);
      }
      for (let k = subToNode.starts[n]; k < subToNode.starts[n + 1]; k++) addSub(subToNode.items[k]);
      continue;
    }
    const s = subStack.pop()!;
    for (let k = subToSub.starts[s]; k < subToSub.starts[s + 1]; k++) addSub(subToSub.items[k]);
  }

  return result();
}

let last: { g: Geometry; roots: ObjRef[]; up: Upstream } | null = null;

/** `upstreamOf`, kept for the last geometry and roots (the map and the status bar ask for it). */
export function upstreamCached(g: Geometry, roots: ObjRef[]): Upstream {
  if (last?.g !== g || last.roots !== roots) last = { g, roots, up: upstreamOf(g, roots) };
  return last.up;
}

/** The objects of `up` the map draws (hidden layers and types left out). */
export function shownUpstream(g: Geometry, up: Upstream, styles: Record<StyledKind, LayerStyle>): Upstream {
  const keep = (kind: ObjKind, list: number[]) => list.filter((index) => isShown({ kind, index }, styles, g));
  return { nodes: keep("node", up.nodes), links: keep("link", up.links), subcatchments: keep("subcatchment", up.subcatchments) };
}

let lastShown: { up: Upstream; styles: Record<StyledKind, LayerStyle>; shown: Upstream } | null = null;

/**
 * The network upstream of the selection that the map draws, while the upstream view is on
 * (null: off, or no map). The network is followed through hidden objects: only what is
 * highlighted, counted and selected leaves them out.
 */
export function useUpstream(): Upstream | null {
  const on = useStore((s) => s.upstream);
  const g = useStore((s) => s.geometry);
  const selection = useStore((s) => s.selection);
  const styles = useStore((s) => s.styles);
  if (!on || !g) return null;
  const up = upstreamCached(g, selection);
  if (lastShown?.up !== up || lastShown.styles !== styles) lastShown = { up, styles, shown: shownUpstream(g, up, styles) };
  return lastShown.shown;
}

/** The upstream objects as a selection. */
export function upstreamRefs(up: Upstream): ObjRef[] {
  return [
    ...up.nodes.map((index): ObjRef => ({ kind: "node", index })),
    ...up.links.map((index): ObjRef => ({ kind: "link", index })),
    ...up.subcatchments.map((index): ObjRef => ({ kind: "subcatchment", index })),
  ];
}
