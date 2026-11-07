/**
 * 3D → 2D 출력 도면 (3각법 3면도).
 *
 * - 3D 엔진의 투영선(외형선·숨은선)을 선분과 원호로 읽어 용지 위에 척도대로 배치한다.
 * - 용지(A4/A3/A2 가로)와 척도는 자동으로 고르거나 직접 지정.
 * - 전체 치수, 구멍 위치(부품 모서리 기준 좌표 치수), 구멍 지시("4×M5 탭 깊이 12"), 중심선, 표제란.
 * - SVG(화면·인쇄용, 용지 mm 그대로)와 DXF(실제 크기 1:1, 원호는 ARC)로 내보낸다.
 *
 * 좌표: 용지 mm, 왼쪽 아래가 원점, 위가 +y. SVG로 바꿀 때만 y를 뒤집는다.
 */
import { flatten, isDegenerate, normRect } from "./geometry2d";
import { holeLabel } from "./standards";
import { projUnit } from "./params";
import { fmtLen, MM_PER_INCH, type Unit } from "./units";
import type { BuildResult, Project, Shape2D, SheetInfo, ViewId } from "./types";
import { VIEW_IDS, VIEW_LABEL } from "./types";

type Pt = [number, number];

export type Layer = "VISIBLE" | "HIDDEN" | "CENTER" | "DIM" | "FRAME";

export type Prim =
  | { layer: Layer; t: "line"; a: Pt; b: Pt }
  /** start→end 반시계 방향(도) */
  | { layer: Layer; t: "arc"; c: Pt; r: number; start: number; end: number }
  /** 화살표 같은 채운 다각형 */
  | { layer: Layer; t: "fill"; pts: Pt[] };

export interface SheetText {
  at: Pt;
  text: string;
  /** 글자 높이 (용지 mm) */
  size: number;
  rotate?: number;
  anchor?: "start" | "middle" | "end";
  bold?: boolean;
}

export interface Sheet {
  svg: string;
  prims: Prim[];
  texts: SheetText[];
  /** 용지 크기 (mm) */
  width: number;
  height: number;
  paper: string;
  /** 용지 mm / 실제 mm */
  scale: number;
  scaleLabel: string;
  /** 치수 글자의 길이 단위 (DXF도 이 단위로 내보낸다) */
  units: Unit;
}

export const PAPERS: Record<"A4" | "A3" | "A2", [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
/** 표준 척도 (큰 것부터) */
export const SCALES: [number, string][] = [
  [5, "5:1"],
  [2, "2:1"],
  [1, "1:1"],
  [0.5, "1:2"],
  [0.2, "1:5"],
  [0.1, "1:10"],
  [0.05, "1:20"],
  [0.02, "1:50"],
];

const TXT = 3.5; // 치수 글자 높이 (ISO)
const ARROW = 3;
const r2 = (n: number) => Math.round(n * 1000) / 1000;
const f2 = (n: number) => String(Math.round(n * 100) / 100);
/** 치수 글자 (부품 단위). buildSheet가 시작할 때 정한다 */
let U: Unit = "mm";
const fl = (n: number) => fmtLen(n, U);

// ---------------- 투영선 읽기 (SVG 경로 → 선분/원호, 뷰 좌표) ----------------

/**
 * 3D 엔진이 준 SVG 경로(M L H V C Q A Z, 절대 좌표, y가 아래로)를 뷰 좌표(y 위로)의 선분·원호로 바꾼다.
 * 원(타원이 아닌) 원호는 원호 그대로, 곡선은 짧은 선분으로.
 */
export function parseProjection(d: string, layer: Layer): Prim[] {
  const tokens = d.match(/[MLHVCQAZmlhvcqaz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: Prim[] = [];
  const W = ([x, y]: Pt): Pt => [x, -y]; // SVG → 뷰 좌표
  const line = (a: Pt, b: Pt) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) out.push({ layer, t: "line", a: W(a), b: W(b) });
  };
  let p: Pt = [0, 0];
  let start: Pt = [0, 0];
  let i = 0;
  let cmd = "";
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    switch (cmd) {
      case "M":
        p = [num(), num()];
        start = p;
        cmd = "L";
        break;
      case "L": {
        const q: Pt = [num(), num()];
        line(p, q);
        p = q;
        break;
      }
      case "H": {
        const q: Pt = [num(), p[1]];
        line(p, q);
        p = q;
        break;
      }
      case "V": {
        const q: Pt = [p[0], num()];
        line(p, q);
        p = q;
        break;
      }
      case "C":
      case "Q": {
        const pts: Pt[] = cmd === "C" ? [[num(), num()], [num(), num()], [num(), num()]] : [[num(), num()], [num(), num()]];
        const e = pts[pts.length - 1];
        const n = 16;
        let prev = p;
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          let q: Pt;
          if (cmd === "C") {
            const [c1, c2] = pts;
            const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, dd = t ** 3;
            q = [a * p[0] + b * c1[0] + c * c2[0] + dd * e[0], a * p[1] + b * c1[1] + c * c2[1] + dd * e[1]];
          } else {
            const [c1] = pts;
            const a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t;
            q = [a * p[0] + b * c1[0] + c * e[0], a * p[1] + b * c1[1] + c * e[1]];
          }
          line(prev, q);
          prev = q;
        }
        p = e;
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const e: Pt = [num(), num()];
        const arc = svgArc(p, e, rx, ry, rot, !!large, !!sweep);
        if (arc && Math.abs(rx - ry) <= 1e-6 * Math.max(rx, ry)) {
          // SVG(y 아래)에서 구한 원호를 뷰 좌표(y 위)로: 각도와 방향이 뒤집힌다
          const s = -arc.t1;
          const sw = -arc.dt;
          const deg = (r: number) => (r * 180) / Math.PI;
          const [a0, a1] = sw >= 0 ? [s, s + sw] : [s + sw, s];
          out.push({ layer, t: "arc", c: [arc.cx, -arc.cy], r: arc.r, start: deg(a0), end: deg(a1) });
        } else if (arc) {
          // 타원 원호: 선분으로
          const n = Math.max(8, Math.ceil(Math.abs(arc.dt) / (Math.PI / 36)));
          let prev = p;
          for (let k = 1; k <= n; k++) {
            const t = arc.t1 + (arc.dt * k) / n;
            const x = arc.rx * Math.cos(t), y = arc.ry * Math.sin(t);
            const q: Pt = [arc.cos * x - arc.sin * y + arc.cx, arc.sin * x + arc.cos * y + arc.cy];
            line(prev, q);
            prev = q;
          }
        } else line(p, e);
        p = e;
        break;
      }
      case "Z":
        line(p, start);
        p = start;
        break;
      default:
        i++;
    }
  }
  return out;
}

