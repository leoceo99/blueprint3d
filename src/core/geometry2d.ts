/**
 * 2D 도형 기하.
 * 모든 도형은 "선 또는 원호" 구간의 닫힌 목록(outline)으로 바뀐다.
 * 원호는 DXF와 같은 bulge(= tan(호 각도 / 4))로 표현: 0이면 직선, 양수면 반시계 방향.
 * 화면 그리기, 3D 생성, 설계 검사가 모두 이 outline 하나를 기준으로 동작한다.
 */
import type { Corner, Shape2D } from "./types";

export type Pt = [number, number];

/** a에서 b로 가는 구간. bulge 0이면 직선 */
export interface Seg {
  a: Pt;
  b: Pt;
  bulge: number;
}

const EPS = 1e-9;

export function normRect(s: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.min(s.x, s.x + s.w);
  const y0 = Math.min(s.y, s.y + s.h);
  return { x: x0, y: y0, w: Math.abs(s.w), h: Math.abs(s.h) };
}

/** 사각형의 꼭짓점 (왼쪽아래부터 반시계 방향) */
export function rectPoints(s: { x: number; y: number; w: number; h: number }): Pt[] {
  const r = normRect(s);
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ];
}

// ---------------- 원호 계산 ----------------

export interface ArcInfo {
  center: Pt;
  r: number;
  /** 시작 각도 (라디안) */
  start: number;
  /** 회전량 (라디안, 양수면 반시계) */
  sweep: number;
  /** 호의 가운데 점 */
  mid: Pt;
}

export function arcInfo(s: Seg): ArcInfo | null {
  if (Math.abs(s.bulge) < EPS) return null;
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const c = Math.hypot(dx, dy);
  if (c < EPS) return null;
  const k = s.bulge;
  const h = (k * c) / 2; // 현에서 호까지 높이 (부호 포함)
  const r = (c * (1 + k * k)) / (4 * Math.abs(k));
  // 진행 방향의 왼쪽 법선
  const n: Pt = [-dy / c, dx / c];
  const m: Pt = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
  // 양수 bulge(반시계)는 진행 방향 오른쪽으로 볼록
  const mid: Pt = [m[0] - n[0] * h, m[1] - n[1] * h];
  const sign = Math.sign(k);
  const center: Pt = [mid[0] + n[0] * sign * r, mid[1] + n[1] * sign * r];
  return {
    center,
    r,
    start: Math.atan2(s.a[1] - center[1], s.a[0] - center[0]),
    sweep: 4 * Math.atan(k),
    mid,
  };
}

/** 세 점(시작, 지나는 점, 끝)을 지나는 원호의 bulge. 일직선이면 0 */
export function bulgeThrough(a: Pt, through: Pt, b: Pt): number {
  const cross = (b[0] - a[0]) * (through[1] - a[1]) - (b[1] - a[1]) * (through[0] - a[0]);
  const c = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (c < EPS) return 0;
  // 현에서 지나는 점까지의 거리로 근사하지 않고, 정확한 원을 구한다
  const ax = a[0], ay = a[1], bx = through[0], by = through[1], cx = b[0], cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < EPS) return 0;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  // 현 가운데에서 지나는 점 쪽 호 높이
  const half = c / 2;
  const distCenterToChord = Math.sqrt(Math.max(0, r * r - half * half));
  const m: Pt = [(ax + cx) / 2, (ay + cy) / 2];
  const sameSide = (through[0] - m[0]) * (ux - m[0]) + (through[1] - m[1]) * (uy - m[1]) > 0;
  const sag = sameSide ? r + distCenterToChord : r - distCenterToChord;
  // 지나는 점이 진행 방향 오른쪽(cross<0)이면 반시계(+)
  return (-Math.sign(cross) * sag) / half;
}

// ---------------- 도형 → outline ----------------

