/**
 * 가져온 3D(STEP) 모델에서 구멍 찾기: 축이 X·Y·Z 방향인 원통 면 중 안쪽으로 오목한 것.
 * 같은 축·같은 반지름으로 쪼개진 면은 합치고, 한 바퀴를 다 도는 것만 구멍으로 본다(모서리 R 제외).
 * 같은 축에 더 큰 막힌 원통이 겹쳐 있으면 카운터보어로 묶는다.
 * 결과는 각 뷰의 구멍 도형(뷰 좌표) → 도면의 구멍 지시·중심선·위치 치수에 쓴다.
 */
import { getOC, type Shape3D } from "replicad";
import type { Features3D } from "./featureTypes";
import type { Shape2D, ViewId } from "./types";

interface Cyl {
  axis: 0 | 1 | 2;
  /** 축이 지나는 뷰 좌표 */
  p: [number, number];
  r: number;
  t0: number;
  t1: number;
  span: number;
}

const VIEW_OF_AXIS: ViewId[] = ["side", "front", "top"];

export function detectHoles(shape: Shape3D): Record<ViewId, Shape2D[]> {
  const out: Record<ViewId, Shape2D[]> = { front: [], top: [], side: [] };
  const oc = getOC();
  const bb = shape.boundingBox.bounds as [[number, number, number], [number, number, number]];
  const size = Math.max(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]);
  const tol = Math.max(1e-4, size * 1e-4);
  const cyls: Cyl[] = [];
  for (const face of shape.faces) {
    try {
      if (face.geomType !== "CYLINDRE") continue;
      const ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
      const cyl = ad.Cylinder();
      const ax = cyl.Axis();
      const d = ax.Direction();
      const loc = ax.Location();
      const dir = [d.X(), d.Y(), d.Z()];
      const L = [loc.X(), loc.Y(), loc.Z()];
      const r = cyl.Radius();
      ad.delete();
      const k = dir.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-6) as 0 | 1 | 2 | -1;
      if (k < 0) continue;
      const { uMin, uMax, vMin, vMax } = face.UVBounds;
      const s = Math.sign(dir[k]);
      const a = L[k] + s * vMin;
      const b = L[k] + s * vMax;
      // 오목한지: 면 위 한 점의 법선이 축 쪽을 향하면 구멍
      const pt = face.pointOnSurface(0.5, 0.5);
      const n = face.normalAt(pt);
      const P = [pt.x, pt.y, pt.z];
      const N = [n.x, n.y, n.z];
      let dot = 0;
      for (let i = 0; i < 3; i++) if (i !== k) dot += (P[i] - L[i]) * N[i];
      if (dot >= 0) continue;
      const p: [number, number] = k === 2 ? [L[0], L[1]] : k === 1 ? [L[0], L[2]] : [L[1], L[2]];
      cyls.push({ axis: k as 0 | 1 | 2, p, r, t0: Math.min(a, b), t1: Math.max(a, b), span: uMax - uMin });
    } catch {
      /* 읽을 수 없는 면은 건너뛴다 */
    }
  }
  // 같은 원통 조각 합치기
  const groups: Cyl[] = [];
  for (const c of cyls) {
    const g = groups.find(
      (o) => o.axis === c.axis && Math.abs(o.r - c.r) < tol && Math.hypot(o.p[0] - c.p[0], o.p[1] - c.p[1]) < tol && o.t0 <= c.t1 + tol && c.t0 <= o.t1 + tol,
    );
    if (g) {
      g.span += c.span;
      g.t0 = Math.min(g.t0, c.t0);
      g.t1 = Math.max(g.t1, c.t1);
    } else groups.push({ ...c, p: [...c.p] as [number, number] });
  }
  const holes = groups.filter((g) => g.span >= 2 * Math.PI * 0.9);
  const used = new Set<Cyl>();
  let seq = 0;
  // 작은 구멍부터: 같은 축에 더 큰 막힌 원통이 한쪽 끝을 공유하면 카운터보어
  holes.sort((a, b) => a.r - b.r);
  for (const h of holes) {
    if (used.has(h)) continue;
    used.add(h);
    const k = h.axis;
    const lo = bb[0][k];
    const hi = bb[1][k];
    const through = h.t0 <= lo + tol * 10 && h.t1 >= hi - tol * 10;
    const cb = holes.find(
      (o) =>
        !used.has(o) &&
        o.axis === k &&
        o.r > h.r + tol &&
        Math.hypot(o.p[0] - h.p[0], o.p[1] - h.p[1]) < tol &&
        (Math.abs(o.t1 - h.t1) < tol * 10 || Math.abs(o.t0 - h.t0) < tol * 10 || Math.abs(o.t0 - h.t1) < tol * 10 || Math.abs(o.t1 - h.t0) < tol * 10),
    );
    const shape: Extract<Shape2D, { kind: "circle" }> = {
      id: `d${seq++}`,
      kind: "circle",
      hole: true,
      cx: round(h.p[0]),
      cy: round(h.p[1]),
      r: round(h.r),
    };
    let t0 = h.t0;
    let t1 = h.t1;
    if (cb) {
      used.add(cb);
      t0 = Math.min(h.t0, cb.t0);
      t1 = Math.max(h.t1, cb.t1);
      shape.spec = { size: "", purpose: "custom", head: "counterbore", cbDiameter: round(cb.r * 2), cbDepth: round(cb.t1 - cb.t0) };
    }
    if (!(through || (t0 <= lo + tol * 10 && t1 >= hi - tol * 10))) shape.depth = round(t1 - t0);
    out[VIEW_OF_AXIS[k]].push(shape);
  }
  return out;
}

const round = (x: number) => Math.round(x * 1e4) / 1e4 + 0;

/**
 * 구멍 입구의 원뿔(카운터싱크·모따기)을 구멍에 붙인다: 머리 자리 정보와, 원뿔까지 합친 깊이(관통 여부).
 * features3d가 찾은 원뿔을 쓴다 (11단계).
 */
export function applyCones(holes: Record<ViewId, Shape2D[]>, f: Features3D, bb: [[number, number, number], [number, number, number]]) {
  const AX: Record<ViewId, 0 | 1 | 2> = { side: 0, front: 1, top: 2 };
  for (const v of ["front", "top", "side"] as ViewId[]) {
    const k = AX[v];
    const thick = bb[1][k] - bb[0][k];
    for (const h of holes[v]) {
      if (h.kind !== "circle") continue;
      const cone = f.cones.find(
        (c) => c.concave && c.axis === k && Math.hypot(c.p[0] - h.cx, c.p[1] - h.cy) < 0.01 && Math.abs(Math.min(c.r0, c.r1) - h.r) < 0.02,
      );
      if (!cone) continue;
      const rmax = Math.max(cone.r0, cone.r1);
      if (!h.spec) h.spec = { size: "", purpose: "custom", head: "countersink", csDiameter: round(rmax * 2), csAngle: round(cone.semi * 2) };
      if (h.depth !== undefined) {
        const d = h.depth + (cone.t1 - cone.t0);
        if (d >= thick - 1e-3) delete h.depth;
        else h.depth = round(d);
      }
    }
  }
}