/** SVG 끝점 방식 원호 → 중심/반지름/시작각/회전량 (SVG 좌표) */
function svgArc(p0: Pt, p1: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean) {
  if (!rx || !ry) return null;
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, r: rx, t1, dt, cos, sin };
}

// ---------------- 배치 ----------------

interface ViewBox {
  min: Pt;
  max: Pt;
}

/** 뷰 둘레에 치수용으로 비워 둘 자리 (용지 mm) */
const PAD = { left: 24, bottom: 24, top: 10, right: 10, gap: 22 };
const BORDER = { left: 20, right: 10, top: 10, bottom: 10 };
const TITLE_H = 34;
const TITLE_W = 180;

function parseScale(s: string | undefined): number | null {
  if (!s || s === "auto") return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) / Number(m[2]) : null;
}

function scaleLabel(s: number): string {
  const found = SCALES.find(([v]) => Math.abs(v - s) < 1e-9);
  if (found) return found[1];
  return s >= 1 ? `${f2(s)}:1` : `1:${f2(1 / s)}`;
}

/** 세 뷰를 척도 s로 놓았을 때 필요한 크기 (용지 mm) */
function needed(views: Record<ViewId, ViewBox>, s: number): [number, number] {
  const w = (v: ViewId) => (views[v].max[0] - views[v].min[0]) * s;
  const h = (v: ViewId) => (views[v].max[1] - views[v].min[1]) * s;
  const leftCol = Math.max(w("front"), w("top"));
  const bottomRow = Math.max(h("front"), h("side"));
  const width = PAD.left + leftCol + PAD.gap + w("side") + PAD.right;
  const height = PAD.bottom + bottomRow + PAD.gap + h("top") + PAD.top;
  return [width, height];
}

function areaOf(paper: [number, number]): [number, number] {
  return [paper[0] - BORDER.left - BORDER.right, paper[1] - BORDER.top - BORDER.bottom - TITLE_H];
}

/** 용지와 척도 고르기 */
export function chooseLayout(views: Record<ViewId, ViewBox>, info: SheetInfo = {}): { paper: keyof typeof PAPERS; scale: number } {
  const fixedScale = parseScale(info.scale);
  const papers = (info.paper && info.paper !== "auto" ? [info.paper] : ["A4", "A3", "A2"]) as (keyof typeof PAPERS)[];
  const fits = (paper: keyof typeof PAPERS, s: number) => {
    const [nw, nh] = needed(views, s);
    const [aw, ah] = areaOf(PAPERS[paper]);
    return nw <= aw && nh <= ah;
  };
  if (fixedScale) {
    const paper = papers.find((p) => fits(p, fixedScale)) ?? papers[papers.length - 1];
    return { paper, scale: fixedScale };
  }
  // 1:1이 들어가는 가장 작은 용지 → 없으면 그중 큰 용지에서 들어가는 가장 큰 척도
  for (const paper of papers) {
    const best = SCALES.find(([s]) => s <= 1 && fits(paper, s));
    if (best && best[0] === 1) {
      // 1:1로 넉넉하면 확대 척도도 시도 (작은 부품)
      const bigger = SCALES.find(([s]) => s > 1 && fits(paper, s));
      return { paper, scale: bigger ? bigger[0] : 1 };
    }
  }
  const paper = papers[papers.length - 1];
  const best = SCALES.find(([s]) => fits(paper, s));
  return { paper, scale: best ? best[0] : SCALES[SCALES.length - 1][0] };
}

