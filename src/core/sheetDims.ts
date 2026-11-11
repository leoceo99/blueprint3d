/**
 * 도면 치수 (11단계): 자동 치수와 직접 놓은 치수가 같은 모양(SheetDim)이다.
 * 위치는 **뷰 좌표(모델 mm)**로 두므로 척도·용지가 바뀌어도 따라가고, 치수선까지의 거리처럼 “종이 위 간격”만 용지 mm로 둔다.
 * renderDim은 화면·SVG에 그릴 선·화살표·글자(용지 좌표)와, DXF의 진짜 치수(DIMENSION)에 넣을 정의점을 함께 만든다.
 */
import type { ViewId } from "./types";
import { fitDeviation } from "./fits";

export type Pt = [number, number];
export type Layer = "VISIBLE" | "HIDDEN" | "CENTER" | "DIM" | "FRAME" | "HATCH";
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

interface DimBase {
  id: string;
  /** 기본 뷰(front·top·side) 또는 도면 추가 뷰 id */
  view: ViewId | string;
  /** 글자 바꾸기 (비우면 잰 값) */
  text?: string;
  /** 글자 뒤에 붙이기 (공차·“관통” 등) */
  suffix?: string;
  /** 치수 공차 (14.4): ± · 위·아래 허용차 · 끼워맞춤(H7 …) */
  tol?: DimTol;
}

/** 치수 공차 — 허용차는 mm */
export type DimTol = { kind: "sym"; v: number } | { kind: "dev"; up: number; lo: number } | { kind: "fit"; code: string };
/** 가로(h)·세로(v)·평행(aligned) 치수 */
export interface LinearDim extends DimBase {
  kind: "linear";
  dir: "h" | "v" | "aligned";
  a: Pt;
  b: Pt;
  /** 치수선까지 거리 (용지 mm): h는 a에서 위로 +, v는 a에서 오른쪽 +, aligned는 a→b의 왼쪽 + */
  off: number;
}
/** 좌표 치수: 원점(origin)에서 p까지 한 축의 거리, 글자는 한 줄에 */
export interface OrdinateDim extends DimBase {
  kind: "ordinate";
  /** u: 가로 거리(글자는 아래 줄), v: 세로 거리(글자는 왼쪽 줄) */
  axis: "u" | "v";
  origin: Pt;
  p: Pt;
  /** 글자 줄 위치: 원점의 용지 위치에서 (용지 mm, 아래·왼쪽이 −) */
  line: number;
  /** 글자가 겹치지 않게 축 방향으로 비켜 놓은 거리 (용지 mm) */
  jog?: number;
}
/** 지름·반지름 (지시선) */
export interface RadialDim extends DimBase {
  kind: "diameter" | "radius";
  c: Pt;
  r: number;
  /** 지시선 방향 (도, 원 중심에서 바깥으로) */
  ang: number;
  /** 원 밖으로 꺾임점까지 (용지 mm) */
  len: number;
  /** 같은 것 개수 (2 이상이면 “4×”) */
  count?: number;
}
/** 각도: 꼭짓점 o, 두 선 위의 점 a·b */
export interface AngleDim extends DimBase {
  kind: "angle";
  o: Pt;
  a: Pt;
  b: Pt;
  /** 호 반지름 (용지 mm) */
  rad: number;
}
/** 지시선 + 글자 (구멍 지시, 모따기 C, 메모) */
export interface LeaderDim extends DimBase {
  kind: "leader";
  tip: Pt;
  /** 꺾임점 (tip의 용지 위치에서 용지 mm) */
  knee: Pt;
  text: string;
}
/** 표면 거칠기 기호 (14.5, ISO 1302): 면 위의 점 tip에 √, 값 Ra */
export interface RoughDim extends DimBase {
  kind: "rough";
  tip: Pt;
  /** 기호를 놓을 곳 (tip의 용지 위치에서 용지 mm, [0,0]이면 tip 바로 위) */
  knee: Pt;
  ra: string;
  /** any: 가공 방법 상관없음 · remove: 제거 가공 필요(막대) · keep: 제거 가공 안 함(원) */
  mode?: "any" | "remove" | "keep";
}

