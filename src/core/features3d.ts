/**
 * 3D 모델(B-rep)의 형상 읽기 (11단계): 면을 종류별로 읽어 도면 치수에 쓸 “특징 목록”을 만든다.
 *   - 축 방향 평면 → 그 축의 **높이(단차) 위치**
 *   - 축 방향 원통 → 한 바퀴면 구멍(오목)·보스/축(볼록), 일부면 **필렛 R**(오목: 안쪽, 볼록: 바깥 둥근 모서리)
 *   - 한 축과 나란한 기울어진 평면 → **모따기**(두 다리 길이)
 *   - 축 방향 원뿔 → 카운터싱크·구멍 모따기·축 끝 모따기
 *   - 축 방향 원환(토러스) → 회전체 모서리의 R
 * 다른 CAD의 STEP과 우리 부품(3면도에서 만든 3D)에 똑같이 쓴다. 화면과 무관 (워커에서 실행).
 */
import { getOC, type Shape3D } from "replicad";

import { isFull, PERP, type Axis, type ConeFeat, type CylFeat, type Features3D, type P3, type SlopeFeat, type TorusFeat } from "./featureTypes";

export { isFull, PERP };
export type { Axis, ConeFeat, CylFeat, Features3D, P3, SlopeFeat, TorusFeat };

const FULL = 2 * Math.PI * 0.98;
const round = (x: number) => Math.round(x * 1e4) / 1e4 + 0;
const axisOf = (d: number[], eps = 1e-6): Axis | -1 => d.findIndex((c) => Math.abs(Math.abs(c) - 1) < eps) as Axis | -1;

function normAngle(a: number): number {
  let t = a % (2 * Math.PI);
  if (t < 0) t += 2 * Math.PI;
  return 2 * Math.PI - t < 1e-7 ? 0 : t;
}