// ---------------- 도면 만들기 ----------------

export function buildSheet(res: BuildResult, project: Project): Sheet {
  U = projUnit(project);
  const info = project.sheet ?? {};
  const pr = res.projections;
  const views = Object.fromEntries(
    VIEW_IDS.map((v) => {
      const b = pr[v].bounds ?? [[0, 0], [1, 1]];
      return [v, { min: [b[0][0], b[0][1]], max: [b[1][0], b[1][1]] } as ViewBox];
    }),
  ) as Record<ViewId, ViewBox>;
  const { paper, scale: s } = chooseLayout(views, info);
  const [PW, PH] = PAPERS[paper];

  // 세 뷰 묶음을 그림 영역 가운데에
  const [nw, nh] = needed(views, s);
  const [aw, ah] = areaOf([PW, PH]);
  const bx = BORDER.left + Math.max(0, (aw - nw) / 2);
  const by = BORDER.bottom + TITLE_H + Math.max(0, (ah - nh) / 2);
  const V = views;
  const leftColRight = Math.max(V.front.max[0] - V.front.min[0], V.top.max[0] - V.top.min[0]) * s;
  const bottomRowTop = Math.max(V.front.max[1] - V.front.min[1], V.side.max[1] - V.side.min[1]) * s;
  // 각 뷰 원점이 용지에서 놓이는 곳: 정면도와 평면도는 X, 정면도와 우측면도는 Z가 일직선
  const frontLeft = bx + PAD.left;
  const frontBottom = by + PAD.bottom;
  const origin: Record<ViewId, Pt> = {
    front: [frontLeft - V.front.min[0] * s, frontBottom - V.front.min[1] * s],
    top: [frontLeft - V.front.min[0] * s, frontBottom + bottomRowTop + PAD.gap - V.top.min[1] * s],
    side: [frontLeft + leftColRight + PAD.gap - V.side.min[0] * s, frontBottom - V.front.min[1] * s],
  };
  // 평면도는 정면도와 같은 X 기준이어야 하므로 X 원점은 정면도와 같게
  origin.top[0] = origin.front[0];
  const P = (v: ViewId, u: number, w: number): Pt => [origin[v][0] + u * s, origin[v][1] + w * s];
  const box = (v: ViewId) => ({ l: P(v, V[v].min[0], 0)[0], r: P(v, V[v].max[0], 0)[0], b: P(v, 0, V[v].min[1])[1], t: P(v, 0, V[v].max[1])[1] });

  const prims: Prim[] = [];
  const texts: SheetText[] = [];

  // 1) 투영선 (숨은선 먼저, 외형선이 위에)
  for (const v of VIEW_IDS) {
    for (const [layer, paths] of [
      ["HIDDEN", pr[v].hidden],
      ["VISIBLE", pr[v].visible],
    ] as const)
      for (const d of paths)
        for (const prim of parseProjection(d, layer)) prims.push(transformPrim(prim, (q) => P(v, q[0], q[1]), s));
  }

  // 가져온 3D 파일이면 3D에서 찾은 구멍을, 아니면 스케치 도형을 쓴다
  const feat: Project = res.holes && project.source ? { ...project, mode: "auto", views: res.holes } : project;

  // 2) 중심선과 구멍 표시
  addCenterLines(prims, feat, res, P, s);

  // 3) 치수: 구멍 위치(좌표 치수) → 전체 치수는 그 바깥
  const holeDims = addHoleDims(prims, texts, feat, V, P, box, s);
  const fb = box("front");
  const sb = box("side");
  const offFront = holeDims.front.bottom ? 16 : 9;
  const offLeft = holeDims.front.left ? 16 : 9;
  const offSide = holeDims.side.bottom ? 16 : 9;
  linearDim(prims, texts, [fb.l, fb.b], [fb.r, fb.b], "h", -offFront, fl(V.front.max[0] - V.front.min[0]));
  linearDim(prims, texts, [fb.l, fb.b], [fb.l, fb.t], "v", -offLeft, fl(V.front.max[1] - V.front.min[1]));
  linearDim(prims, texts, [sb.l, sb.b], [sb.r, sb.b], "h", -offSide, fl(V.side.max[0] - V.side.min[0]));

  // 4) 뷰 이름 (작게)
  for (const v of VIEW_IDS) {
    const b = box(v);
    texts.push({ at: [(b.l + b.r) / 2, b.t + 4], text: VIEW_LABEL[v], size: 2.5, anchor: "middle" });
  }

  // 5) 테두리와 표제란
  frame(prims, texts, PW, PH, project, info, scaleLabel(s), paper);

  const sheet: Sheet = { svg: "", prims, texts, width: PW, height: PH, paper, scale: s, scaleLabel: scaleLabel(s), units: U };
  sheet.svg = toSVG(sheet);
  return sheet;
}

function transformPrim(p: Prim, T: (q: Pt) => Pt, s: number): Prim {
  if (p.t === "line") return { ...p, a: T(p.a), b: T(p.b) };
  if (p.t === "arc") return { ...p, c: T(p.c), r: p.r * s };
  return { ...p, pts: p.pts.map(T) };
}

