/**
 * 인식 결과(픽셀) → 프로젝트 도형(mm).
 * 뷰마다 원점을 3각법에 맞춰 잡는다: 정면도는 왼쪽 아래, 평면도는 정면도와 같은 X 원점,
 * 우측면도는 정면도와 같은 Z 원점. 좌표는 격자에 맞추고, 구멍 지름은 표준 지름에 붙인다.
 */
import { bulgeThrough } from "../geometry2d";
import { THREADS } from "../standards";
import type { Corner, Project, Shape2D, ViewId } from "../types";
import { emptyProject } from "../types";
import type { Prim } from "./contour";
import { isSlot, type Analysis, type Candidate, type DetectedView } from "./detect";
import type { P2 } from "./raster";

export interface ImportChoice {
  /** mm / px */
  mmPerPx: number;
  /** 뷰 번호 → 이름 (null = 쓰지 않음) */
  roles: Record<number, ViewId | null>;
  /** 구멍 후보 → 쓸지 */
  holes: Record<string, boolean>;
  /** 좌표를 맞출 격자 (mm) */
  snap: number;
  revolve: boolean;
  /** 뷰가 하나일 때 두께 */
  thickness: number;
  name: string;
}

export interface ViewMap {
  /** 뷰 원점(u=0, v=0)의 이미지 위치 (px) */
  ox: number;
  oy: number;
  /** 밑그림으로 보여 줄 이미지 영역 [x0, y0, x1, y1] (px) */
  crop: [number, number, number, number];
}

export const defaultChoice = (an: Analysis, mmPerPx: number, name = "가져온 도면"): ImportChoice => ({
  mmPerPx,
  roles: Object.fromEntries(an.views.map((v) => [v.id, v.role])),
  holes: Object.fromEntries(an.views.flatMap((v) => v.holes.map((h) => [h.id, h.on]))),
  snap: 0.5,
  revolve: an.revolve,
  thickness: 10,
  name,
});

/** 뷰마다 원점 */
export function viewMaps(an: Analysis, ch: ImportChoice): Partial<Record<ViewId, ViewMap>> {
  const byRole = (r: ViewId) => an.views.find((v) => ch.roles[v.id] === r);
  const F = byRole("front");
  const T = byRole("top");
  const S = byRole("side");
  const out: Partial<Record<ViewId, ViewMap>> = {};
  const margin = (v: DetectedView): ViewMap["crop"] => {
    const m = 0.08 * Math.max(v.box[2] - v.box[0], v.box[3] - v.box[1]) + 10;
    return [Math.max(0, v.box[0] - m), Math.max(0, v.box[1] - m), Math.min(an.w, v.box[2] + m), Math.min(an.h, v.box[3] + m)];
  };
  const cx = (v: DetectedView) => (v.outline.kind === "circle" ? v.outline.c[0] : (v.box[0] + v.box[2]) / 2);
  const cy = (v: DetectedView) => (v.outline.kind === "circle" ? v.outline.c[1] : (v.box[1] + v.box[3]) / 2);
  if (ch.revolve) {
    // 회전축이 원점 (정면도 u = 0, 평면도 가운데 = 0)
    const axisX = T ? cx(T) : F ? cx(F) : 0;
    if (F) out.front = { ox: axisX, oy: F.box[3], crop: margin(F) };
    if (T) out.top = { ox: axisX, oy: cy(T), crop: margin(T) };
    if (S) out.side = { ox: cx(S), oy: F ? F.box[3] : S.box[3], crop: margin(S) };
    return out;
  }
  if (F) out.front = { ox: F.box[0], oy: F.box[3], crop: margin(F) };
  if (T) out.top = { ox: F ? F.box[0] : T.box[0], oy: T.box[3], crop: margin(T) };
  if (S) out.side = { ox: S.box[0], oy: F ? F.box[3] : S.box[3], crop: margin(S) };
  return out;
}

/** 표준 구멍 지름 (볼트 관통, 탭 기초 구멍, 자리파기) */
const STANDARD_D = [...new Set(THREADS.flatMap((t) => [...t.clearance, t.tapDrill, t.cbDiameter, t.csDiameter, t.nominal]))].sort((a, b) => a - b);

export function snapDiameter(d: number, grid: number): number {
  const std = STANDARD_D.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));
  if (Math.abs(std - d) <= Math.max(0.12, 0.025 * d)) return std;
  const g = Math.min(grid, 0.5);
  return Math.max(g, Math.round(d / g) * g);
}

const snapv = (x: number, g: number) => Math.round(x / g) * g + 0;

interface Edge {
  a: P2;
  /** 원호면 호 위의 점 (mm) */
  through?: P2;
  r?: number;
}

