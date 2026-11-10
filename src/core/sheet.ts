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
import { materialSheet } from "./materials";
import { isDegenerate } from "./geometry2d";
import { autoDims, checkNeeds } from "./autoDims";
import { renderDim, type DimDraw, type Layer, type Prim, type Pt, type SheetDim, type SheetText } from "./sheetDims";
import { projUnit } from "./params";
import { fmtLen, MM_PER_INCH, type Unit } from "./units";
import type { BuildResult, ProjectedView, Project, SheetInfo, ViewId } from "./types";
import { clipToCircle, cutCamera, hatchLines, STD_CAM, viewTitle, type DrawingView } from "./sheetViews";
import { VIEW_IDS, VIEW_LABEL } from "./types";

export type { Layer, Prim, SheetText };

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
  /** 그린 치수 (자동 + 직접 놓은 것) — 화면에서 고르기·DXF 진짜 치수용 */
  dims: DimDraw[];
  /** 빠진 치수 (형상 특징 중 크기나 위치가 도면에 없는 것) */
  missing: string[];
  /**
   * 뷰마다 용지 위치: 뷰 좌표 (u, v) → 용지 (o[0] + u·s, o[1] + v·s), 뷰 상자.
   * 기본 3면도(front·top·side, 숨긴 것은 없음) + 추가 뷰(단면·상세·보조·등각, 뷰 id). s가 없으면 도면 척도
   */
  views: Record<string, { o: Pt; box: [number, number, number, number]; s?: number }>;
}

/** 도면의 추가 뷰와 그 3D 계산 결과 (14단계) */
export interface SheetExtra {
  views?: DrawingView[];
  data?: Record<string, { view: ProjectedView; hatch?: [number, number][][] }>;
  /** 숨길 기본 뷰 */
  hide?: ViewId[];
}