/** 어느 뷰에 그린 구멍이 3D에서 어느 축으로 뚫리는지 */
const DEPTH_AXIS: Record<ViewId, 0 | 1 | 2> = { front: 1, top: 2, side: 0 };

function addCenterLines(prims: Prim[], p: Project, res: BuildResult, P: (v: ViewId, u: number, w: number) => Pt, s: number) {
  const [[x0, y0, z0], [x1, y1, z1]] = res.bbox;
  const ext = 2 / s; // 바깥으로 2mm (용지)
  const C = (v: ViewId, a: [number, number], b: [number, number]) => prims.push({ layer: "CENTER", t: "line", a: P(v, a[0], a[1]), b: P(v, b[0], b[1]) });

  // 회전체: 중심축
  if (p.mode === "revolve") {
    C("front", [0, z0 - ext], [0, z1 + ext]);
    C("side", [0, z0 - ext], [0, z1 + ext]);
    const R = Math.max(Math.abs(x0), Math.abs(x1)) + ext;
    C("top", [-R, 0], [R, 0]);
    C("top", [0, -R], [0, R]);
  }

  for (const v of VIEW_IDS)
    for (const h of p.views[v]) {
      if (!h.hole || h.kind !== "circle" || isDegenerate(h)) continue;
      const r = h.r + ext;
      // 그 뷰: 십자 중심선
      C(v, [h.cx - r, h.cy], [h.cx + r, h.cy]);
      C(v, [h.cx, h.cy - r], [h.cx, h.cy + r]);
      // 다른 두 뷰: 구멍 축 (깊이만큼, 관통이면 끝까지)
      const ax = DEPTH_AXIS[v];
      const lo = [x0, y0, z0][ax];
      const hi = [x1, y1, z1][ax];
      const depth = h.depth ?? hi - lo;
      // 바깥 면에서 안쪽으로: 정면도는 Y 최소에서 +, 평면도는 Z 최대에서 −, 우측면도는 X 최대에서 −
      const [a, b] = v === "front" ? [lo, Math.min(hi, lo + depth)] : [Math.max(lo, hi - depth), hi];
      const A = a - ext;
      const B = b + ext;
      if (v === "top") {
        C("front", [h.cx, A], [h.cx, B]); // 정면도 (X, Z)
        C("side", [h.cy, A], [h.cy, B]); // 우측면도 (Y, Z)
      } else if (v === "front") {
        C("top", [h.cx, A], [h.cx, B]); // 평면도 (X, Y)
        C("side", [A, h.cy], [B, h.cy]); // 우측면도 (Y, Z)
      } else {
        C("front", [A, h.cy], [B, h.cy]); // 정면도 (X, Z)
        C("top", [A, h.cx], [B, h.cx]); // 평면도 (X, Y)
      }
    }
}

type BoxFn = (v: ViewId) => { l: number; r: number; b: number; t: number };