/** 직선·원호 → 꼭짓점 + 휨 + 모서리 R (mm) */
function pathToPoly(prims: Prim[], map: (p: P2) => P2, g: number): { pts: P2[]; bulges: number[]; corners: (Corner | null)[] } | null {
  const n = prims.length;
  if (n < 2) return null;
  // 두 직선 사이에 끼고 각진 꼭짓점을 둥글린 원호는 모서리 R로
  const lineOf = (p: Prim) => ({ a: map(p.a), b: map(p.b) });
  const isFillet = (i: number) => {
    const p = prims[i];
    if (p.t !== "arc") return false;
    const A = prims[(i - 1 + n) % n];
    const B = prims[(i + 1) % n];
    if (A.t !== "line" || B.t !== "line" || n < 4) return false;
    const la = lineOf(A);
    const lb = lineOf(B);
    const da = [la.b[0] - la.a[0], la.b[1] - la.a[1]];
    const db = [lb.b[0] - lb.a[0], lb.b[1] - lb.a[1]];
    const sin = (da[0] * db[1] - da[1] * db[0]) / (Math.hypot(da[0], da[1]) * Math.hypot(db[0], db[1]) || 1);
    return Math.abs(sin) > Math.sin((30 * Math.PI) / 180);
  };
  const pts: P2[] = [];
  const edges: Edge[] = [];
  const corners: (Corner | null)[] = [];
  for (let i = 0; i < n; i++) {
    const p = prims[i];
    if (isFillet(i)) continue;
    const prevFillet = isFillet((i - 1 + n) % n);
    if (prevFillet) {
      // 꼭짓점 = 앞 직선과 이 직선의 교점
      const prevLine = lineOf(prims[(i - 2 + n) % n]);
      const thisLine = lineOf(p);
      const v = intersectLines(prevLine.a, prevLine.b, thisLine.a, thisLine.b) ?? map(p.a);
      pts.push(v);
      const arc = prims[(i - 1 + n) % n] as Extract<Prim, { t: "arc" }>;
      corners.push({ kind: "fillet", size: Math.max(g, snapv(arc.r * mmScale(map), g)) });
    } else {
      pts.push(map(p.a));
      corners.push(null);
    }
    edges.push(p.t === "arc" ? { a: map(p.a), through: map(p.m), r: p.r * mmScale(map) } : { a: map(p.a) });
  }
  // 격자 맞추기
  const snapped = pts.map((q) => [snapv(q[0], g), snapv(q[1], g)] as P2);
  // 겹친 점 정리
  const keep: number[] = [];
  snapped.forEach((q, i) => {
    const prev = snapped[keep[keep.length - 1] ?? -1];
    if (!prev || Math.hypot(prev[0] - q[0], prev[1] - q[1]) > 1e-9) keep.push(i);
  });
  if (keep.length > 1) {
    const f = snapped[keep[0]];
    const l = snapped[keep[keep.length - 1]];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) keep.pop();
  }
  if (keep.length < 3) return null;
  const outPts = keep.map((i) => snapped[i]);
  const bulges = keep.map((i, k) => {
    const e = edges[i];
    if (!e.through) return 0;
    const a = outPts[k];
    const b = outPts[(k + 1) % keep.length];
    // 원래 휜 방향과 반지름을 지키며 맞춘 끝점으로 다시 계산
    const orig = bulgeThrough(pts[i], e.through, pts[(i + 1) % pts.length]);
    const c = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = e.r ? snapv(e.r, g / 2 || 0.1) : 0;
    if (!r || c > 2 * r) return Math.round(orig * 1e4) / 1e4;
    const half = Math.asin(Math.min(1, c / (2 * r)));
    const sweep = Math.abs(orig) > 1 ? 2 * Math.PI - 2 * half : 2 * half;
    return Math.round(Math.sign(orig) * Math.tan(sweep / 4) * 1e4) / 1e4;
  });
  return { pts: outPts, bulges, corners: keep.map((i) => corners[i]) };
}