/** 기하공차 기호 (ISO 1101) */
export type GdtSym = "straight" | "flat" | "round" | "cyl" | "profLine" | "profSurf" | "perp" | "angular" | "parallel" | "position" | "concentric" | "symmetry" | "runout" | "totalRunout";

export const GDT_LABEL: Record<GdtSym, string> = {
  straight: "진직도",
  flat: "평면도",
  round: "진원도",
  cyl: "원통도",
  profLine: "선의 윤곽도",
  profSurf: "면의 윤곽도",
  perp: "직각도",
  angular: "경사도",
  parallel: "평행도",
  position: "위치도",
  concentric: "동심도",
  symmetry: "대칭도",
  runout: "원주 흔들림",
  totalRunout: "온 흔들림",
};

/** 기하공차 틀 (14.5): 지시선 + [기호 | 공차 | 데이텀…] */
export interface GdtDim extends DimBase {
  kind: "gdt";
  tip: Pt;
  knee: Pt;
  sym: GdtSym;
  /** 공차 값 글자 (예: 0.05) */
  value: string;
  /** 공차 앞에 Ø (원통형 공차역) */
  dia?: boolean;
  datums?: string[];
}

/** 데이텀 (14.5): 면 위 삼각형 + 네모 안 문자 */
export interface DatumDim extends DimBase {
  kind: "datum";
  tip: Pt;
  knee: Pt;
  label: string;
}

export type SheetDim = LinearDim | OrdinateDim | RadialDim | AngleDim | LeaderDim | RoughDim | GdtDim | DatumDim;

/** 치수가 아닌 기호 (공차·자동 치수 검사에서 빼는 것) */
export const isAnnotation = (d: SheetDim) => d.kind === "rough" || d.kind === "gdt" || d.kind === "datum";

/** 공차 글자: ±0.1 · (+0.05/−0.02) · H7 (+0.021/0) */
export function tolText(d: SheetDim, fmt: (mm: number) => string): string {
  const t = d.tol;
  if (!t) return "";
  // 허용차는 치수보다 한 자리 더 (mm 0.001 · inch 0.0001): 단위는 fmt(1000)으로 알아냄 (mm → 1000, inch → 39.37)
  const k = Number(fmt(1000)) / 1000 || 1;
  const dp = Math.abs(k - 1) < 1e-9 ? 3 : 4;
  const num = (x: number) => String(Math.round(x * k * 10 ** dp) / 10 ** dp);
  const dev = (x: number) => (Math.abs(x) < 5e-7 ? "0" : (x > 0 ? "+" : "−") + num(Math.abs(x)));
  if (t.kind === "sym") return ` ±${num(Math.abs(t.v))}`;
  if (t.kind === "dev") return ` (${dev(t.up)}/${dev(t.lo)})`;
  const nominal = measureDim(d);
  const fd = fitDeviation(nominal, t.code);
  return ` ${t.code}${fd ? ` (${dev(fd.up)}/${dev(fd.lo)})` : ""}`;
}

/** DXF DIMENSION 정의 (용지 좌표). 종류: 0 회전(가로·세로), 1 평행, 3 지름, 4 반지름, 5 세 점 각도, 6 좌표 */
export interface DxfDim {
  type: 0 | 1 | 3 | 4 | 5 | 6;
  /** 치수선 위치 / 지름의 먼 점 / 반지름의 중심 / 각도 호 위치 / 좌표의 원점 */
  p10: Pt;
  /** 글자 가운데 */
  p11: Pt;
  p13?: Pt;
  p14?: Pt;
  p15?: Pt;
  /** 회전 치수의 각도 (가로 0, 세로 90) */
  angle?: number;
  /** 좌표 치수가 X(가로 거리)인지 */
  xOrd?: boolean;
  text: string;
}