/** 구멍 위치(부품 왼쪽·아래 모서리 기준 좌표 치수)와 구멍 지시 */
function addHoleDims(
  prims: Prim[],
  texts: SheetText[],
  p: Project,
  V: Record<ViewId, ViewBox>,
  P: (v: ViewId, u: number, w: number) => Pt,
  box: BoxFn,
  s: number,
): Record<ViewId, { bottom: boolean; left: boolean }> {
  const used = { front: { bottom: false, left: false }, top: { bottom: false, left: false }, side: { bottom: false, left: false } };
  // 정면도와 우측면도 지시가 같은 칸을 쓰므로 줄 번호를 같이 센다 (우측면도 먼저)
  let calloutRows = 0;
  for (const v of ["side", "top", "front"] as ViewId[]) {
    const holes = p.views[v].filter(
      (h): h is Extract<Shape2D, { kind: "circle" | "slot" }> => h.hole && !isDegenerate(h) && (h.kind === "circle" || h.kind === "slot"),
    );
    const pockets = p.views[v].filter((h) => h.hole && !isDegenerate(h) && (h.kind === "rect" || h.kind === "poly"));
    if (!holes.length && !pockets.length) continue;
    const b = box(v);
    const minU = V[v].min[0];
    const minV = V[v].min[1];
    // 같은 구멍끼리 묶기 (지시 "4×M5 탭 깊이 12")
    type Group = { label: string; members: Shape2D[]; pcd?: { c: Pt; r: number } };
    const groups = new Map<string, Group>();
    for (const h of holes) {
      const label =
        h.kind === "circle"
          ? holeLabel(h.r * 2, h.spec, h.depth, false, U)
          : `장공 폭 ${fl(h.w)} 중심거리 ${fl(Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]))}${h.depth !== undefined ? ` 깊이 ${fl(h.depth)}` : " 관통"}`;
      const g = groups.get(label);
      if (g) g.members.push(h);
      else groups.set(label, { label, members: [h] });
    }
    // 볼트 원(PCD): 같은 원형 구멍 3개 이상이 한 원 위에 같은 간격으로
    for (const g of groups.values()) {
      const cs = g.members.filter((h): h is Extract<Shape2D, { kind: "circle" }> => h.kind === "circle").map((h) => [h.cx, h.cy] as Pt);
      if (cs.length < 3 || cs.length !== g.members.length) continue;
      const c: Pt = [cs.reduce((a, q) => a + q[0], 0) / cs.length, cs.reduce((a, q) => a + q[1], 0) / cs.length];
      const ds = cs.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]));
      const r = ds.reduce((a, d) => a + d, 0) / ds.length;
      if (r < 1e-6 || ds.some((d) => Math.abs(d - r) > 0.01)) continue;
      const angs = cs.map((q) => Math.atan2(q[1] - c[1], q[0] - c[0])).sort((a, b) => a - b);
      const step = (2 * Math.PI) / angs.length;
      const even = angs.every((a, i) => {
        const next = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
        return Math.abs(next - a - step) < 1e-3;
      });
      if (!even) continue;
      g.pcd = { c, r };
      g.label += `, PCD Ø${fl(r * 2)} 등배치`;
      // 볼트 원 (중심선)
      const [ccx, ccy] = P(v, c[0], c[1]);
      prims.push({ layer: "CENTER", t: "arc", c: [ccx, ccy], r: r * s, start: 0, end: 360 });
    }

    // 위치 치수용 구멍 중심 (볼트 원은 개별 구멍 대신 원의 중심)
    const centers: [number, number][] = [];
    for (const g of groups.values()) {
      if (g.pcd) {
        const midU = (V[v].min[0] + V[v].max[0]) / 2;
        const midV = (V[v].min[1] + V[v].max[1]) / 2;
        if (Math.abs(g.pcd.c[0] - midU) > 0.01 || Math.abs(g.pcd.c[1] - midV) > 0.01) centers.push(g.pcd.c);
        continue;
      }
      for (const h of g.members) {
        if (h.kind === "circle") centers.push([h.cx, h.cy]);
        else if (h.kind === "slot") centers.push(h.a, h.b);
      }
    }
    const uniq = (vals: number[]) => [...new Set(vals.map((x) => Math.round(x * 100) / 100))].sort((a, c) => a - c);
    const us = uniq(centers.map((c) => c[0])).filter((u) => u > minU + 1e-6 && u < V[v].max[0] + 1e-6);
    const vs = uniq(centers.map((c) => c[1])).filter((w) => w > minV + 1e-6 && w < V[v].max[1] + 1e-6);

    // 가로 좌표 치수: 아래쪽에 0과 각 구멍 중심
    if (us.length) {
      used[v].bottom = true;
      const yb = b.b - 5;
      ordinate(prims, texts, "h", [b.l, b.b], yb, "0");
      let lastX = b.l;
      for (const u of us) {
        const [x, y] = P(v, u, centers.find((c) => Math.abs(c[0] - u) < 0.006)![1]);
        prims.push({ layer: "DIM", t: "line", a: [x, y], b: [x, yb] });
        if (x - lastX >= TXT * 0.9) {
          texts.push({ at: [x + TXT * 0.35, yb - 1], text: fl(u - minU), size: TXT * 0.85, rotate: 90, anchor: "end" });
          lastX = x;
        }
      }
    }
    // 세로 좌표 치수: 왼쪽에 0과 각 구멍 중심
    if (vs.length) {
      used[v].left = true;
      const xl = b.l - 5;
      ordinate(prims, texts, "v", [b.l, b.b], xl, "0");
      let lastY = b.b;
      for (const w of vs) {
        const [x, y] = P(v, centers.find((c) => Math.abs(c[1] - w) < 0.006)![0], w);
        prims.push({ layer: "DIM", t: "line", a: [x, y], b: [xl, y] });
        if (y - lastY >= TXT * 0.9) {
          texts.push({ at: [xl - 1, y - TXT * 0.35], text: fl(w - minV), size: TXT * 0.85, anchor: "end" });
          lastY = y;
        }
      }
    }

    for (const h of pockets) {
      const sz = h.kind === "rect" ? `${fl(normRect(h).w)}×${fl(normRect(h).h)} ` : "";
      const label = `${sz}포켓${h.depth !== undefined ? ` 깊이 ${fl(h.depth)}` : " 관통"}`;
      groups.set(`${label}#${h.id}`, { label, members: [h] });
    }
    // 지시는 뷰 밖으로 빼서 겹치지 않게: 평면도는 오른쪽(빈 칸), 정면도·우측면도는 위쪽
    let k = 0;
    for (const g of groups.values()) {
      let knee: Pt;
      if (v === "top") knee = [b.r + 8, b.t - 3 - k * 6];
      else {
        const row = calloutRows++;
        knee = v === "front" ? [b.r + 6, b.t + 10 + row * 5.5] : [b.l + 4, b.t + 10 + row * 5.5];
      }
      // 지시선이 닿는 곳: 원은 지시 쪽을 향한 둘레, 그 밖은 외곽선에서 지시 글자에 가장 가까운 점
      const ref = (h: Shape2D): Pt => {
        if (h.kind === "circle") return P(v, h.cx, h.cy);
        let best: Pt = P(v, ...flatten(h)[0]);
        for (const q of flatten(h)) {
          const t = P(v, q[0], q[1]);
          if (Math.hypot(t[0] - knee[0], t[1] - knee[1]) < Math.hypot(best[0] - knee[0], best[1] - knee[1])) best = t;
        }
        return best;
      };
      const h = g.members.reduce((best, m) => {
        const [x, y] = ref(m);
        const [bx2, by2] = ref(best);
        return Math.hypot(x - knee[0], y - knee[1]) < Math.hypot(bx2 - knee[0], by2 - knee[1]) ? m : best;
      });
      let at: Pt;
      if (h.kind === "circle") {
        const [cx, cy] = P(v, h.cx, h.cy);
        const rr = h.r * s;
        const a = Math.atan2(knee[1] - cy, knee[0] - cx);
        at = [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
      } else at = ref(h);
      const text = (g.members.length > 1 ? `${g.members.length}×` : "") + g.label;
      leader(prims, texts, at, knee, text);
      k++;
    }
  }
  return used;
}