export function analyzeShape(shape: Shape3D): Features3D {
  const oc = getOC();
  const bb = shape.boundingBox.bounds as [P3, P3];
  const size = Math.max(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]);
  const tol = Math.max(1e-4, size * 1e-4);
  const out: Features3D = { levels: [[], [], []], cyl: [], cones: [], slopes: [], tori: [], other: 0 };
  const planes: { k: Axis; at: number; lo: P3; hi: P3 }[] = [];
  const cyls: CylFeat[] = [];

  for (const face of shape.faces) {
    let ad: any = null;
    try {
      const type = face.geomType;
      ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
      const mid = face.pointOnSurface(0.5, 0.5);
      const M: P3 = [mid.x, mid.y, mid.z];
      if (type === "PLANE") {
        const pos = ad.Plane().Position();
        const d = pos.Direction();
        const n = [d.X(), d.Y(), d.Z()];
        const k = axisOf(n, 1e-7);
        const fb = face.boundingBox.bounds as [P3, P3];
        if (k !== -1) {
          const loc = pos.Location();
          planes.push({ k: k as Axis, at: [loc.X(), loc.Y(), loc.Z()][k], lo: fb[0], hi: fb[1] });
          continue;
        }
        const zero = n.findIndex((c) => Math.abs(c) < 1e-7);
        if (zero >= 0 && n.filter((c) => Math.abs(c) < 1e-7).length === 1) {
          const [a, b] = PERP[zero as Axis];
          out.slopes.push({
            along: zero as Axis,
            axes: [a, b],
            legs: [round(fb[1][a] - fb[0][a]), round(fb[1][b] - fb[0][b])],
            lo: [fb[0][a], fb[0][b]],
            t0: fb[0][zero],
            t1: fb[1][zero],
            mid: M,
          });
        } else out.other++;
      } else if (type === "CYLINDRE") {
        const cyl = ad.Cylinder();
        const ax = cyl.Axis();
        const d = ax.Direction();
        const L = ax.Location();
        const dir = [d.X(), d.Y(), d.Z()];
        const k = axisOf(dir);
        if (k === -1) {
          out.other++;
          continue;
        }
        const r = cyl.Radius();
        const Lp: P3 = [L.X(), L.Y(), L.Z()];
        const { uMin, uMax, vMin, vMax } = face.UVBounds;
        const s = Math.sign(dir[k]);
        const a = Lp[k] + s * vMin;
        const b = Lp[k] + s * vMax;
        const [i, j] = PERP[k as Axis];
        const p: [number, number] = [Lp[i], Lp[j]];
        // 오목한지: 면 위 점의 바깥 법선이 축 쪽을 향하면 오목
        const nrm = face.normalAt(mid);
        const N = [nrm.x, nrm.y, nrm.z];
        const dot = (M[i] - Lp[i]) * N[i] + (M[j] - Lp[j]) * N[j];
        // 각도 범위: 시작·가운데·끝 점의 뷰 각도로 반시계 방향을 정한다
        const span = uMax - uMin;
        const ang = (q: { x: number; y: number; z: number }) => {
          const Q = [q.x, q.y, q.z];
          return Math.atan2(Q[j] - p[1], Q[i] - p[0]);
        };
        const aS = ang(face.pointOnSurface(0, 0.5));
        const aM = ang(mid);
        const aE = ang(face.pointOnSurface(1, 0.5));
        const ccw = Math.abs(normAngle(aM - aS) - span / 2) < Math.abs(normAngle(aS - aM) - span / 2);
        cyls.push({
          axis: k as Axis,
          p,
          r,
          t0: Math.min(a, b),
          t1: Math.max(a, b),
          a0: normAngle(ccw ? aS : aE),
          sweep: span,
          concave: dot < 0,
          mid: M,
        });
      } else if (type === "CONE") {
        // 이 빌드에는 gp_Cone이 연결돼 있지 않아서 면 위의 점으로 잰다: v=0, v=1의 원 두 개
        const P = (u: number, v: number): P3 => {
          const q = face.pointOnSurface(u, v);
          return [q.x, q.y, q.z];
        };
        const A = circle3(P(0, 0), P(1 / 3, 0), P(2 / 3, 0));
        const B = circle3(P(0, 1), P(1 / 3, 1), P(2 / 3, 1));
        if (!A || !B) {
          out.other++;
          continue;
        }
        const k = axisOf(A.n, 1e-5);
        if (k === -1) {
          out.other++;
          continue;
        }
        const [i, j] = PERP[k as Axis];
        const p: [number, number] = [A.c[i], A.c[j]];
        const [lo, hi] = A.c[k] <= B.c[k] ? [A, B] : [B, A];
        const semi = (Math.atan2(Math.abs(hi.r - lo.r), Math.abs(hi.c[k] - lo.c[k])) * 180) / Math.PI;
        const nrm = face.normalAt(mid);
        const N = [nrm.x, nrm.y, nrm.z];
        const dot = (M[i] - p[0]) * N[i] + (M[j] - p[1]) * N[j];
        out.cones.push({ axis: k as Axis, p: [round(p[0]), round(p[1])], t0: round(lo.c[k]), t1: round(hi.c[k]), r0: round(lo.r), r1: round(hi.r), semi: round(semi), concave: dot < 0, mid: M });
      } else if (type === "TORUS") {
        // 관 원(u 고정)과 큰 원(v 고정)을 점으로 맞춘다
        const P = (u: number, v: number): P3 => {
          const q = face.pointOnSurface(u, v);
          return [q.x, q.y, q.z];
        };
        const tube = circle3(P(0.5, 0), P(0.5, 1 / 3), P(0.5, 2 / 3));
        const ring = circle3(P(0, 0.5), P(1 / 3, 0.5), P(2 / 3, 0.5));
        if (!tube || !ring) {
          out.other++;
          continue;
        }
        const k = axisOf(ring.n, 1e-5);
        if (k === -1) {
          out.other++;
          continue;
        }
        const [i, j] = PERP[k as Axis];
        const R = Math.hypot(tube.c[i] - ring.c[i], tube.c[j] - ring.c[j]);
        const nrm = face.normalAt(mid);
        const N = [nrm.x, nrm.y, nrm.z];
        const dot = (M[0] - tube.c[0]) * N[0] + (M[1] - tube.c[1]) * N[1] + (M[2] - tube.c[2]) * N[2];
        out.tori.push({ axis: k as Axis, p: [round(ring.c[i]), round(ring.c[j])], R: round(R), r: round(tube.r), t: round(tube.c[k]), concave: dot < 0, mid: M });
      } else out.other++;
    } catch {
      out.other++;
    } finally {
      ad?.delete?.();
    }
  }

  // 같은 원통 조각 합치기 (같은 축·반지름·위치, 축 방향 범위가 겹침)
  for (const c of cyls) {
    const g = out.cyl.find(
      (o) =>
        o.axis === c.axis &&
        o.concave === c.concave &&
        Math.abs(o.r - c.r) < tol &&
        Math.hypot(o.p[0] - c.p[0], o.p[1] - c.p[1]) < tol &&
        o.t0 <= c.t1 + tol &&
        c.t0 <= o.t1 + tol &&
        !isFull(o),
    );
    if (g && (g.sweep + c.sweep >= FULL || adjacent(g, c))) {
      if (normAngle(g.a0 + g.sweep - c.a0) < 1e-3) g.sweep += c.sweep;
      else {
        g.a0 = c.a0;
        g.sweep += c.sweep;
      }
      g.t0 = Math.min(g.t0, c.t0);
      g.t1 = Math.max(g.t1, c.t1);
    } else out.cyl.push({ ...c, p: [...c.p] as [number, number] });
  }
  for (const c of out.cyl) {
    c.r = round(c.r);
    c.p = [round(c.p[0]), round(c.p[1])];
    c.t0 = round(c.t0);
    c.t1 = round(c.t1);
  }

  // 축 방향 평면 → 높이. 구멍 바닥·카운터보어 바닥(구멍과 같은 축의 원판·고리)은 구멍 지시가 맡으므로 뺀다
  const holes = out.cyl.filter((c) => c.concave && isFull(c));
  for (const pl of planes) {
    const [i, j] = PERP[pl.k];
    const w = pl.hi[i] - pl.lo[i];
    const h = pl.hi[j] - pl.lo[j];
    const cu = (pl.hi[i] + pl.lo[i]) / 2;
    const cv = (pl.hi[j] + pl.lo[j]) / 2;
    const holeFloor = holes.some(
      (c) => c.axis === pl.k && Math.hypot(c.p[0] - cu, c.p[1] - cv) < tol * 10 && Math.max(w, h) <= 2 * c.r + tol * 10 && pl.at > c.t0 - tol && pl.at < c.t1 + tol,
    );
    if (holeFloor) continue;
    out.levels[pl.k].push(pl.at);
  }
  for (const k of [0, 1, 2] as Axis[]) {
    out.levels[k].push(bb[0][k], bb[1][k]);
    out.levels[k] = uniq(out.levels[k], tol * 10);
  }
  return out;
}