export interface DimDraw {
  id: string;
  /** 기본 뷰(front·top·side) 또는 도면 추가 뷰 id */
  view: ViewId | string;
  prims: Prim[];
  texts: SheetText[];
  /** 글자 상자 (용지) — 겹침 검사·누르기 */
  box: [number, number, number, number];
  /** 잰 값 (mm 또는 도) */
  value: number;
  text: string;
  dxf?: DxfDim;
  /** 그린 치수의 원래 정의 */
  def: SheetDim;
}

export const TXT = 3.5; // 치수 글자 높이 (ISO)
export const ARROW = 3;

/** 글자 너비 (용지 mm): 숫자·영문은 좁게, 한글은 넓게 */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch) ? size * 0.95 : ch === " " ? size * 0.3 : size * 0.6;
  return w;
}

/** 글자 상자 [x0, y0, x1, y1] */
export function textBox(t: SheetText): [number, number, number, number] {
  const w = textWidth(t.text, t.size);
  const h = t.size;
  const a = t.anchor ?? "start";
  const off = a === "start" ? 0 : a === "middle" ? -w / 2 : -w;
  if (t.rotate && Math.abs(Math.abs(t.rotate) - 90) < 1) {
    // 90° 돌린 글자: 아래→위로 읽힘 (x는 글자 높이, y는 글자 너비)
    const y0 = t.at[1] + off;
    return [t.at[0] - h, y0, t.at[0] + 0.2, y0 + w];
  }
  const x0 = t.at[0] + off;
  return [x0, t.at[1] - 0.2, x0 + w, t.at[1] + h];
}

export const overlaps = (a: number[], b: number[], m = 0) => a[0] < b[2] + m && b[0] < a[2] + m && a[1] < b[3] + m && b[1] < a[3] + m;

/** 잰 값 (mm 또는 도) */
export function measureDim(d: SheetDim): number {
  if (d.kind === "linear") {
    if (d.dir === "h") return Math.abs(d.b[0] - d.a[0]);
    if (d.dir === "v") return Math.abs(d.b[1] - d.a[1]);
    return Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
  }
  if (d.kind === "ordinate") return Math.abs(d.axis === "u" ? d.p[0] - d.origin[0] : d.p[1] - d.origin[1]);
  if (d.kind === "radius") return d.r;
  if (d.kind === "diameter") return d.r * 2;
  if (d.kind === "angle") {
    const a1 = Math.atan2(d.a[1] - d.o[1], d.a[0] - d.o[0]);
    const a2 = Math.atan2(d.b[1] - d.o[1], d.b[0] - d.o[0]);
    let t = Math.abs(a2 - a1);
    if (t > Math.PI) t = 2 * Math.PI - t;
    return (t * 180) / Math.PI;
  }
  return 0;
}

/** 치수 글자 */
export function dimText(d: SheetDim, fmt: (mm: number) => string): string {
  if (d.kind === "leader") return d.text + (d.suffix ?? "");
  if (d.kind === "rough") return `Ra ${d.ra}`;
  if (d.kind === "gdt") return `${GDT_LABEL[d.sym]} ${d.dia ? "Ø" : ""}${d.value}${d.datums?.length ? " " + d.datums.join(" ") : ""}`;
  if (d.kind === "datum") return d.label;
  if (d.text) return d.text + tolText(d, fmt) + (d.suffix ?? "");
  const v = measureDim(d);
  let t: string;
  if (d.kind === "angle") t = `${Math.round(v * 100) / 100}°`;
  else if (d.kind === "radius") t = `R${fmt(v)}`;
  else if (d.kind === "diameter") t = `Ø${fmt(v)}`;
  else t = fmt(v);
  if ((d.kind === "radius" || d.kind === "diameter") && d.count && d.count > 1) t = `${d.count}×${t}`;
  return t + tolText(d, fmt) + (d.suffix ?? "");
}