function ordinate(prims: Prim[], texts: SheetText[], dir: "h" | "v", corner: Pt, pos: number, label: string) {
  if (dir === "h") {
    prims.push({ layer: "DIM", t: "line", a: corner, b: [corner[0], pos] });
    texts.push({ at: [corner[0] + TXT * 0.35, pos - 1], text: label, size: TXT * 0.85, rotate: 90, anchor: "end" });
  } else {
    prims.push({ layer: "DIM", t: "line", a: corner, b: [pos, corner[1]] });
    texts.push({ at: [pos - 1, corner[1] - TXT * 0.35], text: label, size: TXT * 0.85, anchor: "end" });
  }
}

function arrowHead(prims: Prim[], tip: Pt, dir: Pt) {
  const L = Math.hypot(dir[0], dir[1]) || 1;
  const ux = dir[0] / L, uy = dir[1] / L;
  const w = ARROW * 0.18;
  prims.push({
    layer: "DIM",
    t: "fill",
    pts: [tip, [tip[0] - ux * ARROW - uy * w, tip[1] - uy * ARROW + ux * w], [tip[0] - ux * ARROW + uy * w, tip[1] - uy * ARROW - ux * w]],
  });
}

/** 지시선: 화살표 → 꺾임 → 글자 */
function leader(prims: Prim[], texts: SheetText[], tip: Pt, knee: Pt, text: string) {
  const tw = text.length * TXT * 0.62;
  prims.push({ layer: "DIM", t: "line", a: tip, b: knee });
  prims.push({ layer: "DIM", t: "line", a: knee, b: [knee[0] + tw, knee[1]] });
  arrowHead(prims, tip, [tip[0] - knee[0], tip[1] - knee[1]]);
  texts.push({ at: [knee[0] + 1, knee[1] + 1], text, size: TXT * 0.85, anchor: "start" });
}

/** 선형 치수 (보조선 + 치수선 + 양쪽 화살표 + 숫자) */
function linearDim(prims: Prim[], texts: SheetText[], a: Pt, b: Pt, dir: "h" | "v", off: number, label: string) {
  const gap = 1;
  if (dir === "h") {
    const y = a[1] + off;
    const sgn = Math.sign(off) || -1;
    prims.push({ layer: "DIM", t: "line", a: [a[0], a[1] + sgn * gap], b: [a[0], y + sgn * 1.5] });
    prims.push({ layer: "DIM", t: "line", a: [b[0], b[1] + sgn * gap], b: [b[0], y + sgn * 1.5] });
    prims.push({ layer: "DIM", t: "line", a: [a[0], y], b: [b[0], y] });
    arrowHead(prims, [a[0], y], [-1, 0]);
    arrowHead(prims, [b[0], y], [1, 0]);
    texts.push({ at: [(a[0] + b[0]) / 2, y + 1], text: label, size: TXT, anchor: "middle" });
  } else {
    const x = a[0] + off;
    const sgn = Math.sign(off) || -1;
    prims.push({ layer: "DIM", t: "line", a: [a[0] + sgn * gap, a[1]], b: [x + sgn * 1.5, a[1]] });
    prims.push({ layer: "DIM", t: "line", a: [b[0] + sgn * gap, b[1]], b: [x + sgn * 1.5, b[1]] });
    prims.push({ layer: "DIM", t: "line", a: [x, a[1]], b: [x, b[1]] });
    arrowHead(prims, [x, a[1]], [0, -1]);
    arrowHead(prims, [x, b[1]], [0, 1]);
    texts.push({ at: [x - 1, (a[1] + b[1]) / 2], text: label, size: TXT, rotate: 90, anchor: "middle" });
  }
}

