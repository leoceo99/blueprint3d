/**
 * 형상의 면·모서리 지문 만들기와 참조 다시 찾기 (13단계, 워커에서).
 * 지문의 순서는 shape.faces / shape.edges 순서와 같다 (3D 화면의 고르기와 이어짐).
 */
import { getOC, measureArea, type Edge, type Face, type Shape3D } from "replicad";
import { circle3 } from "./features3d";
import type { EdgeSig, FaceSig, P3 } from "./featureModel";
import { matchEdges, matchFaces, modelSize } from "./refMatch";

const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const v3 = (v: { x: number; y: number; z: number }): P3 => [r6(v.x), r6(v.y), r6(v.z)];
const unit = (a: P3): P3 => {
  const l = Math.hypot(...a) || 1;
  return [r6(a[0] / l), r6(a[1] / l), r6(a[2] / l)];
};

const FACE_T: Record<string, FaceSig["t"]> = { PLANE: "plane", CYLINDRE: "cylinder", CONE: "cone", SPHERE: "sphere", TORUS: "torus" };

export function faceSig(face: Face): FaceSig {
  const t = FACE_T[face.geomType] ?? "other";
  const c = v3(face.center);
  let a = 0;
  try {
    a = r6(measureArea(face));
  } catch {
    a = 0;
  }
  const sig: FaceSig = { t, c, a };
  try {
    if (t === "plane") sig.n = unit(v3(face.normalAt(face.center)));
    else if (t === "cylinder") {
      const oc = getOC();
      const ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
      const cyl = ad.Cylinder();
      const d = cyl.Axis().Direction();
      sig.n = unit([d.X(), d.Y(), d.Z()]);
      sig.r = r6(cyl.Radius());
      ad.delete?.();
    }
  } catch {
    /* 방향을 못 읽으면 위치·넓이로만 */
  }
  return sig;
}

export function edgeSig(edge: Edge): EdgeSig {
  const type = edge.geomType;
  let l = 0;
  try {
    l = r6(edge.length);
  } catch {
    l = 0;
  }
  const mid = v3(edge.pointAt(0.5));
  if (type === "LINE") return { t: "line", c: mid, d: unit(v3(edge.tangentAt(0.5))), l };
  if (type === "CIRCLE") {
    const c3 = circle3(v3(edge.pointAt(0.1)), v3(edge.pointAt(0.45)), v3(edge.pointAt(0.8)));
    if (c3) return { t: "circle", c: edge.isClosed ? (c3.c.map(r6) as P3) : mid, d: unit(c3.n), r: r6(c3.r), l };
  }
  return { t: "other", c: mid, l };
}

export function topoOf(shape: Shape3D): { faces: FaceSig[]; edges: EdgeSig[]; faceEdges: number[][] } {
  const edges = shape.edges;
  const byHash = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const h = e.hashCode;
    byHash.set(h, [...(byHash.get(h) ?? []), i]);
  });
  const faces = shape.faces;
  // 면마다 그 면의 모서리 번호 (면을 눌러 그 모서리를 한꺼번에 고르기)
  const faceEdges = faces.map((f) => {
    const out: number[] = [];
    for (const e of f.edges) {
      const i = (byHash.get(e.hashCode) ?? []).find((k) => edges[k].isSame(e));
      if (i !== undefined && !out.includes(i)) out.push(i);
    }
    return out;
  });
  return { faces: faces.map(faceSig), edges: edges.map(edgeSig), faceEdges };
}

const bboxOf = (shape: Shape3D) => shape.boundingBox.bounds as [P3, P3];

/** 저장한 면 지문 → 지금 형상의 면 (못 찾은 개수와 함께) */
export function resolveFaces(shape: Shape3D, sigs: FaceSig[]): { faces: Face[]; missing: number } {
  const faces = shape.faces;
  const idx = matchFaces(sigs, faces.map(faceSig), modelSize(bboxOf(shape)));
  return { faces: idx.filter((i) => i >= 0).map((i) => faces[i]), missing: idx.filter((i) => i < 0).length };
}

export function resolveEdges(shape: Shape3D, sigs: EdgeSig[]): { edges: Edge[]; missing: number } {
  const edges = shape.edges;
  const idx = matchEdges(sigs, edges.map(edgeSig), modelSize(bboxOf(shape)));
  return { edges: idx.filter((i) => i >= 0).map((i) => edges[i]), missing: idx.filter((i) => i < 0).length };
}