function arrowHead(out: Prim[], tip: Pt, dir: Pt) {
  const L = Math.hypot(dir[0], dir[1]) || 1;
  const ux = dir[0] / L;
  const uy = dir[1] / L;
  const w = ARROW * 0.18;
  out.push({
    layer: "DIM",
    t: "fill",
    pts: [tip, [tip[0] - ux * ARROW - uy * w, tip[1] - uy * ARROW + ux * w], [tip[0] - ux * ARROW + uy * w, tip[1] - uy * ARROW - ux * w]],
  });
}

const line = (out: Prim[], a: Pt, b: Pt) => out.push({ layer: "DIM", t: "line", a, b });
const rect = (out: Prim[], x0: number, y0: number, x1: number, y1: number) => {
  line(out, [x0, y0], [x1, y0]);
  line(out, [x1, y0], [x1, y1]);
  line(out, [x1, y1], [x0, y1]);
  line(out, [x0, y1], [x0, y0]);
};

/** 표면 거칠기 √ (ISO 1302): 꼭짓점이 면 위, 짧은 다리·긴 다리 60°, 제거 가공이면 막대, 안 하면 원, 위 가로선 아래에 Ra 값 */
function roughSymbol(out: Prim[], texts: SheetText[], d: RoughDim, tip: Pt) {
  const V: Pt = [tip[0] + d.knee[0], tip[1] + d.knee[1]];
  if (Math.hypot(d.knee[0], d.knee[1]) > 0.5) line(out, tip, V);
  const h1 = 3.5;
  const h2 = 7.5;
  const k = Math.tan(Math.PI / 6);
  const Lp: Pt = [V[0] - h1 * k, V[1] + h1];
  const Rp: Pt = [V[0] + h2 * k, V[1] + h2];
  line(out, V, Lp);
  line(out, V, Rp);
  if (d.mode === "remove") line(out, Lp, [V[0] + h1 * k, V[1] + h1]);
  if (d.mode === "keep") out.push({ layer: "DIM", t: "arc", c: [V[0], V[1] + h1 * 0.55], r: h1 * 0.45, start: 0, end: 360 });
  const text = `Ra ${d.ra}`;
  const w = textWidth(text, TXT * 0.85);
  line(out, Rp, [Rp[0] + w + 1, Rp[1]]);
  texts.push({ at: [Rp[0] + 0.5, Rp[1] - TXT * 0.85 - 0.6], text, size: TXT * 0.85, anchor: "start" });
}

/** 기하공차 기호를 선으로 (글꼴 없이도 보이게): 가운데 c, 크기 s(용지 mm) */
function gdtGlyph(out: Prim[], sym: GdtSym, c: Pt, s: number) {
  const L = (a: Pt, b: Pt) => line(out, [c[0] + a[0] * s, c[1] + a[1] * s], [c[0] + b[0] * s, c[1] + b[1] * s]);
  const circ = (r: number, cx = 0, cy = 0) => out.push({ layer: "DIM", t: "arc", c: [c[0] + cx * s, c[1] + cy * s], r: r * s, start: 0, end: 360 });
  const arc = (r: number, a0: number, a1: number, cy = 0) => out.push({ layer: "DIM", t: "arc", c: [c[0], c[1] + cy * s], r: r * s, start: a0, end: a1 });
  switch (sym) {
    case "straight":
      return L([-0.4, 0], [0.4, 0]);
    case "flat":
      L([-0.4, -0.2], [0.25, -0.2]);
      L([0.25, -0.2], [0.4, 0.2]);
      L([0.4, 0.2], [-0.25, 0.2]);
      return L([-0.25, 0.2], [-0.4, -0.2]);
    case "round":
      return circ(0.3);
    case "cyl":
      circ(0.25);
      L([-0.4, -0.35], [-0.1, 0.35]);
      return L([0.1, -0.35], [0.4, 0.35]);
    case "profLine":
      return arc(0.35, 0, 180, -0.15);
    case "profSurf":
      arc(0.35, 0, 180, -0.15);
      return L([-0.35, -0.15], [0.35, -0.15]);
    case "perp":
      L([0, -0.3], [0, 0.35]);
      return L([-0.35, -0.3], [0.35, -0.3]);
    case "angular":
      L([-0.35, -0.3], [0.35, -0.3]);
      return L([-0.35, -0.3], [0.3, 0.3]);
    case "parallel":
      L([-0.3, -0.3], [0, 0.3]);
      return L([0, -0.3], [0.3, 0.3]);
    case "position":
      circ(0.22);
      L([-0.38, 0], [0.38, 0]);
      return L([0, -0.38], [0, 0.38]);
    case "concentric":
      circ(0.15);
      return circ(0.32);
    case "symmetry":
      L([-0.25, 0.2], [0.25, 0.2]);
      L([-0.4, 0], [0.4, 0]);
      return L([-0.25, -0.2], [0.25, -0.2]);
    case "runout":
    case "totalRunout": {
      const tip: Pt = [c[0] + 0.25 * s, c[1] + 0.3 * s];
      L([-0.2, -0.35], [0.25, 0.3]);
      out.push({ layer: "DIM", t: "fill", pts: [tip, [tip[0] - 0.22 * s, tip[1] - 0.05 * s], [tip[0] - 0.05 * s, tip[1] - 0.22 * s]] });
      if (sym === "totalRunout") {
        L([0.05, -0.35], [0.45, 0.2]);
        L([-0.4, -0.35], [0.25, -0.35]);
      }
      return;
    }
  }
}