/** 각도 범위가 이어지는지 (한쪽 끝이 다른 쪽 시작) */
function adjacent(a: CylFeat, b: CylFeat): boolean {
  return normAngle(a.a0 + a.sweep - b.a0) < 1e-3 || normAngle(b.a0 + b.sweep - a.a0) < 1e-3;
}

function uniq(xs: number[], tol: number): number[] {
  const s = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) if (!out.length || x - out[out.length - 1] > tol) out.push(round(x));
  return out;
}

/** 세 점을 지나는 원 (중심, 반지름, 평면의 단위 법선). 일직선이면 null */
export function circle3(a: P3, b: P3, c: P3): { c: P3; r: number; n: P3 } | null {
  const sub = (p: P3, q: P3): P3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p: P3, q: P3): P3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dotp = (p: P3, q: P3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dotp(n, n);
  if (nn < 1e-18) return null;
  // 외심: a + ((|ac|²(n×ab)... 표준 공식)
  const t1 = cross(n, ab).map((x) => x * dotp(ac, ac)) as P3;
  const t2 = cross(ac, n).map((x) => x * dotp(ab, ab)) as P3;
  const off: P3 = [(t1[0] + t2[0]) / (2 * nn), (t1[1] + t2[1]) / (2 * nn), (t1[2] + t2[2]) / (2 * nn)];
  const cc: P3 = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
  const L = Math.sqrt(nn);
  return { c: cc, r: Math.sqrt(dotp(off, off)), n: [n[0] / L, n[1] / L, n[2] / L] };
}