/** 도면에 저장된 치수 고침 (도면마다): 직접 놓은 치수, 숨긴 자동 치수, 옮긴 자동 치수 */
export interface DimEdits {
  dims?: SheetDim[];
  hide?: string[];
  /** 자동 치수 id → 바꾼 값 (off·line·jog·ang·len·knee·text·suffix) */
  moved?: Record<string, Partial<SheetDim>>;
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

/** 추가 뷰 칸의 크기 (척도 s일 때 [폭, 높이]) */
type ExtraSize = (s: number) => [number, number];

/** 세 뷰(숨긴 뷰는 크기 0)와 추가 뷰 칸을 척도 s로 놓았을 때 필요한 크기 (용지 mm) */
function needed(views: Record<ViewId, ViewBox>, s: number, extra?: ExtraSize): [number, number] {
  const w = (v: ViewId) => (views[v].max[0] - views[v].min[0]) * s;
  const h = (v: ViewId) => (views[v].max[1] - views[v].min[1]) * s;
  const leftCol = Math.max(w("front"), w("top"));
  const bottomRow = Math.max(h("front"), h("side"));
  let width = PAD.left + leftCol + (w("side") > 0 ? PAD.gap + w("side") : 0) + PAD.right;
  let height = PAD.bottom + bottomRow + (h("top") > 0 ? PAD.gap + h("top") : 0) + PAD.top;
  if (extra) {
    const [ew, eh] = extra(s);
    if (ew > 0) {
      width += PAD.gap + ew;
      height = Math.max(height, eh + PAD.top + PAD.bottom);
    }
  }
  return [width, height];
}

function areaOf(paper: [number, number]): [number, number] {
  return [paper[0] - BORDER.left - BORDER.right, paper[1] - BORDER.top - BORDER.bottom - TITLE_H];
}

/** 용지와 척도 고르기 */
export function chooseLayout(views: Record<ViewId, ViewBox>, info: SheetInfo = {}, extra?: ExtraSize): { paper: keyof typeof PAPERS; scale: number } {
  const fixedScale = parseScale(info.scale);
  const papers = (info.paper && info.paper !== "auto" ? [info.paper] : ["A4", "A3", "A2"]) as (keyof typeof PAPERS)[];
  const fits = (paper: keyof typeof PAPERS, s: number) => {
    const [nw, nh] = needed(views, s, extra);
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

export function buildSheet(res: BuildResult, project: Project, edits: DimEdits = {}, extra: SheetExtra = {}): Sheet {
  U = projUnit(project);
  const info = project.sheet ?? {};
  const pr = res.projections;
  const hide = new Set(extra.hide ?? []);
  const shown = VIEW_IDS.filter((v) => !hide.has(v));
  const views = Object.fromEntries(
    VIEW_IDS.map((v) => {
      // 숨긴 뷰는 크기 0 (자리를 차지하지 않게)
      if (hide.has(v)) return [v, { min: [0, 0], max: [0, 0] } as ViewBox];
      const b = pr[v].bounds ?? [[0, 0], [1, 1]];
      return [v, { min: [b[0][0], b[0][1]], max: [b[1][0], b[1][1]] } as ViewBox];
    }),
  ) as Record<ViewId, ViewBox>;
  // 추가 뷰: 뷰 좌표 범위와 배율 (상세도는 k배)
  const xviews = (extra.views ?? [])
    .map((v) => ({ v, b: extraBounds(v, extra, pr, views), k: v.kind === "detail" ? v.k : 1 }))
    .filter((x): x is { v: DrawingView; b: [number, number, number, number]; k: number } => !!x.b);
  const XM = 4;
  const XLABEL = 8;
  const xsize = (x: (typeof xviews)[number], sc: number): [number, number] => [(x.b[2] - x.b[0]) * sc * x.k + 2 * XM, (x.b[3] - x.b[1]) * sc * x.k + 2 * XM + XLABEL];
  const extraSize: ExtraSize | undefined = xviews.some((x) => !x.v.at)
    ? (sc) => {
        const sz = xviews.filter((x) => !x.v.at).map((x) => xsize(x, sc));
        return [Math.max(...sz.map((z) => z[0])), sz.reduce((a, z) => a + z[1], 0) + (sz.length - 1) * 4];
      }
    : undefined;
  const { paper, scale: s } = chooseLayout(views, info, extraSize);
  const [PW, PH] = PAPERS[paper];

  // 세 뷰 묶음을 그림 영역 가운데에
  const [nw, nh] = needed(views, s, extraSize);
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

  // 1) 투영선 (숨은선 먼저, 외형선이 위에). 보이는 선은 뷰 좌표로도 둔다 (치수를 어느 뷰에 잴지)
  const vis = {} as Record<ViewId, Prim[]>;
  /** 뷰마다 선 (뷰 좌표, 외형선 + 숨은선) — 상세도가 잘라 씀 */
  const viewPrims: Record<string, Prim[]> = {};
  for (const v of VIEW_IDS) {
    vis[v] = [];
    viewPrims[v] = [];
    if (hide.has(v)) continue;
    for (const [layer, paths] of [
      ["HIDDEN", pr[v].hidden],
      ["VISIBLE", pr[v].visible],
    ] as const)
      for (const d of paths)
        for (const prim of parseProjection(d, layer)) {
          if (layer === "VISIBLE") vis[v].push(prim);
          viewPrims[v].push(prim);
          prims.push(transformPrim(prim, (q) => P(v, q[0], q[1]), s));
        }
  }

  // 가져온 3D 파일이면 3D에서 찾은 구멍을, 아니면 스케치 도형을 쓴다
  const feat: Project = res.holes && project.source ? { ...project, mode: "auto", views: res.holes } : project;

  // 2) 중심선과 구멍 표시 (숨긴 뷰는 빼고)
  {
    const cl: Prim[] = [];
    const owner: ViewId[] = [];
    addCenterLines(cl, feat, res, (v, u, w) => (owner.push(v), P(v, u, w)), s);
    // addCenterLines는 선 하나에 P를 두 번 부른다 (a, b)
    cl.forEach((pr2, i) => {
      if (!hide.has(owner[i * 2])) prims.push(pr2);
    });
  }

  // 2.5) 추가 뷰 배치·그리기 (14단계): 기본 3면도 오른쪽 칸에 위에서부터, 옮긴 뷰는 그 자리
  const xplaced: Record<string, { o: Pt; box: [number, number, number, number]; s: number }> = {};
  {
    const right = Math.max(...shown.map((v) => box(v).r + PAD.right), frontLeft);
    const x0 = right + PAD.gap;
    let ytop = PH - BORDER.top - PAD.top;
    const colW = extraSize ? extraSize(s)[0] : 0;
    for (const x of xviews) {
      const sv = s * x.k;
      const h = xsize(x, s)[1];
      // 뷰 상자 가운데: 옮긴 뷰는 그 자리, 아니면 오른쪽 칸에 위에서부터 (아래 글자 자리를 남기고)
      const center: Pt = x.v.at ?? [x0 + colW / 2, ytop - XM - (h - 2 * XM - XLABEL) / 2];
      if (!x.v.at) ytop -= h + 4;
      const mid: Pt = [(x.b[0] + x.b[2]) / 2, (x.b[1] + x.b[3]) / 2];
      const o: Pt = [center[0] - mid[0] * sv, center[1] - mid[1] * sv];
      xplaced[x.v.id] = { o, box: [o[0] + x.b[0] * sv, o[1] + x.b[1] * sv, o[0] + x.b[2] * sv, o[1] + x.b[3] * sv], s: sv };
    }
    // 상세도는 부모(단면도일 수도) 선이 있어야 하므로 나중에
    for (const x of [...xviews.filter((x) => x.v.kind !== "detail"), ...xviews.filter((x) => x.v.kind === "detail")]) drawExtra(x.v, xplaced[x.v.id], extra, viewPrims, prims, texts, s);
    // 부모 뷰의 표시: 절단선·화살표·문자, 보조 투상 화살표, 상세 원
    for (const x of xviews) {
      const pv = x.v;
      if ((pv.kind === "section" || pv.kind === "aux") && !hide.has(pv.parent)) markCut(pv, views[pv.parent], (q) => P(pv.parent, q[0], q[1]), s, prims, texts);
      if (pv.kind === "detail") {
        const par = isStd(pv.parent) ? (hide.has(pv.parent) ? null : { o: origin[pv.parent], s }) : xplaced[pv.parent] ? { o: xplaced[pv.parent].o, s: xplaced[pv.parent].s } : null;
        if (par) {
          const C: Pt = [par.o[0] + pv.c[0] * par.s, par.o[1] + pv.c[1] * par.s];
          prims.push({ layer: "DIM", t: "arc", c: C, r: pv.r * par.s, start: 0, end: 360 });
          texts.push({ at: [C[0] + pv.r * par.s * 0.75 + 1.5, C[1] + pv.r * par.s * 0.75 + 1.5], text: pv.label, size: 4, bold: true });
        }
      }
    }
  }

  // 3) 치수: 자동(형상 특징 + 구멍) → 숨기기·옮기기 → 직접 놓은 치수
  const area: [number, number, number, number] = [BORDER.left + 1.5, BORDER.bottom + 1.5, PW - BORDER.right - 1.5, PH - BORDER.top - 1.5];
  const titleBox: [number, number, number, number] = [PW - BORDER.right - TITLE_W - 1, BORDER.bottom, PW - BORDER.right, BORDER.bottom + TITLE_H + 1];
  const labelBoxes = shown.map((v): [number, number, number, number] => {
    const b = box(v);
    return [(b.l + b.r) / 2 - 9, b.t + 3, (b.l + b.r) / 2 + 9, b.t + 7];
  });
  // 추가 뷰 자리(+ 아래 이름)에는 자동 치수를 놓지 않는다
  const extraBoxes = Object.values(xplaced).map((x): [number, number, number, number] => [x.box[0] - 2, x.box[1] - XLABEL, x.box[2] + 2, x.box[3] + 2]);
  const auto = autoDims({ feat, f3: res.features, V, vis, P: (v, q) => P(v, q[0], q[1]), s, fmt: fl, unit: U, area, keepOut: [titleBox, ...labelBoxes, ...extraBoxes] });
  // 볼트 원 (중심선)
  for (const v of VIEW_IDS) for (const c of pcdCircles(feat, v)) prims.push({ layer: "CENTER", t: "arc", c: P(v, c.c[0], c.c[1]), r: c.r * s, start: 0, end: 360 });
  const hidden = new Set(edits.hide ?? []);
  const dims: SheetDim[] = [
    ...auto.dims.filter((d) => !hidden.has(d.id)).map((d) => (edits.moved?.[d.id] ? ({ ...d, ...edits.moved[d.id], id: d.id, kind: d.kind, view: d.view } as SheetDim) : d)),
    ...(edits.dims ?? []),
  ];
  // 치수는 따로 둔다 (화면에서 하나씩 고르기·옮기기, DXF의 진짜 치수) — 모든 글자는 sheetTexts(sheet)
  const toPaper = (v: string, q: Pt): Pt | null => {
    if (isStd(v)) return hide.has(v) ? null : P(v, q[0], q[1]);
    const x = xplaced[v];
    return x ? [x.o[0] + q[0] * x.s, x.o[1] + q[1] * x.s] : null;
  };
  const draws = dims
    .filter((d) => toPaper(d.view, [0, 0]))
    .map((d) => renderDim(d, (q) => toPaper(d.view, q)!, s, fl));

  // 4) 뷰 이름 (작게)
  for (const v of shown) {
    const b = box(v);
    texts.push({ at: [(b.l + b.r) / 2, b.t + 4], text: VIEW_LABEL[v], size: 2.5, anchor: "middle" });
  }

  // 5) 테두리와 표제란
  frame(prims, texts, PW, PH, project, info, scaleLabel(s), paper);

  const viewsOut: Sheet["views"] = {
    ...Object.fromEntries(
      shown.map((v) => {
        const b = box(v);
        return [v, { o: origin[v], box: [b.l, b.b, b.r, b.t] as [number, number, number, number] }];
      }),
    ),
    ...xplaced,
  };
  const sheet: Sheet = {
    svg: "",
    prims,
    texts,
    width: PW,
    height: PH,
    paper,
    scale: s,
    scaleLabel: scaleLabel(s),
    units: U,
    dims: draws,
    missing: checkNeeds(auto.needs, dims, fl),
    views: viewsOut,
  };
  sheet.svg = toSVG(sheet);
  return sheet;
}

const isStd = (v: string): v is ViewId => (VIEW_IDS as string[]).includes(v);

/** 추가 뷰의 범위 (뷰 좌표) — 그릴 것이 없으면 null */
function extraBounds(v: DrawingView, extra: SheetExtra, pr: BuildResult["projections"], std: Record<ViewId, ViewBox>): [number, number, number, number] | null {
  if (v.kind === "detail") return [v.c[0] - v.r, v.c[1] - v.r, v.c[0] + v.r, v.c[1] + v.r];
  void pr;
  void std;
  const d = extra.data?.[v.id];
  const b = d?.view.bounds;
  if (!b) return null;
  return [b[0][0], b[0][1], b[1][0], b[1][1]];
}

/** 추가 뷰 그리기 (선·해칭·이름). 뷰 좌표 선은 viewPrims[id]에 (상세도가 잘라 씀) */
function drawExtra(
  v: DrawingView,
  at: { o: Pt; box: [number, number, number, number]; s: number },
  extra: SheetExtra,
  viewPrims: Record<string, Prim[]>,
  prims: Prim[],
  texts: SheetText[],
  s: number,
) {
  const T = (q: Pt): Pt => [at.o[0] + q[0] * at.s, at.o[1] + q[1] * at.s];
  const local: Prim[] = [];
  if (v.kind === "detail") {
    const src = viewPrims[v.parent] ?? [];
    local.push(...clipToCircle(src, v.c, v.r));
    // 상세도 테두리 (가는 원)
    prims.push({ layer: "DIM", t: "arc", c: T(v.c), r: v.r * at.s, start: 0, end: 360 });
  } else {
    const d = extra.data?.[v.id];
    if (d) {
      for (const [layer, paths] of [
        ["HIDDEN", v.kind === "aux" ? d.view.hidden : []],
        ["VISIBLE", d.view.visible],
      ] as const)
        for (const path of paths) local.push(...parseProjection(path, layer));
      if (v.kind === "section" && d.hatch?.length) {
        // 해칭: 가는 실선 45°, 용지에서 2.5 mm 간격 (KS B 0001)
        const segs: [Pt, Pt][] = [];
        for (const pl of d.hatch) for (let i = 0; i + 1 < pl.length; i++) segs.push([pl[i], pl[i + 1]]);
        for (const [a, b] of hatchLines(segs, 2.5 / at.s, 45)) local.push({ layer: "HATCH", t: "line", a, b });
      }
    }
  }
  viewPrims[v.id] = local;
  for (const p of local) prims.push(transformPrim(p, T, at.s));
  void s;
  // 이름: 뷰 아래 가운데 (단면 A-A, 상세 B (2:1) …)
  texts.push({ at: [(at.box[0] + at.box[2]) / 2, at.box[1] - 6], text: viewTitle(v), size: 3.5, anchor: "middle", bold: true });
}

/**
 * 부모 뷰의 절단선 표시 (단면도): 가는 일점쇄선 + 양끝 굵게 + 보는 방향 화살표 + 문자.
 * 보조 투상도: 경사 모서리 쪽을 가리키는 화살표 하나 + 문자
 */
function markCut(v: Extract<DrawingView, { kind: "section" | "aux" }>, box: ViewBox, P: (q: Pt) => Pt, s: number, prims: Prim[], texts: SheetText[]) {
  const { n } = cutCamera(v.parent, v.a, v.b, v.flip);
  const pc = STD_CAM[v.parent];
  // 보는 방향을 부모 뷰 좌표로
  let d: Pt = [n[0] * pc.x[0] + n[1] * pc.x[1] + n[2] * pc.x[2], n[0] * pc.up[0] + n[1] * pc.up[1] + n[2] * pc.up[2]];
  const dl = Math.hypot(d[0], d[1]) || 1;
  d = [d[0] / dl, d[1] / dl];
  const arrow = (from: Pt, tip: Pt) => {
    const dir: Pt = [tip[0] - from[0], tip[1] - from[1]];
    const L = Math.hypot(dir[0], dir[1]) || 1;
    const u: Pt = [dir[0] / L, dir[1] / L];
    const base: Pt = [tip[0] - u[0] * 2.8, tip[1] - u[1] * 2.8];
    prims.push({ layer: "VISIBLE", t: "line", a: from, b: base });
    prims.push({ layer: "VISIBLE", t: "fill", pts: [tip, [base[0] - u[1] * 1, base[1] + u[0] * 1], [base[0] + u[1] * 1, base[1] - u[0] * 1]] });
  };
  if (v.kind === "aux") {
    const m: Pt = [(v.a[0] + v.b[0]) / 2, (v.a[1] + v.b[1]) / 2];
    const M = P(m);
    const tail: Pt = [M[0] - d[0] * 14, M[1] - d[1] * 14];
    arrow(tail, [M[0] - d[0] * 2, M[1] - d[1] * 2]);
    texts.push({ at: [tail[0] - d[0] * 3, tail[1] - d[1] * 3 - 1.5], text: v.label, size: 4.5, anchor: "middle", bold: true });
    return;
  }
  // 절단선을 부모 뷰 상자(+4mm) 끝까지 늘린다
  const dir: Pt = [v.b[0] - v.a[0], v.b[1] - v.a[1]];
  const ext = 4 / s;
  const lo: Pt = [box.min[0] - ext, box.min[1] - ext];
  const hi: Pt = [box.max[0] + ext, box.max[1] + ext];
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const k of [0, 1] as const) {
    if (Math.abs(dir[k]) < 1e-12) {
      if (v.a[k] < lo[k] || v.a[k] > hi[k]) return;
      continue;
    }
    const ta = (lo[k] - v.a[k]) / dir[k];
    const tb = (hi[k] - v.a[k]) / dir[k];
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (!(t1 > t0)) return;
  const E1 = P([v.a[0] + dir[0] * t0, v.a[1] + dir[1] * t0]);
  const E2 = P([v.a[0] + dir[0] * t1, v.a[1] + dir[1] * t1]);
  prims.push({ layer: "CENTER", t: "line", a: E1, b: E2 });
  const L = Math.hypot(E2[0] - E1[0], E2[1] - E1[1]) || 1;
  const u: Pt = [(E2[0] - E1[0]) / L, (E2[1] - E1[1]) / L];
  const thick = Math.min(5, L / 4);
  prims.push({ layer: "VISIBLE", t: "line", a: E1, b: [E1[0] + u[0] * thick, E1[1] + u[1] * thick] });
  prims.push({ layer: "VISIBLE", t: "line", a: E2, b: [E2[0] - u[0] * thick, E2[1] - u[1] * thick] });
  for (const E of [E1, E2]) {
    arrow(E, [E[0] + d[0] * 7, E[1] + d[1] * 7]);
    texts.push({ at: [E[0] + d[0] * 9.5 + (E === E1 ? -u[0] : u[0]) * 1.5, E[1] + d[1] * 9.5 + (E === E1 ? -u[1] : u[1]) * 1.5 - 1.6], text: v.label, size: 4.5, anchor: "middle", bold: true });
  }
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

/** 같은 구멍 3개 이상이 한 원 위에 같은 간격 → 볼트 원 (중심선 원을 그린다) */
function pcdCircles(p: Project, v: ViewId): { c: Pt; r: number }[] {
  const out: { c: Pt; r: number }[] = [];
  const holes = p.views[v].filter((h): h is Extract<Project["views"][ViewId][number], { kind: "circle" }> => h.hole && h.kind === "circle" && !isDegenerate(h));
  const groups = new Map<string, typeof holes>();
  for (const h of holes) {
    const k = `${h.r}|${JSON.stringify(h.spec ?? null)}|${h.depth ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const c: Pt = [g.reduce((a, h) => a + h.cx, 0) / g.length, g.reduce((a, h) => a + h.cy, 0) / g.length];
    const ds = g.map((h) => Math.hypot(h.cx - c[0], h.cy - c[1]));
    const r = ds.reduce((a, d) => a + d, 0) / ds.length;
    if (r < 1e-6 || ds.some((d) => Math.abs(d - r) > 0.01)) continue;
    const angs = g.map((h) => Math.atan2(h.cy - c[1], h.cx - c[0])).sort((a, b) => a - b);
    const step = (2 * Math.PI) / angs.length;
    if (angs.every((a, i) => Math.abs((i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI) - a - step) < 1e-3)) out.push({ c, r });
  }
  return out;
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
  cell(cols[0], cols[1], 1, "재질", info.material || materialSheet(p));
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
  HATCH: { w: 0.15 },
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

/** 선·글자 묶음 → SVG 조각 (도면과 같은 모양, 용지 높이 H로 y 뒤집기) */
export function fragmentSVG(prims: Prim[], texts: SheetText[], H: number, color = "#111"): string {
  const X = (p: Pt) => `${r2(p[0])} ${r2(H - p[1])}`;
  const byLayer: Record<Layer, string[]> = { VISIBLE: [], HIDDEN: [], CENTER: [], DIM: [], FRAME: [], HATCH: [] };
  const fills: string[] = [];
  for (const p of prims) {
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
      ? `<path d="${byLayer[layer].join("")}" fill="none" stroke="${color}" stroke-width="${st.w}" stroke-linecap="round" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/>`
      : "";
  };
  const txt = texts
    .map((t) => {
      const [x, y] = X(t.at).split(" ");
      const rot = t.rotate ? ` transform="rotate(${-t.rotate} ${x} ${y})"` : "";
      const anchor = t.anchor ?? "start";
      return `<text x="${x}" y="${y}" font-size="${r2(t.size)}" text-anchor="${anchor}"${t.bold ? ' font-weight="700"' : ""}${rot}>${esc(t.text)}</text>`;
    })
    .join("");
  return (
    group("FRAME") +
    group("HATCH") +
    group("DIM") +
    group("CENTER") +
    group("HIDDEN") +
    group("VISIBLE") +
    (fills.length ? `<path d="${fills.join("")}" fill="${color}"/>` : "") +
    (txt ? `<g fill="${color}">${txt}</g>` : "")
  );
}

/** 도면의 모든 글자 (치수 포함) */
export const sheetTexts = (sh: Sheet): SheetText[] => [...sh.texts, ...sh.dims.flatMap((d) => d.texts)];

function toSVG(sh: Sheet): string {
  // 치수는 하나씩 묶음(data-dim)으로 — 화면에서 고르고 옮길 수 있게
  const dims = sh.dims.map((d) => `<g class="dim" data-dim="${esc(d.id)}">${fragmentSVG(d.prims, d.texts, sh.height)}</g>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sh.width}mm" height="${sh.height}mm" viewBox="0 0 ${sh.width} ${sh.height}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<g font-family="'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif">` +
    fragmentSVG(sh.prims, sh.texts, sh.height) +
    dims +
    `</g></svg>`
  );
}

/**
 * AutoCAD 호환 DXF (R12).
 * 실제 크기(1:1)로 내보낸다: 용지 좌표를 척도로 나눈다. 글자와 테두리도 같은 비율이라 도면 모양은 그대로.
 * 레이어: VISIBLE(외형선), HIDDEN(숨은선), CENTER(중심선), DIM(치수), FRAME(테두리·표제란)
 * 치수는 **진짜 치수(DIMENSION)**로: AutoCAD가 치수로 알아보고(고르기·옮기기·스타일), 그림은 이름 없는 블록(*D…)에 —
 * AutoCAD는 이 블록이 없으면 파일을 열지 않는다. 지시선(구멍 지시·모따기 C)은 선 + 글자.
 */
export function sheetToDXF(sh: Sheet): string {
  // inch 부품은 inch 도면으로 ($INSUNITS 1 = inch, 4 = mm)
  const inch = sh.units === "inch";
  const k = 1 / sh.scale / (inch ? MM_PER_INCH : 1);
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), String(v));
  const n = (v: number) => r2(v * k);
  const xyz = (c: number, p: Pt) => {
    g(c, n(p[0]));
    g(c + 10, n(p[1]));
    g(c + 20, 0);
  };
  const STYLE_NAME = "B3D";
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, inch ? 1 : 4);
  g(9, "$MEASUREMENT"); g(70, inch ? 0 : 1);
  g(9, "$LTSCALE"); g(40, r2(k));
  g(9, "$DIMSCALE"); g(40, r2(k));
  g(9, "$DIMSTYLE"); g(2, "STANDARD");
  g(9, "$TEXTSTYLE"); g(7, STYLE_NAME);
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
    ["HATCH", 8, "CONTINUOUS"],
  ];
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length + 1);
  g(0, "LAYER"); g(2, "0"); g(70, 0); g(62, 7); g(6, "CONTINUOUS");
  for (const [name, color, lt] of layers) {
    g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, lt);
  }
  g(0, "ENDTAB");
  // 글자 모양: 한글이 나오는 글꼴 (없으면 AutoCAD가 비슷한 글꼴로 바꿈)
  g(0, "TABLE"); g(2, "STYLE"); g(70, 2);
  g(0, "STYLE"); g(2, "STANDARD"); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "txt"); g(4, "");
  g(0, "STYLE"); g(2, STYLE_NAME); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "malgun.ttf"); g(4, "");
  g(0, "ENDTAB");
  // 치수 스타일: 화살표 3, 글자 3.5 (용지 mm) × 척도
  g(0, "TABLE"); g(2, "DIMSTYLE"); g(70, 1);
  g(0, "DIMSTYLE"); g(2, "STANDARD"); g(70, 0);
  g(3, ""); g(4, ""); g(5, ""); g(6, ""); g(7, "");
  g(40, r2(k)); g(41, 3); g(42, 1); g(43, 7); g(44, 1.5); g(45, 0); g(46, 0); g(47, 0); g(48, 0);
  g(140, 3.5); g(141, 0); g(142, 0); g(143, 25.4); g(144, 1); g(145, 0); g(146, 1); g(147, 1);
  g(71, 0); g(72, 0); g(73, 0); g(74, 0); g(75, 0); g(76, 0); g(77, 1); g(78, 0);
  g(170, 0); g(171, 2); g(172, 1); g(173, 0); g(174, 0); g(175, 0); g(176, 0); g(177, 0); g(178, 0);
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  const prim = (p: Prim, layer: string = p.layer) => {
    if (p.t === "line") {
      g(0, "LINE"); g(8, layer);
      xyz(10, p.a);
      xyz(11, p.b);
    } else if (p.t === "arc") {
      let sweep = p.end - p.start;
      while (sweep <= 0) sweep += 360;
      if (sweep >= 359.999) {
        g(0, "CIRCLE"); g(8, layer);
        xyz(10, p.c); g(40, n(p.r));
      } else {
        g(0, "ARC"); g(8, layer);
        xyz(10, p.c); g(40, n(p.r));
        g(50, r2(((p.start % 360) + 360) % 360)); g(51, r2(((p.end % 360) + 360) % 360));
      }
    } else {
      // 화살표: 3점 SOLID
      const [a, b, c] = p.pts;
      g(0, "SOLID"); g(8, layer);
      xyz(10, a);
      xyz(11, b);
      xyz(12, c);
      xyz(13, c);
    }
  };
  const text = (t: SheetText, layer: string) => {
    const align = t.anchor === "middle" ? 1 : t.anchor === "end" ? 2 : 0;
    g(0, "TEXT"); g(8, layer);
    xyz(10, t.at);
    g(40, n(t.size)); g(1, dxfText(t.text));
    if (t.rotate) g(50, r2(t.rotate));
    g(7, STYLE_NAME);
    if (align) {
      g(72, align);
      xyz(11, t.at);
    }
  };

  // 치수 그림 블록 (*D1, *D2 …)
  const real = sh.dims.filter((d) => d.dxf);
  g(0, "SECTION"); g(2, "BLOCKS");
  real.forEach((d, i) => {
    const name = `*D${i + 1}`;
    g(0, "BLOCK"); g(8, "0"); g(2, name); g(70, 1); g(10, 0); g(20, 0); g(30, 0); g(3, name);
    for (const p of d.prims) prim(p, "DIM");
    for (const t of d.texts) text(t, "DIM");
    g(0, "ENDBLK"); g(8, "0");
  });
  g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "ENTITIES");
  for (const p of sh.prims) prim(p);
  for (const t of sh.texts) text(t, "DIM");
  // 지시선은 선 + 글자
  for (const d of sh.dims.filter((x) => !x.dxf)) {
    for (const p of d.prims) prim(p, "DIM");
    for (const t of d.texts) text(t, "DIM");
  }
  real.forEach((d, i) => {
    const x = d.dxf!;
    g(0, "DIMENSION"); g(8, "DIM");
    g(2, `*D${i + 1}`);
    g(3, "STANDARD");
    xyz(10, x.p10);
    xyz(11, x.p11);
    // 종류 + 32(이 치수만 쓰는 블록) + 64(가로 거리 좌표 치수)
    g(70, x.type + 32 + (x.type === 6 && x.xOrd ? 64 : 0));
    g(1, dxfText(x.text));
    if (x.p13) xyz(13, x.p13);
    if (x.p14) xyz(14, x.p14);
    if (x.p15) xyz(15, x.p15);
    if (x.type === 0) g(50, x.angle ?? 0);
    if (x.type === 3 || x.type === 4) g(40, n(Math.hypot(x.p11[0] - x.p15![0], x.p11[1] - x.p15![1])));
  });
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}