/** 기하공차 틀: 지시선(화살표는 형상 쪽) → [기호 | (Ø)공차 | 데이텀…] */
function gdtFrame(out: Prim[], texts: SheetText[], d: GdtDim, tip: Pt) {
  const K: Pt = [tip[0] + d.knee[0], tip[1] + d.knee[1]];
  line(out, tip, K);
  arrowHead(out, tip, [tip[0] - K[0], tip[1] - K[1]]);
  const H = 6;
  const cells: { w: number; text?: string; sym?: GdtSym }[] = [{ w: 6, sym: d.sym }, { w: Math.max(8, textWidth(`${d.dia ? "Ø" : ""}${d.value}`, TXT) + 2.5), text: `${d.dia ? "Ø" : ""}${d.value}` }];
  for (const dt of d.datums ?? []) if (dt.trim()) cells.push({ w: Math.max(6, textWidth(dt, TXT) + 2.5), text: dt });
  const total = cells.reduce((a, c) => a + c.w, 0);
  const right = d.knee[0] >= 0;
  let x = right ? K[0] : K[0] - total;
  const y0 = K[1] - H / 2;
  rect(out, x, y0, x + total, y0 + H);
  cells.forEach((c, i) => {
    if (i) line(out, [x, y0], [x, y0 + H]);
    if (c.sym) gdtGlyph(out, c.sym, [x + c.w / 2, y0 + H / 2], 5);
    if (c.text) texts.push({ at: [x + c.w / 2, y0 + (H - TXT) / 2 + 0.15], text: c.text, size: TXT, anchor: "middle" });
    x += c.w;
  });
}

/**
 * 치수 하나를 그린다. P: 그 뷰의 뷰 좌표 → 용지 좌표, s: 척도, fmt: 길이 글자.
 */