/** map 함수가 품은 mm/px (두 점 거리로 잰다) */
function mmScale(map: (p: P2) => P2): number {
  const a = map([0, 0]);
  const b = map([1, 0]);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function intersectLines(a1: P2, a2: P2, b1: P2, b2: P2): P2 | null {
  const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den;
  return [a1[0] + t * d1[0], a1[1] + t * d1[1]];
}

let seq = 0;
const nid = () => `i${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 다각형이 축에 나란한 사각형이면 사각형 도형으로 */
function polyToShape(poly: { pts: P2[]; bulges: number[]; corners: (Corner | null)[] }, hole: boolean): Shape2D {
  const { pts, bulges, corners } = poly;
  const axis = pts.every((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.abs(p[0] - q[0]) < 1e-9 || Math.abs(p[1] - q[1]) < 1e-9;
  });
  if (pts.length === 4 && bulges.every((b) => !b) && axis) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    // 사각형 꼭짓점 순서: 왼아래, 오아래, 오위, 왼위
    const order: P2[] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    const rc = order.map((o) => corners[pts.findIndex((p) => Math.abs(p[0] - o[0]) < 1e-9 && Math.abs(p[1] - o[1]) < 1e-9)] ?? null);
    return { id: nid(), kind: "rect", hole, x, y, w, h, ...(rc.some(Boolean) ? { corners: rc } : {}) };
  }
  // 반시계 방향으로 (넓이 양수)
  let area = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    area += p[0] * q[1] - q[0] * p[1];
  });
  let P = pts;
  let B = bulges;
  let C = corners;
  if (area < 0) {
    // 순서를 뒤집으면 변 i는 (n-1-i)번째가 되고 휨 부호도 바뀐다
    const n = pts.length;
    P = [...pts].reverse();
    B = P.map((_, i) => -bulges[(n - 2 - i + n) % n]);
    C = [...corners].reverse();
  }
  return {
    id: nid(),
    kind: "poly",
    hole,
    pts: P,
    ...(B.some((b) => b) ? { bulges: B } : {}),
    ...(C.some(Boolean) ? { corners: C } : {}),
  };
}

function candidateToShape(c: Candidate, map: (p: P2) => P2, s: number, g: number): Shape2D | null {
  const f = c.fit;
  if (f.kind === "circle") {
    const [cx, cy] = map(f.c);
    const d = snapDiameter(2 * f.r * s, g);
    const shape: Shape2D = { id: nid(), kind: "circle", hole: true, cx: snapv(cx, g), cy: snapv(cy, g), r: d / 2 };
    return shape;
  }
  if (f.kind === "slot") {
    const a = map(f.a);
    const b = map(f.b);
    const w = snapDiameter(2 * f.r * s, g);
    return { id: nid(), kind: "slot", hole: true, a: [snapv(a[0], g), snapv(a[1], g)], b: [snapv(b[0], g), snapv(b[1], g)], w };
  }
  if (isSlot(f) && f.kind === "path") {
    const arcs = f.prims.filter((p) => p.t === "arc") as Extract<Prim, { t: "arc" }>[];
    const a = map(arcs[0].c);
    const b = map(arcs[1].c);
    const w = snapDiameter(((arcs[0].r + arcs[1].r) / 2) * 2 * s, g);
    return { id: nid(), kind: "slot", hole: true, a: [snapv(a[0], g), snapv(a[1], g)], b: [snapv(b[0], g), snapv(b[1], g)], w };
  }
  if (f.kind !== "path") return null;
  const poly = pathToPoly(f.prims, map, g);
  return poly ? polyToShape(poly, true) : null;
}

/** 인식 결과와 선택으로 프로젝트 만들기 */
export function buildProject(an: Analysis, ch: ImportChoice): { project: Project; maps: Partial<Record<ViewId, ViewMap>> } {
  const p = emptyProject();
  p.name = ch.name;
  p.thickness = ch.thickness;
  p.mode = ch.revolve ? "revolve" : "auto";
  const maps = viewMaps(an, ch);
  const s = ch.mmPerPx;
  const g = ch.snap;
  for (const v of an.views) {
    const role = ch.roles[v.id];
    if (!role) continue;
    const m = maps[role]!;
    const map = (q: P2): P2 => [(q[0] - m.ox) * s, (m.oy - q[1]) * s];
    // 몸체 (회전체 모드에서는 정면도 단면만)
    if (!ch.revolve || role === "front") {
      if (v.outline.kind === "circle") {
        const [cx, cy] = map(v.outline.c);
        p.views[role].push({ id: nid(), kind: "circle", hole: false, cx: snapv(cx, g), cy: snapv(cy, g), r: snapDiameter(2 * v.outline.r * s, g) / 2 });
      } else if (v.outline.kind === "slot") {
        const a = map(v.outline.a);
        const b = map(v.outline.b);
        p.views[role].push({ id: nid(), kind: "slot", hole: false, a: [snapv(a[0], g), snapv(a[1], g)], b: [snapv(b[0], g), snapv(b[1], g)], w: snapDiameter(2 * v.outline.r * s, g) });
      } else {
        const poly = pathToPoly(v.outline.prims, map, g);
        if (poly) p.views[role].push(polyToShape(poly, false));
      }
    }
    const holes: Shape2D[] = [];
    for (const h of v.holes) {
      if (!ch.holes[h.id]) continue;
      const shape = candidateToShape(h, map, s, g);
      if (shape) holes.push(shape);
    }
    // 같은 지름의 구멍이 2개 이상이고 표준 볼트 관통 구멍(보통, M2~M12) 지름이면 규격을 붙인다
    for (const sh of holes) {
      if (sh.kind !== "circle") continue;
      const same = holes.filter((o) => o.kind === "circle" && Math.abs(o.r - sh.r) < 1e-9).length;
      const row = THREADS.find((t) => t.nominal <= 12 && Math.abs(t.clearance[1] - sh.r * 2) < 1e-9);
      if (same >= 2 && row) sh.spec = { size: row.size, purpose: "clearance-normal", head: "none" };
    }
    p.views[role].push(...holes);
  }
  return { project: p, maps };
}