/** 테두리, 주기, 표제란 */
function frame(prims: Prim[], texts: SheetText[], W: number, H: number, p: Project, info: SheetInfo, scale: string, paper: string) {
  const L = (a: Pt, b: Pt) => prims.push({ layer: "FRAME", t: "line", a, b });
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    L([x0, y0], [x1, y0]);
    L([x1, y0], [x1, y1]);
    L([x1, y1], [x0, y1]);
    L([x0, y1], [x0, y0]);
  };
  rect(BORDER.left, BORDER.bottom, W - BORDER.right, H - BORDER.top);
  // 표제란 (오른쪽 아래)
  const x1 = W - BORDER.right;
  const x0 = x1 - TITLE_W;
  const y0 = BORDER.bottom;
  const y1 = y0 + TITLE_H;
  rect(x0, y0, x1, y1);
  const rowH = TITLE_H / 3;
  L([x0, y0 + rowH], [x1, y0 + rowH]);
  L([x0, y0 + rowH * 2], [x1, y0 + rowH * 2]);
  const cols = [x0, x0 + 60, x0 + 120, x1];
  for (const cx of [cols[1], cols[2]]) L([cx, y0], [cx, y0 + rowH * 2]);
  L([x0 + 130, y0 + rowH * 2], [x0 + 130, y1]);
  const cell = (cx0: number, cx1: number, row: number, label: string, value: string, big = false) => {
    const cy = y0 + rowH * row;
    texts.push({ at: [cx0 + 1.5, cy + rowH - 3], text: label, size: 2 });
    texts.push({ at: [(cx0 + cx1) / 2, cy + 2.2], text: value || "—", size: big ? 4.5 : 3, anchor: "middle", bold: big });
  };
  const today = new Date().toISOString().slice(0, 10);
  cell(x0, x0 + 130, 2, "부품명", p.name, true);
  cell(x0 + 130, x1, 2, "척도 · 용지", `${scale} · ${paper}`);
  cell(cols[0], cols[1], 1, "재질", info.material ?? "");
  cell(cols[1], cols[2], 1, "수량", info.qty ?? "1");
  cell(cols[2], cols[3], 1, "투상법 · 단위", `3각법 · ${U === "inch" ? "inch" : "mm"}`);
  cell(cols[0], cols[1], 0, "일반 공차", info.tolerance ?? "KS B ISO 2768-m");
  cell(cols[1], cols[2], 0, "설계", info.drawnBy ?? "");
  cell(cols[2], cols[3], 0, "날짜", today);
  // 주기 (왼쪽 위)
  const notes = (info.note ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (notes.length) {
    texts.push({ at: [BORDER.left + 4, H - BORDER.top - 6], text: "주", size: 3, bold: true });
    notes.forEach((l, i) => texts.push({ at: [BORDER.left + 4, H - BORDER.top - 11 - i * 5], text: `${i + 1}. ${l}`, size: 2.8 }));
  }
}

// ---------------- 내보내기 ----------------

const STYLE: Record<Layer, { w: number; dash?: string; opacity?: number }> = {
  VISIBLE: { w: 0.5 },
  HIDDEN: { w: 0.3, dash: "2.5 1.2" },
  CENTER: { w: 0.2, dash: "8 1.5 1 1.5" },
  DIM: { w: 0.18 },
  FRAME: { w: 0.5 },
};

/**
 * DXF(R12) 글자: 파일은 코드 페이지로 읽히므로 한글 등은 \U+XXXX로, 지름·각도·± 기호는 AutoCAD 제어 코드로 바꾼다.
 */
export function dxfText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "Ø" || ch === "ø" || ch === "⌀") out += "%%c";
    else if (ch === "°") out += "%%d";
    else if (ch === "±") out += "%%p";
    else {
      const cp = ch.codePointAt(0)!;
      out += cp < 128 ? ch : cp <= 0xffff ? `\\U+${cp.toString(16).toUpperCase().padStart(4, "0")}` : "?";
    }
  }
  return out;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function toSVG(sh: Sheet): string {
  const H = sh.height;
  const X = (p: Pt) => `${r2(p[0])} ${r2(H - p[1])}`;
  const byLayer: Record<Layer, string[]> = { VISIBLE: [], HIDDEN: [], CENTER: [], DIM: [], FRAME: [] };
  const fills: string[] = [];
  for (const p of sh.prims) {
    if (p.t === "line") byLayer[p.layer].push(`M${X(p.a)}L${X(p.b)}`);
    else if (p.t === "arc") {
      const a0 = (p.start * Math.PI) / 180;
      const a1 = (p.end * Math.PI) / 180;
      const sp: Pt = [p.c[0] + p.r * Math.cos(a0), p.c[1] + p.r * Math.sin(a0)];
      const ep: Pt = [p.c[0] + p.r * Math.cos(a1), p.c[1] + p.r * Math.sin(a1)];
      let sweep = p.end - p.start;
      while (sweep <= 0) sweep += 360;
      if (sweep >= 359.999) {
        // 완전한 원은 반원 두 개로
        const mp: Pt = [p.c[0] - (sp[0] - p.c[0]), p.c[1] - (sp[1] - p.c[1])];
        byLayer[p.layer].push(`M${X(sp)}A${r2(p.r)} ${r2(p.r)} 0 0 0 ${X(mp)}A${r2(p.r)} ${r2(p.r)} 0 0 0 ${X(sp)}`);
      } else byLayer[p.layer].push(`M${X(sp)}A${r2(p.r)} ${r2(p.r)} 0 ${sweep > 180 ? 1 : 0} 0 ${X(ep)}`);
    } else fills.push(`M${p.pts.map(X).join("L")}Z`);
  }
  const group = (layer: Layer) => {
    const st = STYLE[layer];
    return byLayer[layer].length
      ? `<path d="${byLayer[layer].join("")}" fill="none" stroke="#111" stroke-width="${st.w}" stroke-linecap="round" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/>`
      : "";
  };
  const txt = sh.texts
    .map((t) => {
      const [x, y] = X(t.at).split(" ");
      const rot = t.rotate ? ` transform="rotate(${-t.rotate} ${x} ${y})"` : "";
      const anchor = t.anchor ?? "start";
      return `<text x="${x}" y="${y}" font-size="${r2(t.size)}" text-anchor="${anchor}"${t.bold ? ' font-weight="700"' : ""}${rot}>${esc(t.text)}</text>`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sh.width}mm" height="${sh.height}mm" viewBox="0 0 ${sh.width} ${sh.height}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    group("FRAME") +
    group("DIM") +
    group("CENTER") +
    group("HIDDEN") +
    group("VISIBLE") +
    (fills.length ? `<path d="${fills.join("")}" fill="#111"/>` : "") +
    `<g fill="#111" font-family="'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif">${txt}</g>` +
    `</svg>`
  );
}