export function renderDim(d: SheetDim, P: (q: Pt) => Pt, s: number, fmt: (mm: number) => string): DimDraw {
  const prims: Prim[] = [];
  const texts: SheetText[] = [];
  const text = dimText(d, fmt);
  const value = measureDim(d);
  let dxf: DxfDim | undefined;
  const gap = 1;

  if (d.kind === "linear") {
    const A = P(d.a);
    const B = P(d.b);
    if (d.dir === "h" || d.dir === "v") {
      const k = d.dir === "h" ? 1 : 0; // 치수선이 놓이는 좌표 축 (h: y)
      const pos = A[k] + d.off;
      const sgn = Math.sign(d.off) || -1;
      const at = (Q: Pt): Pt => (k === 1 ? [Q[0], pos] : [pos, Q[1]]);
      // 보조선: 점에서 조금 떨어져 시작, 치수선 너머로 1.5
      for (const Q of [A, B]) {
        const from: Pt = k === 1 ? [Q[0], Q[1] + Math.sign(pos - Q[1] || sgn) * gap] : [Q[0] + Math.sign(pos - Q[0] || sgn) * gap, Q[1]];
        const to: Pt = k === 1 ? [Q[0], pos + Math.sign(pos - Q[1] || sgn) * 1.5] : [pos + Math.sign(pos - Q[0] || sgn) * 1.5, Q[1]];
        line(prims, from, to);
      }
      const a2 = at(A);
      const b2 = at(B);
      line(prims, a2, b2);
      const span = Math.abs(k === 1 ? b2[0] - a2[0] : b2[1] - a2[1]);
      const dir: Pt = k === 1 ? [Math.sign(b2[0] - a2[0]) || 1, 0] : [0, Math.sign(b2[1] - a2[1]) || 1];
      // 좁으면 화살표를 바깥에서 안으로
      const inside = span >= ARROW * 2.4;
      arrowHead(prims, a2, inside ? [-dir[0], -dir[1]] : dir);
      arrowHead(prims, b2, inside ? dir : [-dir[0], -dir[1]]);
      if (!inside) {
        line(prims, a2, [a2[0] - dir[0] * ARROW * 1.6, a2[1] - dir[1] * ARROW * 1.6]);
        line(prims, b2, [b2[0] + dir[0] * ARROW * 1.6, b2[1] + dir[1] * ARROW * 1.6]);
      }
      const mid: Pt = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
      const t: SheetText =
        k === 1
          ? { at: [mid[0], mid[1] + 1], text, size: TXT, anchor: "middle" }
          : { at: [mid[0] - 1, mid[1]], text, size: TXT, rotate: 90, anchor: "middle" };
      texts.push(t);
      dxf = { type: 0, p10: a2, p11: k === 1 ? [mid[0], mid[1] + 1 + TXT / 2] : [mid[0] - 1 - TXT / 2, mid[1]], p13: A, p14: B, angle: k === 1 ? 0 : 90, text };
    } else {
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      const u: Pt = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
      const n: Pt = [-u[1], u[0]];
      const sgn = Math.sign(d.off) || 1;
      const a2: Pt = [A[0] + n[0] * d.off, A[1] + n[1] * d.off];
      const b2: Pt = [B[0] + n[0] * d.off, B[1] + n[1] * d.off];
      for (const [Q, Q2] of [
        [A, a2],
        [B, b2],
      ] as [Pt, Pt][])
        line(prims, [Q[0] + n[0] * gap * sgn, Q[1] + n[1] * gap * sgn], [Q2[0] + n[0] * 1.5 * sgn, Q2[1] + n[1] * 1.5 * sgn]);
      line(prims, a2, b2);
      arrowHead(prims, a2, [-u[0], -u[1]]);
      arrowHead(prims, b2, u);
      let ang = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang <= -90) ang += 180;
      const mid: Pt = [(a2[0] + b2[0]) / 2 + n[0] * sgn, (a2[1] + b2[1]) / 2 + n[1] * sgn];
      texts.push({ at: mid, text, size: TXT, rotate: ang, anchor: "middle" });
      dxf = { type: 1, p10: b2, p11: mid, p13: A, p14: B, text };
    }
  } else if (d.kind === "ordinate") {
    const O = P(d.origin);
    const F = P(d.p);
    const jog = d.jog ?? 0;
    if (d.axis === "u") {
      const row = O[1] + d.line;
      const tx = F[0] + jog;
      const dir = Math.sign(row - F[1]) || -1;
      if (Math.abs(jog) > 0.05) {
        const k1: Pt = [F[0], row - dir * 4];
        line(prims, [F[0], F[1] + dir * gap], k1);
        line(prims, k1, [tx, row - dir * 2]);
        line(prims, [tx, row - dir * 2], [tx, row]);
      } else line(prims, [F[0], F[1] + dir * gap], [F[0], row]);
      texts.push({ at: [tx + TXT * 0.35, row - 1], text, size: TXT * 0.85, rotate: 90, anchor: "end" });
      dxf = { type: 6, p10: O, p11: [tx, row - 1 - textWidth(text, TXT * 0.85) / 2], p13: F, p14: [tx, row], xOrd: true, text };
    } else {
      const col = O[0] + d.line;
      const ty = F[1] + jog;
      const dir = Math.sign(col - F[0]) || -1;
      if (Math.abs(jog) > 0.05) {
        const k1: Pt = [col - dir * 4, F[1]];
        line(prims, [F[0] + dir * gap, F[1]], k1);
        line(prims, k1, [col - dir * 2, ty]);
        line(prims, [col - dir * 2, ty], [col, ty]);
      } else line(prims, [F[0] + dir * gap, F[1]], [col, F[1]]);
      texts.push({ at: [col - 1, ty - TXT * 0.35], text, size: TXT * 0.85, anchor: "end" });
      dxf = { type: 6, p10: O, p11: [col - 1 - textWidth(text, TXT * 0.85) / 2, ty], p13: F, p14: [col, ty], xOrd: false, text };
    }
  } else if (d.kind === "diameter" || d.kind === "radius") {
    const C = P(d.c);
    const rr = d.r * s;
    const a = (d.ang * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const tip: Pt = [C[0] + rr * ux, C[1] + rr * uy];
    const knee: Pt = [tip[0] + d.len * ux, tip[1] + d.len * uy];
    const right = ux >= -1e-9;
    const tw = textWidth(text, TXT * 0.85);
    const end: Pt = [knee[0] + (right ? tw + 1 : -(tw + 1)), knee[1]];
    if (d.kind === "radius") line(prims, C, tip); // 반지름: 중심에서 원호까지 + 지시선
    line(prims, tip, knee);
    line(prims, knee, end);
    arrowHead(prims, tip, d.kind === "radius" ? [ux, uy] : [-ux, -uy]);
    texts.push({ at: [knee[0] + (right ? 0.5 : -0.5), knee[1] + 0.8], text, size: TXT * 0.85, anchor: right ? "start" : "end" });
    const far: Pt = [C[0] - rr * ux, C[1] - rr * uy];
    dxf =
      d.kind === "diameter"
        ? { type: 3, p10: far, p11: [knee[0] + ((right ? 1 : -1) * tw) / 2, knee[1] + 0.8 + (TXT * 0.85) / 2], p15: tip, text }
        : { type: 4, p10: C, p11: [knee[0] + ((right ? 1 : -1) * tw) / 2, knee[1] + 0.8 + (TXT * 0.85) / 2], p15: tip, text };
  } else if (d.kind === "angle") {
    const O = P(d.o);
    const A = P(d.a);
    const B = P(d.b);
    let a1 = (Math.atan2(A[1] - O[1], A[0] - O[0]) * 180) / Math.PI;
    let a2 = (Math.atan2(B[1] - O[1], B[0] - O[0]) * 180) / Math.PI;
    // 작은 쪽 각도로 (a1 → a2 반시계)
    let sweep = (((a2 - a1) % 360) + 360) % 360;
    if (sweep > 180) {
      [a1, a2] = [a2, a1];
      sweep = 360 - sweep;
    }
    prims.push({ layer: "DIM", t: "arc", c: O, r: d.rad, start: a1, end: a1 + sweep });
    const P1: Pt = [O[0] + d.rad * Math.cos((a1 * Math.PI) / 180), O[1] + d.rad * Math.sin((a1 * Math.PI) / 180)];
    const P2: Pt = [O[0] + d.rad * Math.cos(((a1 + sweep) * Math.PI) / 180), O[1] + d.rad * Math.sin(((a1 + sweep) * Math.PI) / 180)];
    // 화살표는 호의 접선 방향
    const t1 = ((a1 - 90) * Math.PI) / 180;
    const t2 = ((a1 + sweep + 90) * Math.PI) / 180;
    arrowHead(prims, P1, [Math.cos(t1), Math.sin(t1)]);
    arrowHead(prims, P2, [Math.cos(t2), Math.sin(t2)]);
    // 선이 호까지 닿지 않으면 보조선
    for (const [Q, R] of [
      [A, P1],
      [B, P2],
    ] as [Pt, Pt][])
      if (Math.hypot(Q[0] - O[0], Q[1] - O[1]) < d.rad) line(prims, Q, R);
    const am = ((a1 + sweep / 2) * Math.PI) / 180;
    const at: Pt = [O[0] + (d.rad + 2.5) * Math.cos(am), O[1] + (d.rad + 2.5) * Math.sin(am)];
    texts.push({ at: [at[0], at[1] - TXT * 0.4], text, size: TXT * 0.85, anchor: "middle" });
    dxf = { type: 5, p10: [O[0] + d.rad * Math.cos(am), O[1] + d.rad * Math.sin(am)], p11: at, p13: A, p14: B, p15: O, text };
  } else if (d.kind === "leader") {
    const tip = P(d.tip);
    const knee: Pt = [tip[0] + d.knee[0], tip[1] + d.knee[1]];
    const right = d.knee[0] >= 0;
    const tw = textWidth(text, TXT * 0.85);
    line(prims, tip, knee);
    line(prims, knee, [knee[0] + (right ? tw + 1 : -(tw + 1)), knee[1]]);
    arrowHead(prims, tip, [tip[0] - knee[0], tip[1] - knee[1]]);
    texts.push({ at: [knee[0] + (right ? 0.5 : -0.5), knee[1] + 0.8], text, size: TXT * 0.85, anchor: right ? "start" : "end" });
  } else if (d.kind === "rough") {
    roughSymbol(prims, texts, d, P(d.tip));
  } else if (d.kind === "gdt") {
    gdtFrame(prims, texts, d, P(d.tip));
  } else if (d.kind === "datum") {
    const tip = P(d.tip);
    const K: Pt = [tip[0] + d.knee[0], tip[1] + d.knee[1]];
    const L = Math.hypot(d.knee[0], d.knee[1]) || 1;
    const u: Pt = [d.knee[0] / L, d.knee[1] / L];
    const n: Pt = [-u[1], u[0]];
    // 면에 붙은 채운 삼각형 → 선 → 네모 안 문자
    const h = 2.2;
    prims.push({ layer: "DIM", t: "fill", pts: [[tip[0] + n[0] * 1.6, tip[1] + n[1] * 1.6], [tip[0] - n[0] * 1.6, tip[1] - n[1] * 1.6], [tip[0] + u[0] * h, tip[1] + u[1] * h]] });
    const B = 5.5;
    const C: Pt = [K[0] + u[0] * (B / 2), K[1] + u[1] * (B / 2)];
    line(prims, [tip[0] + u[0] * h, tip[1] + u[1] * h], K);
    rect(prims, C[0] - B / 2, C[1] - B / 2, C[0] + B / 2, C[1] + B / 2);
    texts.push({ at: [C[0], C[1] - TXT / 2 + 0.2], text: d.label, size: TXT, anchor: "middle", bold: true });
  }

  // 글자 상자 (여러 글자면 합침). 기호(거칠기·기하공차·데이텀)는 그림까지 포함해서 누르기 쉽게
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of texts) {
    const b = textBox(t);
    box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
  }
  if (isAnnotation(d))
    for (const pr of prims) {
      const pts = pr.t === "line" ? [pr.a, pr.b] : pr.t === "fill" ? pr.pts : [[pr.c[0] - pr.r, pr.c[1] - pr.r], [pr.c[0] + pr.r, pr.c[1] + pr.r]];
      for (const q of pts as Pt[]) box = [Math.min(box[0], q[0]), Math.min(box[1], q[1]), Math.max(box[2], q[0]), Math.max(box[3], q[1])];
    }
  return { id: d.id, view: d.view, prims, texts, box, value, text, dxf, def: d };
}

export { normalizeDims } from "./dimsNormalize";