/** 꼭짓점 목록 + 변의 bulge + 꼭짓점 처리 → outline */
function polyOutline(pts: Pt[], bulges: number[] = [], corners: (Corner | null | undefined)[] = []): Seg[] {
  const n = pts.length;
  if (n < 2) return [];
  const bulgeAt = (i: number) => bulges[i] ?? 0;
  // 꼭짓점마다 들어오는 점(in)과 나가는 점(out), 그 사이 구간
  const inPt: Pt[] = [];
  const outPt: Pt[] = [];
  const cornerSeg: (Seg | null)[] = [];
  for (let i = 0; i < n; i++) {
    const v = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const c = corners[i];
    const straight = Math.abs(bulgeAt((i - 1 + n) % n)) < EPS && Math.abs(bulgeAt(i)) < EPS;
    const l1 = Math.hypot(v[0] - prev[0], v[1] - prev[1]);
    const l2 = Math.hypot(next[0] - v[0], next[1] - v[1]);
    if (!c || c.size <= 0 || !straight || l1 < EPS || l2 < EPS) {
      inPt.push(v);
      outPt.push(v);
      cornerSeg.push(null);
      continue;
    }
    const d1: Pt = [(v[0] - prev[0]) / l1, (v[1] - prev[1]) / l1];
    const d2: Pt = [(next[0] - v[0]) / l2, (next[1] - v[1]) / l2];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const dot = d1[0] * d2[0] + d1[1] * d2[1];
    const turn = Math.atan2(Math.abs(cross), dot); // 꺾이는 각도 (0~π)
    if (turn < 1e-6) {
      inPt.push(v);
      outPt.push(v);
      cornerSeg.push(null);
      continue;
    }
    // 꼭짓점에서 접점까지의 거리 (인접 변 길이의 절반을 넘지 않게)
    const maxD = Math.min(l1, l2) / 2;
    let d = c.kind === "fillet" ? c.size * Math.tan(turn / 2) : c.size;
    d = Math.min(d, maxD);
    const p1: Pt = [v[0] - d1[0] * d, v[1] - d1[1] * d];
    const p2: Pt = [v[0] + d2[0] * d, v[1] + d2[1] * d];
    inPt.push(p1);
    outPt.push(p2);
    cornerSeg.push({ a: p1, b: p2, bulge: c.kind === "fillet" ? Math.sign(cross) * Math.tan(turn / 4) : 0 });
  }
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    if (cornerSeg[i]) segs.push(cornerSeg[i]!);
    const j = (i + 1) % n;
    segs.push({ a: outPt[i], b: inPt[j], bulge: bulgeAt(i) });
  }
  return segs.filter((s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > EPS);
}

export function outline(s: Shape2D): Seg[] {
  if (s.kind === "circle") {
    const a: Pt = [s.cx + s.r, s.cy];
    const b: Pt = [s.cx - s.r, s.cy];
    return [
      { a, b, bulge: 1 },
      { a: b, b: a, bulge: 1 },
    ];
  }
  if (s.kind === "rect") return polyOutline(rectPoints(s), [], s.corners ?? []);
  // 열린 선 (13단계): 점 i → i+1 만 (닫는 변 없음, 모서리 처리 없음)
  if (s.kind === "poly" && s.open) return s.pts.slice(0, -1).map((a, i) => ({ a, b: s.pts[i + 1], bulge: s.bulges?.[i] ?? 0 }));
  if (s.kind === "poly") return polyOutline(s.pts, s.bulges, s.corners);
  // 장공
  const [a, b] = [s.a, s.b];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const hw = s.w / 2;
  if (L < EPS) return outline({ id: s.id, kind: "circle", hole: s.hole, cx: a[0], cy: a[1], r: hw });
  const n: Pt = [(-(b[1] - a[1]) / L) * hw, ((b[0] - a[0]) / L) * hw];
  const a1: Pt = [a[0] - n[0], a[1] - n[1]];
  const b1: Pt = [b[0] - n[0], b[1] - n[1]];
  const b2: Pt = [b[0] + n[0], b[1] + n[1]];
  const a2: Pt = [a[0] + n[0], a[1] + n[1]];
  return [
    { a: a1, b: b1, bulge: 0 },
    { a: b1, b: b2, bulge: 1 },
    { a: b2, b: a2, bulge: 0 },
    { a: a2, b: a1, bulge: 1 },
  ];
}

/** outline을 점 목록으로 근사 (닫힌 다각형, 마지막 점 = 첫 점 아님) */
export function flatten(s: Shape2D, maxAngle = Math.PI / 24): Pt[] {
  const out: Pt[] = [];
  for (const seg of outline(s)) {
    out.push(seg.a);
    const arc = arcInfo(seg);
    if (!arc) continue;
    const steps = Math.max(2, Math.ceil(Math.abs(arc.sweep) / maxAngle));
    for (let i = 1; i < steps; i++) {
      const t = arc.start + (arc.sweep * i) / steps;
      out.push([arc.center[0] + arc.r * Math.cos(t), arc.center[1] + arc.r * Math.sin(t)]);
    }
  }
  return out;
}

