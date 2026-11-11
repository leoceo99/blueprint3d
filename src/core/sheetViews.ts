/**
 * 도면 뷰 2.0 (14단계): 기본 3면도 말고 더 넣는 뷰 — 단면도 · 상세도 · 보조 투상도 · 등각 그림.
 * 형상 엔진 없이 숫자만: 뷰의 방향(카메라), 원으로 자르기(상세도), 해칭 선 만들기(단면도).
 *
 * 기본 뷰의 좌표 (u, v)는 3D와 이렇게 이어진다 (build.cameraFor와 같음):
 *   정면도: u = X, v = Z, 보는 사람은 −Y 쪽   평면도: u = X, v = Y, 보는 사람은 +Z 쪽   우측면도: u = Y, v = Z, 보는 사람은 +X 쪽
 */
import type { P3 } from "./featureModel";
import type { Prim, Pt } from "./sheetDims";
import type { ViewId } from "./types";

export type DrawingView =
  /** 단면도: 부모 뷰 위의 절단선 a→b (부모 뷰 좌표). 화살표 쪽을 보고, 그 반대쪽(보는 사람 쪽)을 잘라 냄 */
  | { id: string; kind: "section"; parent: ViewId; a: Pt; b: Pt; flip?: boolean; label: string; at?: Pt }
  /** 보조 투상도: 부모 뷰의 경사 모서리 a→b에 수직으로 본 그림 (자르지 않음) */
  | { id: string; kind: "aux"; parent: ViewId; a: Pt; b: Pt; flip?: boolean; label: string; at?: Pt }
  /** 상세도: 부모 뷰(기본 뷰 또는 단면도)의 원 안을 k배로 */
  | { id: string; kind: "detail"; parent: string; c: Pt; r: number; k: number; label: string; at?: Pt }
  /** 등각 그림 (입체) */
  | { id: string; kind: "iso"; label: string; at?: Pt };

export type DrawingViewKind = DrawingView["kind"];

export const VIEW_KIND_LABEL: Record<DrawingViewKind, string> = { section: "단면도", aux: "보조 투상도", detail: "상세도", iso: "등각 그림" };

/** 상세도 배율 */
export const DETAIL_SCALES = [2, 2.5, 4, 5, 10];