/**
 * AutoCAD 호환 DXF (R12).
 * 실제 크기(1:1)로 내보낸다: 용지 좌표를 척도로 나눈다. 글자와 테두리도 같은 비율이라 도면 모양은 그대로.
 * 레이어: VISIBLE(외형선), HIDDEN(숨은선), CENTER(중심선), DIM(치수), FRAME(테두리·표제란)
 */
export function sheetToDXF(sh: Sheet): string {
  // inch 부품은 inch 도면으로 ($INSUNITS 1 = inch, 4 = mm)
  const inch = sh.units === "inch";
  const k = 1 / sh.scale / (inch ? MM_PER_INCH : 1);
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), String(v));
  const n = (v: number) => r2(v * k);
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$INSUNITS"); g(70, inch ? 1 : 4);
  g(9, "$MEASUREMENT"); g(70, inch ? 0 : 1);
  g(9, "$LTSCALE"); g(40, r2(k));
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, 3);
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0);
  g(0, "LTYPE"); g(2, "HIDDEN"); g(70, 0); g(3, "Hidden __ __ __"); g(72, 65); g(73, 2); g(40, 3.7); g(49, 2.5); g(49, -1.2);
  g(0, "LTYPE"); g(2, "CENTER"); g(70, 0); g(3, "Center ____ _ ____"); g(72, 65); g(73, 4); g(40, 12); g(49, 8); g(49, -1.5); g(49, 1); g(49, -1.5);
  g(0, "ENDTAB");
  const layers: [Layer, number, string][] = [
    ["VISIBLE", 7, "CONTINUOUS"],
    ["HIDDEN", 8, "HIDDEN"],
    ["CENTER", 1, "CENTER"],
    ["DIM", 3, "CONTINUOUS"],
    ["FRAME", 7, "CONTINUOUS"],
  ];
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  for (const [name, color, lt] of layers) {
    g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, lt);
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const p of sh.prims) {
    if (p.t === "line") {
      g(0, "LINE"); g(8, p.layer);
      g(10, n(p.a[0])); g(20, n(p.a[1])); g(30, 0);
      g(11, n(p.b[0])); g(21, n(p.b[1])); g(31, 0);
    } else if (p.t === "arc") {
      let sweep = p.end - p.start;
      while (sweep <= 0) sweep += 360;
      if (sweep >= 359.999) {
        g(0, "CIRCLE"); g(8, p.layer);
        g(10, n(p.c[0])); g(20, n(p.c[1])); g(30, 0); g(40, n(p.r));
      } else {
        g(0, "ARC"); g(8, p.layer);
        g(10, n(p.c[0])); g(20, n(p.c[1])); g(30, 0); g(40, n(p.r));
        g(50, r2(((p.start % 360) + 360) % 360)); g(51, r2(((p.end % 360) + 360) % 360));
      }
    } else {
      // 화살표: 3점 SOLID
      const [a, b, c] = p.pts;
      g(0, "SOLID"); g(8, p.layer);
      g(10, n(a[0])); g(20, n(a[1])); g(30, 0);
      g(11, n(b[0])); g(21, n(b[1])); g(31, 0);
      g(12, n(c[0])); g(22, n(c[1])); g(32, 0);
      g(13, n(c[0])); g(23, n(c[1])); g(33, 0);
    }
  }
  for (const t of sh.texts) {
    const align = t.anchor === "middle" ? 1 : t.anchor === "end" ? 2 : 0;
    g(0, "TEXT"); g(8, "DIM");
    g(10, n(t.at[0])); g(20, n(t.at[1])); g(30, 0);
    g(40, n(t.size)); g(1, dxfText(t.text));
    if (t.rotate) g(50, t.rotate);
    if (align) {
      g(72, align);
      g(11, n(t.at[0])); g(21, n(t.at[1])); g(31, 0);
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}