// ---------------- 질의 ----------------

export function shapeBounds(s: Shape2D): [number, number, number, number] {
  if (s.kind === "circle") return [s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r];
  const pts = flatten(s, Math.PI / 90);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function boundsOf(shapes: Shape2D[]): [number, number, number, number] | null {
  const solids = shapes.filter((s) => !s.hole && !isDegenerate(s));
  if (!solids.length) return null;
  const b = solids.map(shapeBounds);
  return [
    Math.min(...b.map((v) => v[0])),
    Math.min(...b.map((v) => v[1])),
    Math.max(...b.map((v) => v[2])),
    Math.max(...b.map((v) => v[3])),
  ];
}

export function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInShape(x: number, y: number, s: Shape2D): boolean {
  if (s.kind === "poly" && s.open) return false;
  if (s.kind === "circle") return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  if (s.kind === "rect" && !s.corners?.some(Boolean)) {
    const r = normRect(s);
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  if (s.kind === "slot") return distToSegment([x, y], s.a, s.b) <= s.w / 2;
  return pointInPoly(x, y, flatten(s));
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 각도 t가 원호 범위 안에 있는지 */
function angleInArc(t: number, arc: ArcInfo): boolean {
  const twoPi = Math.PI * 2;
  let rel = (t - arc.start) * Math.sign(arc.sweep);
  rel = ((rel % twoPi) + twoPi) % twoPi;
  return rel <= Math.abs(arc.sweep) + 1e-9;
}

export function distToSeg(p: Pt, s: Seg): number {
  const arc = arcInfo(s);
  if (!arc) return distToSegment(p, s.a, s.b);
  const t = Math.atan2(p[1] - arc.center[1], p[0] - arc.center[0]);
  if (angleInArc(t, arc)) return Math.abs(Math.hypot(p[0] - arc.center[0], p[1] - arc.center[1]) - arc.r);
  return Math.min(Math.hypot(p[0] - s.a[0], p[1] - s.a[1]), Math.hypot(p[0] - s.b[0], p[1] - s.b[1]));
}

/** 점에서 도형 경계까지 거리 */
export function distToBoundary(p: Pt, s: Shape2D): number {
  if (s.kind === "circle") return Math.abs(Math.hypot(p[0] - s.cx, p[1] - s.cy) - s.r);
  return Math.min(...outline(s).map((seg) => distToSeg(p, seg)));
}

/** 넓이 (부호 없음). 원호 구간도 정확히 계산 */
export function area(s: Shape2D): number {
  if (s.kind === "circle") return Math.PI * s.r * s.r;
  let a = 0;
  for (const seg of outline(s)) {
    a += (seg.a[0] * seg.b[1] - seg.b[0] * seg.a[1]) / 2;
    const arc = arcInfo(seg);
    // 원호와 현 사이 활꼴 넓이 (반시계면 +)
    if (arc) a += ((arc.r * arc.r) / 2) * (arc.sweep - Math.sin(arc.sweep));
  }
  return Math.abs(a);
}

export function shapeCenter(s: Shape2D): Pt {
  if (s.kind === "circle") return [s.cx, s.cy];
  if (s.kind === "slot") return [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
  const b = shapeBounds(s);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** 넓이가 0에 가깝거나 점이 부족한 도형은 무시 */
export function isDegenerate(s: Shape2D): boolean {
  if (s.kind === "rect") return Math.abs(s.w) < 1e-6 || Math.abs(s.h) < 1e-6;
  if (s.kind === "circle") return s.r < 1e-6;
  if (s.kind === "slot") return s.w < 1e-6;
  if (s.open) return s.pts.length < 2 || s.pts.every((q) => Math.hypot(q[0] - s.pts[0][0], q[1] - s.pts[0][1]) < 1e-6);
  if (s.pts.length < 3) return true;
  return area(s) < 1e-9;
}

// ---------------- 변형 ----------------

/** 도형 이동 (새 객체) */
export function translated<T extends Shape2D>(s: T, du: number, dv: number): T {
  const c = structuredClone(s);
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  if (c.kind === "rect") {
    c.x = r(c.x + du);
    c.y = r(c.y + dv);
  } else if (c.kind === "circle") {
    c.cx = r(c.cx + du);
    c.cy = r(c.cy + dv);
  } else if (c.kind === "poly") c.pts = c.pts.map(([u, v]) => [r(u + du), r(v + dv)]);
  else {
    c.a = [r(c.a[0] + du), r(c.a[1] + dv)];
    c.b = [r(c.b[0] + du), r(c.b[1] + dv)];
  }
  return c;
}

/** 점 (cu, cv)를 중심으로 회전 (새 객체). 사각형은 90° 배수가 아니면 다각형으로 바뀐다 */
export function rotated(s: Shape2D, cu: number, cv: number, angle: number): Shape2D {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  const rot = ([u, v]: Pt): Pt => [r(cu + (u - cu) * cos - (v - cv) * sin), r(cv + (u - cu) * sin + (v - cv) * cos)];
  const c = structuredClone(s);
  if (c.kind === "circle") {
    [c.cx, c.cy] = rot([c.cx, c.cy]);
    return c;
  }
  if (c.kind === "slot") {
    c.a = rot(c.a);
    c.b = rot(c.b);
    return c;
  }
  if (c.kind === "rect") {
    const quarter = Math.abs(Math.round(angle / (Math.PI / 2)) * (Math.PI / 2) - angle) < 1e-9;
    if (quarter) {
      const pts = rectPoints(c).map(rot);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      // 꼭짓점 처리도 같이 돌린다 (회전 후 새 왼쪽아래가 몇 번째인지)
      const k = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
      const corners = c.corners ? [0, 1, 2, 3].map((i) => c.corners![(i - k + 4) % 4] ?? null) : undefined;
      return { ...c, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), corners };
    }
    return { id: c.id, kind: "poly", hole: c.hole, pts: rectPoints(c).map(rot), corners: c.corners };
  }
  c.pts = c.pts.map(rot);
  return c;
}

/** 세로선 u = axis (dir "u") 또는 가로선 v = axis (dir "v")에 대해 대칭 (새 객체) */
export function mirrored(s: Shape2D, dir: "u" | "v", axis: number): Shape2D {
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  const m = ([u, v]: Pt): Pt => (dir === "u" ? [r(2 * axis - u), v] : [u, r(2 * axis - v)]);
  const c = structuredClone(s);
  if (c.kind === "circle") {
    [c.cx, c.cy] = m([c.cx, c.cy]);
    return c;
  }
  if (c.kind === "slot") {
    c.a = m(c.a);
    c.b = m(c.b);
    return c;
  }
  if (c.kind === "rect") {
    const nr = normRect(c);
    const [x0, y0] = m([nr.x, nr.y]);
    const [x1, y1] = m([nr.x + nr.w, nr.y + nr.h]);
    // 왼쪽아래(0)·오른쪽아래(1)·오른쪽위(2)·왼쪽위(3): 세로 대칭이면 0↔1, 3↔2 / 가로 대칭이면 0↔3, 1↔2
    const map = dir === "u" ? [1, 0, 3, 2] : [3, 2, 1, 0];
    const corners = c.corners ? map.map((j) => c.corners![j] ?? null) : undefined;
    return { ...c, x: Math.min(x0, x1), y: Math.min(y0, y1), w: nr.w, h: nr.h, corners };
  }
  // 다각형: 뒤집으면 돌아가는 방향이 바뀌므로 점 순서를 거꾸로
  const n = c.pts.length;
  const pts = c.pts.map(m).reverse();
  // 거꾸로 따라가면 부호가 바뀌고, 대칭으로 뒤집으면 또 바뀌므로 결국 그대로
  const bulges = c.bulges ? Array.from({ length: n }, (_, i) => c.bulges![(n - 2 - i + n) % n] ?? 0) : undefined;
  const corners = c.corners ? Array.from({ length: n }, (_, i) => c.corners![n - 1 - i] ?? null) : undefined;
  return { ...c, pts, bulges, corners };
}

/** 사각형을 같은 모양의 다각형으로 바꾼다 (변을 휘게 하려면 필요) */
export function rectToPoly(s: Extract<Shape2D, { kind: "rect" }>): Extract<Shape2D, { kind: "poly" }> {
  return { id: s.id, kind: "poly", hole: s.hole, pts: rectPoints(s), corners: s.corners ? [...s.corners] : undefined };
}