const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: P3): P3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const neg = (a: P3): P3 => [-a[0], -a[1], -a[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const clean = (a: P3): P3 => a.map((x) => (Math.abs(x) < 1e-12 ? 0 : x)) as P3;

/** 뷰의 카메라: x(화면 오른쪽), up(화면 위), toward(물체 → 보는 사람) */
export interface ViewCam {
  x: P3;
  up: P3;
  toward: P3;
}

export const STD_CAM: Record<ViewId, ViewCam> = {
  front: { x: [1, 0, 0], up: [0, 0, 1], toward: [0, -1, 0] },
  top: { x: [1, 0, 0], up: [0, 1, 0], toward: [0, 0, 1] },
  side: { x: [0, 1, 0], up: [0, 0, 1], toward: [1, 0, 0] },
};

/** 뷰 좌표 → 3D (깊이 0) */
export const viewToWorld = (c: ViewCam, q: Pt): P3 => add(mul(c.x, q[0]), mul(c.up, q[1]));
/** 3D → 뷰 좌표 */
export const worldToView = (c: ViewCam, p: P3): Pt => [dot(p, c.x), dot(p, c.up)];

/**
 * 절단선(또는 경사 모서리) a→b가 정하는 방향: 보는 방향 n(화살표 방향), 그 뷰의 카메라.
 * 평면은 선 방향 L과 부모의 깊이 방향 D를 품는다. 위쪽은 L·D 중 Z가 큰 쪽(위로), 둘 다 수평이면 D.
 */
export function cutCamera(parent: ViewId, a: Pt, b: Pt, flip = false): { n: P3; cam: ViewCam; origin: P3 } {
  const pc = STD_CAM[parent];
  const A = viewToWorld(pc, a);
  const B = viewToWorld(pc, b);
  const L = norm([B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
  const D = neg(pc.toward);
  let n = norm(cross(D, L));
  if (flip) n = neg(n);
  let up: P3;
  if (Math.abs(L[2]) < 1e-9 && Math.abs(D[2]) < 1e-9) up = D;
  else up = Math.abs(L[2]) >= Math.abs(D[2]) ? (L[2] >= 0 ? L : neg(L)) : D[2] >= 0 ? D : neg(D);
  const toward = neg(n);
  const x = norm(cross(up, toward));
  return { n: clean(n), cam: { x: clean(x), up: clean(up), toward: clean(toward) }, origin: A };
}

/** 등각 그림 카메라: 오른쪽 앞 위에서 */
export const ISO_CAM: ViewCam = (() => {
  const toward = norm([1, -1, 1]);
  const x = norm(cross([0, 0, 1], toward));
  const up = norm(cross(toward, x));
  return { x, up, toward };
})();

/** 워커에 보낼 요청: 그 뷰의 카메라 (+ 단면이면 자르는 평면) */
export interface ViewRequest {
  id: string;
  toward: P3;
  x: P3;
  /** 단면: 평면 위의 점과 남길 쪽 법선 */
  cut?: { p: P3; n: P3 };
}

export function viewRequest(v: DrawingView): ViewRequest | null {
  if (v.kind === "section" || v.kind === "aux") {
    const { n, cam, origin } = cutCamera(v.parent, v.a, v.b, v.flip);
    return { id: v.id, toward: cam.toward, x: cam.x, ...(v.kind === "section" ? { cut: { p: origin, n } } : {}) };
  }
  if (v.kind === "iso") return { id: v.id, toward: ISO_CAM.toward, x: ISO_CAM.x };
  return null; // 상세도는 부모 뷰의 선을 잘라 씀
}

/** 뷰 이름 (도면에 쓰는 글자) */
export function viewTitle(v: DrawingView): string {
  if (v.kind === "section") return `단면 ${v.label}-${v.label}`;
  if (v.kind === "aux") return `${v.label} 방향 보조 투상도`;
  if (v.kind === "detail") return `상세 ${v.label} (${fmtK(v.k)}:1)`;
  return "등각 그림";
}
const fmtK = (k: number) => String(Math.round(k * 100) / 100);

// 다음 뷰 문자·저장 값 검사는 문서를 열 때도 쓰므로 가벼운 파일로 따로 (첫 화면 코드에 이 파일이 딸려 오지 않게 — 14.8)
export { nextLabel, normalizeViews } from "./viewsNormalize";

// ---------------- 원으로 자르기 (상세도) ----------------

/** 선분·원호를 원(c, r) 안쪽만 남긴다 */
export function clipToCircle(prims: Prim[], c: Pt, r: number): Prim[] {
  const out: Prim[] = [];
  const inside = (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r + 1e-9;
  for (const p of prims) {
    if (p.t === "line") {
      const d: Pt = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
      const f: Pt = [p.a[0] - c[0], p.a[1] - c[1]];
      const A = d[0] * d[0] + d[1] * d[1];
      if (A < 1e-18) continue;
      const B = 2 * (f[0] * d[0] + f[1] * d[1]);
      const C = f[0] * f[0] + f[1] * f[1] - r * r;
      const disc = B * B - 4 * A * C;
      if (disc <= 0) continue;
      const sq = Math.sqrt(disc);
      const t0 = Math.max(0, (-B - sq) / (2 * A));
      const t1 = Math.min(1, (-B + sq) / (2 * A));
      if (t1 - t0 < 1e-9) continue;
      const at = (t: number): Pt => [p.a[0] + d[0] * t, p.a[1] + d[1] * t];
      out.push({ ...p, a: at(t0), b: at(t1) });
    } else if (p.t === "arc") {
      // 원호 각도 범위를 두 원의 교점에서 나누고, 가운데가 안쪽인 조각만
      const span = (((p.end - p.start) % 360) + 360) % 360 || 360;
      const cuts = [0, span];
      const dx = c[0] - p.c[0];
      const dy = c[1] - p.c[1];
      const dd = Math.hypot(dx, dy);
      if (dd > 1e-12 && dd < p.r + r && dd > Math.abs(p.r - r)) {
        const a = (p.r * p.r - r * r + dd * dd) / (2 * dd);
        const base = Math.atan2(dy, dx);
        const h = Math.acos(Math.max(-1, Math.min(1, a / p.r)));
        for (const ang of [base + h, base - h]) {
          let deg = ((((ang * 180) / Math.PI - p.start) % 360) + 360) % 360;
          if (deg > 1e-9 && deg < span - 1e-9) cuts.push(deg);
        }
      }
      cuts.sort((x, y) => x - y);
      for (let i = 0; i < cuts.length - 1; i++) {
        const m = ((p.start + (cuts[i] + cuts[i + 1]) / 2) * Math.PI) / 180;
        if (!inside([p.c[0] + p.r * Math.cos(m), p.c[1] + p.r * Math.sin(m)])) continue;
        if (cuts[i + 1] - cuts[i] < 1e-6) continue;
        out.push({ ...p, start: p.start + cuts[i], end: p.start + cuts[i + 1] });
      }
    } else if (p.pts.every(inside)) out.push(p);
  }
  return out;
}

// ---------------- 해칭 (단면도) ----------------

/**
 * 경계 선분들(닫힌 영역의 테두리, 순서·방향 상관없음) 안쪽을 기울기 angle(도)·간격 gap의 평행선으로 채운다.
 * 짝·홀 규칙 — 구멍(안쪽 테두리)은 비어 보인다
 */
export function hatchLines(segs: [Pt, Pt][], gap: number, angle = 45): [Pt, Pt][] {
  if (!segs.length || !(gap > 0)) return [];
  const a = (angle * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // 해칭 선이 가로가 되도록 돌린 좌표 (x', y')
  const rot = (p: Pt): Pt => [p[0] * ca + p[1] * sa, -p[0] * sa + p[1] * ca];
  const back = (p: Pt): Pt => [p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca];
  const R = segs.map(([p, q]) => [rot(p), rot(q)] as [Pt, Pt]);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [p, q] of R) {
    y0 = Math.min(y0, p[1], q[1]);
    y1 = Math.max(y1, p[1], q[1]);
  }
  const out: [Pt, Pt][] = [];
  for (let y = Math.ceil(y0 / gap) * gap; y <= y1; y += gap) {
    const xs: number[] = [];
    for (const [p, q] of R) {
      // 반만 열린 규칙: 끝점이 겹치는 곳을 두 번 세지 않게
      if (p[1] <= y === q[1] <= y) continue;
      xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) out.push([back([xs[i], y]), back([xs[i + 1], y])]);
  }
  return out;
}

/** 해칭으로 채운 넓이 (시험용 — 선 길이 × 간격) */
export const hatchArea = (lines: [Pt, Pt][], gap: number) => lines.reduce((s, [p, q]) => s + Math.hypot(q[0] - p[0], q[1] - p[1]), 0) * gap;
