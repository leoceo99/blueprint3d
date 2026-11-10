/**
 * 피처 기반 부품 설계 (13단계): 부품의 피처 목록과 스케치 평면.
 * 형상 엔진(replicad)을 쓰지 않는 순수한 자료·계산만 — 화면 코드도 가볍게 쓸 수 있게.
 *
 * - 부품 = (3면도 몸체가 있으면 그것이 첫 피처) + features[] 를 위에서부터 차례로 계산
 * - 스케치 피처는 몸체를 바꾸지 않고, 돌출·회전 등이 스케치 id로 가리킨다
 * - 면·모서리 참조는 기하 지문(FaceSig·EdgeSig)으로 저장하고 다시 계산할 때 가장 닮은 것을 찾는다 (결정 29)
 */
import { VIEW_AXES, VIEW_IDS, VIEW_LABEL, type Constraint, type HoleSpec, type Project, type Shape2D, type ViewId } from "./types";

export type P3 = [number, number, number];

/** 면의 기하 지문 */
export interface FaceSig {
  /** 면 종류 */
  t: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";
  /** 중심 (면의 무게 중심) */
  c: P3;
  /** 평면은 바깥쪽 법선, 원통·원뿔은 축 방향 */
  n?: P3;
  /** 원통·원뿔·구의 반지름 */
  r?: number;
  /** 넓이 (mm²) */
  a: number;
}

/** 모서리의 기하 지문 */
export interface EdgeSig {
  t: "line" | "circle" | "other";
  /** 가운데 점 */
  c: P3;
  /** 직선은 방향, 원은 축 방향 */
  d?: P3;
  /** 원의 반지름 */
  r?: number;
  /** 길이 */
  l: number;
}

export type BasePlane = "XY" | "XZ" | "YZ";

/** 스케치 평면: 기본 평면(+거리) 또는 부품의 평평한 면(+거리) */
export type PlaneRef = { kind: "base"; base: BasePlane; offset: number } | { kind: "face"; face: FaceSig; offset: number };

export const BASE_PLANE_LABEL: Record<BasePlane, string> = {
  XY: "XY 평면 (위에서 봄)",
  XZ: "XZ 평면 (앞에서 봄)",
  YZ: "YZ 평면 (오른쪽에서 봄)",
};

/** 몸체에 하는 일: 더하기 · 빼기 · 겹친 부분만 */
export type BodyOp = "add" | "cut" | "common";
export const OP_LABEL: Record<BodyOp, string> = { add: "더하기", cut: "빼기", common: "겹친 부분" };

/** 돌출 끝: 거리(한쪽) · 양쪽 같게 · 끝까지(한쪽) · 양쪽 끝까지 */
export type Extent = "dist" | "sym" | "through" | "throughBoth";
export const EXTENT_LABEL: Record<Extent, string> = { dist: "거리", sym: "양쪽 같게", through: "끝까지", throughBoth: "양쪽 끝까지" };

interface FeatureBase {
  id: string;
  name: string;
  /** 끔 (계산에서 뺌) */
  suppressed?: boolean;
  /** 숫자 값을 식·변수에 묶은 것 (예: { dist: "L/2" }) */
  exprs?: Record<string, string>;
}

export interface SketchFeature extends FeatureBase {
  kind: "sketch";
  plane: PlaneRef;
  shapes: Shape2D[];
  constraints?: Constraint[];
}

export interface ExtrudeFeature extends FeatureBase {
  kind: "extrude";
  sketch: string;
  op: BodyOp;
  extent: Extent;
  dist: number;
  /** 법선 반대쪽으로 */
  flip?: boolean;
}

export interface RevolveFeature extends FeatureBase {
  kind: "revolve";
  sketch: string;
  op: BodyOp;
  /** 스케치의 가로축(u) 또는 세로축(v) — 스케치 원점을 지남 */
  axis: "u" | "v";
  /** 도 (0 < angle ≤ 360) */
  angle: number;
}

export interface FilletFeature extends FeatureBase {
  kind: "fillet";
  edges: EdgeSig[];
  r: number;
}

export interface ChamferFeature extends FeatureBase {
  kind: "chamfer";
  edges: EdgeSig[];
  d: number;
}

export interface ShellFeature extends FeatureBase {
  kind: "shell";
  /** 열어 둘 (빼낼) 면 */
  faces: FaceSig[];
  /** 벽 두께 (안쪽으로) */
  t: number;
}

export interface DraftFeature extends FeatureBase {
  kind: "draft";
  faces: FaceSig[];
  /** 도 */
  angle: number;
  /** 기준 평면 (각도가 0인 곳) */
  neutral: BasePlane;
}

/** 패턴·대칭의 방향: 기본 축 */
export type AxisName = "X" | "Y" | "Z";

export interface PatternFeature extends FeatureBase {
  kind: "pattern";
  mode: "linear" | "circular";
  /** 따라 만들 피처 (돌출·회전·구멍·스윕·로프트) */
  of: string[];
  axis: AxisName;
  /** 원본 포함 개수 */
  count: number;
  /** 직선: 간격 (mm) */
  spacing: number;
  /** 원형: 전체 각도 (360이면 고르게 한 바퀴) */
  angle: number;
}

export interface MirrorFeature extends FeatureBase {
  kind: "mirror";
  /** 따라 만들 피처. 비어 있으면 몸체 전체 */
  of: string[];
  plane: BasePlane;
}

export interface HoleFeature extends FeatureBase {
  kind: "hole";
  /** 구멍 중심: 이 스케치의 원(중심만 씀) */
  sketch: string;
  spec: HoleSpec;
  /** 지름 (spec에서 정해지면 그 값) */
  d: number;
  /** null이면 관통 */
  depth: number | null;
  /** 스케치 법선 쪽으로 (기본은 법선 반대쪽 = 면 위 스케치에서 재료 안쪽) */
  flip?: boolean;
}

export type SweepProfile = { kind: "circle"; d: number; inner?: number } | { kind: "sketch"; sketch: string };

export interface SweepFeature extends FeatureBase {
  kind: "sweep";
  /** 경로 스케치 (열린 선 또는 닫힌 도형의 외곽선) */
  path: string;
  profile: SweepProfile;
  op: BodyOp;
}

export interface LoftFeature extends FeatureBase {
  kind: "loft";
  sketches: string[];
  op: BodyOp;
  ruled?: boolean;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | DraftFeature
  | PatternFeature
  | MirrorFeature
  | HoleFeature
  | SweepFeature
  | LoftFeature;

export type FeatureKind = Feature["kind"];

export const FEATURE_LABEL: Record<FeatureKind, string> = {
  sketch: "스케치",
  extrude: "돌출",
  revolve: "회전",
  fillet: "필렛",
  chamfer: "모따기",
  shell: "쉘",
  draft: "구배",
  pattern: "패턴",
  mirror: "대칭",
  hole: "구멍",
  sweep: "스윕",
  loft: "로프트",
};

export const FEATURE_ICON: Record<FeatureKind, string> = {
  sketch: "✎",
  extrude: "▤",
  revolve: "◔",
  fillet: "◜",
  chamfer: "◸",
  shell: "▢",
  draft: "⏢",
  pattern: "⋯",
  mirror: "⇋",
  hole: "◎",
  sweep: "〰",
  loft: "⏃",
};

/** 계산 결과 (피처마다) */
export interface FeatureStatus {
  id: string;
  /** ok: 계산됨 · error: 실패(몸체는 앞 피처 그대로) · off: 꺼짐 · rolled: 되감기 아래 */
  state: "ok" | "warn" | "error" | "off" | "rolled";
  message?: string;
}

/** 피처 기반 부품 (Project.features·rollback) */
export type FeaturePart = Project;

// ---------------- 스케치 자리 (3면도 뷰 + 피처 스케치) ----------------

/** 스케치 자리: 3면도의 뷰 또는 스케치 피처 id */
export type SlotId = ViewId | string;

export const isViewSlot = (s: SlotId): s is ViewId => (VIEW_IDS as string[]).includes(s);

export function sketchOf(p: FeaturePart, id: string): SketchFeature | undefined {
  const f = p.features?.find((x) => x.id === id);
  return f?.kind === "sketch" ? f : undefined;
}

/** 그 자리의 도형 (없는 스케치면 빈 목록) */
export function slotShapes(p: FeaturePart, slot: SlotId): Shape2D[] {
  if (isViewSlot(slot)) return p.views[slot];
  return sketchOf(p, slot)?.shapes ?? [];
}

export function slotCons(p: FeaturePart, slot: SlotId): Constraint[] | undefined {
  if (isViewSlot(slot)) return p.constraints?.[slot];
  return sketchOf(p, slot)?.constraints;
}

export function setSlotCons(p: FeaturePart, slot: SlotId, list: Constraint[] | undefined) {
  if (isViewSlot(slot)) {
    if (list?.length) (p.constraints ??= {})[slot] = list;
    else if (p.constraints) {
      delete p.constraints[slot];
      if (!Object.keys(p.constraints).length) delete p.constraints;
    }
    return;
  }
  const sk = sketchOf(p, slot);
  if (!sk) return;
  if (list?.length) sk.constraints = list;
  else delete sk.constraints;
}

/** 자리 이름: “정면도”, “스케치 1” */
export function slotLabel(p: FeaturePart, slot: SlotId): string {
  return isViewSlot(slot) ? VIEW_LABEL[slot] : (sketchOf(p, slot)?.name ?? "스케치");
}

/** 자리의 가로·세로 축 이름: 3면도는 3D 축(X·Z …), 스케치는 가로·세로 */
export function slotAxes(slot: SlotId): [string, string] {
  return isViewSlot(slot) ? VIEW_AXES[slot] : ["가로", "세로"];
}

/** 도형이 있는 모든 자리 (3면도 뷰 + 스케치 피처) */
export function allSlots(p: FeaturePart): SlotId[] {
  return [...VIEW_IDS, ...(p.features ?? []).filter((f) => f.kind === "sketch").map((f) => f.id)];
}

/** 구속이 있는 자리 */
export function consSlots(p: FeaturePart): SlotId[] {
  return allSlots(p).filter((s) => slotCons(p, s)?.length);
}

// ---------------- 평면 계산 ----------------

const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: P3): P3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clean = (a: P3): P3 => a.map((x) => (Math.abs(x) < 1e-12 ? 0 : x)) as P3;

/** 평면: 원점, 가로(u) 방향, 법선. 세로(v) = 법선 × 가로 */
export interface PlaneFrame {
  origin: P3;
  x: P3;
  n: P3;
  y: P3;
}

/** 기본 평면 (3면도와 같은 방향: XY는 위에서, XZ는 앞에서, YZ는 오른쪽에서 본 모습) */
const BASE: Record<BasePlane, { x: P3; n: P3 }> = {
  XY: { x: [1, 0, 0], n: [0, 0, 1] },
  XZ: { x: [1, 0, 0], n: [0, -1, 0] },
  YZ: { x: [0, 1, 0], n: [1, 0, 0] },
};

/** 법선만으로 정하는 가로 방향 (면 위 스케치): 위·아래를 보면 X, 옆을 보면 Z를 세로로 */
export function xDirFor(n: P3): P3 {
  if (Math.abs(n[2]) > 0.9) return norm([1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]]);
  return norm(cross([0, 0, 1], n));
}

export function frameOf(pl: PlaneRef): PlaneFrame {
  let x: P3, n: P3, origin: P3;
  if (pl.kind === "base") {
    ({ x, n } = BASE[pl.base]);
    origin = scale(n, pl.offset);
  } else {
    n = norm(pl.face.n ?? [0, 0, 1]);
    x = xDirFor(n);
    // 원점: 세계 원점을 그 면에 내린 점 (면이 법선 방향으로 움직여도 스케치는 제자리)
    origin = scale(n, dot(pl.face.c, n) + pl.offset);
  }
  return { origin: clean(origin), x: clean(x), n: clean(n), y: clean(cross(n, x)) };
}

/** 스케치 좌표 (u, v) → 3D */
export function toWorld(f: PlaneFrame, u: number, v: number): P3 {
  return add(f.origin, add(scale(f.x, u), scale(f.y, v)));
}

/** 3D → 스케치 좌표 (u, v) (평면에 내린 점) */
export function toPlane(f: PlaneFrame, p: P3): [number, number] {
  const d: P3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  return [dot(d, f.x), dot(d, f.y)];
}

export function planeLabel(pl: PlaneRef): string {
  const off = pl.offset ? ` + ${+pl.offset.toFixed(3)} mm` : "";
  if (pl.kind === "base") return `${pl.base} 평면${off}`;
  return `부품 면${off}`;
}

// ---------------- 식으로 묶을 수 있는 값 ----------------

export type ValSite = "len" | "angle" | "count";

/** 피처 종류별 숫자 값 (키 → 종류). 식 칸과 검사에 씀 */
export const FEATURE_VALUES: Partial<Record<FeatureKind, Record<string, { site: ValSite; label: string; min?: number }>>> = {
  sketch: { offset: { site: "len", label: "평면 거리" } },
  extrude: { dist: { site: "len", label: "거리", min: 1e-6 } },
  revolve: { angle: { site: "angle", label: "각도", min: 1e-6 } },
  fillet: { r: { site: "len", label: "반지름", min: 1e-6 } },
  chamfer: { d: { site: "len", label: "거리", min: 1e-6 } },
  shell: { t: { site: "len", label: "두께", min: 1e-6 } },
  draft: { angle: { site: "angle", label: "각도" } },
  pattern: { count: { site: "count", label: "개수", min: 1 }, spacing: { site: "len", label: "간격" }, angle: { site: "angle", label: "각도" } },
  hole: { d: { site: "len", label: "지름", min: 1e-6 }, depth: { site: "len", label: "깊이", min: 1e-6 } },
  sweep: {},
};

export function getFeatureValue(f: Feature, key: string): number {
  if (key === "offset" && f.kind === "sketch") return f.plane.offset;
  const v = (f as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : NaN;
}

export function setFeatureValue(f: Feature, key: string, v: number) {
  const spec = FEATURE_VALUES[f.kind]?.[key];
  if (spec?.site === "count") v = Math.max(1, Math.round(v));
  else if (spec?.min !== undefined) v = Math.max(spec.min, v);
  if (key === "offset" && f.kind === "sketch") f.plane.offset = v;
  else (f as unknown as Record<string, number>)[key] = v;
}

// ---------------- 이름·찾기 ----------------

/** 같은 종류의 다음 이름 (돌출 1, 돌출 2 …) */
export function nextFeatureName(p: FeaturePart, kind: FeatureKind): string {
  const base = FEATURE_LABEL[kind];
  let n = 1;
  const names = new Set((p.features ?? []).map((f) => f.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** 이 피처가 가리키는 다른 피처 (스케치·패턴 원본) */
export function featureDeps(f: Feature): string[] {
  switch (f.kind) {
    case "extrude":
    case "revolve":
    case "hole":
      return [f.sketch];
    case "sweep":
      return f.profile.kind === "sketch" ? [f.path, f.profile.sketch] : [f.path];
    case "loft":
      return [...f.sketches];
    case "pattern":
    case "mirror":
      return [...f.of];
    default:
      return [];
  }
}

/** 이 피처를 쓰는 (뒤쪽) 피처들 */
export function dependents(p: FeaturePart, id: string): Feature[] {
  return (p.features ?? []).filter((f) => featureDeps(f).includes(id));
}

/** 3면도 몸체가 있는지 (있으면 피처 목록 맨 위에 “3면도”) */
export function hasViewBody(p: Project): boolean {
  return VIEW_IDS.some((v) => p.views[v].some((s) => !s.hole));
}

/** 피처가 하나라도 있는 부품인지 */
export const hasFeatures = (p: FeaturePart) => !!p.features?.length;

// ---------------- 저장된 값 검사 ----------------

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const p3 = (v: unknown): v is P3 => Array.isArray(v) && v.length === 3 && v.every(num);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const BASES: BasePlane[] = ["XY", "XZ", "YZ"];
const AXES: AxisName[] = ["X", "Y", "Z"];
const OPS: BodyOp[] = ["add", "cut", "common"];
const EXTENTS: Extent[] = ["dist", "sym", "through", "throughBoth"];

function faceSig(v: unknown): FaceSig | null {
  if (!obj(v) || !p3(v.c) || !num(v.a)) return null;
  const t = ["plane", "cylinder", "cone", "sphere", "torus", "other"].includes(v.t as string) ? (v.t as FaceSig["t"]) : "other";
  const out: FaceSig = { t, c: v.c, a: v.a };
  if (p3(v.n)) out.n = v.n;
  if (num(v.r)) out.r = v.r;
  return out;
}

function edgeSig(v: unknown): EdgeSig | null {
  if (!obj(v) || !p3(v.c) || !num(v.l)) return null;
  const t = v.t === "line" || v.t === "circle" ? v.t : "other";
  const out: EdgeSig = { t, c: v.c, l: v.l };
  if (p3(v.d)) out.d = v.d;
  if (num(v.r)) out.r = v.r;
  return out;
}

function planeRef(v: unknown): PlaneRef | null {
  if (!obj(v)) return null;
  const offset = num(v.offset) ? v.offset : 0;
  if (v.kind === "base" && BASES.includes(v.base as BasePlane)) return { kind: "base", base: v.base as BasePlane, offset };
  if (v.kind === "face") {
    const f = faceSig(v.face);
    if (f && f.n) return { kind: "face", face: f, offset };
  }
  return null;
}

/**
 * 저장된 피처 목록 검사. 망가진 피처는 빼고, 빠진 값은 기본값으로.
 * 도형·구속은 normShape·normCons로 (project.ts의 것을 넘겨받음 — 서로 import하지 않게)
 */
export function normalizeFeatures(
  raw: unknown,
  normShape: (s: unknown) => Shape2D | null,
  normCons: (list: unknown) => Constraint[] | undefined,
): Feature[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Feature[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (!obj(r) || !str(r.id) || ids.has(r.id)) continue;
    const base: FeatureBase = { id: r.id, name: str(r.name) ? r.name : "피처" };
    if (r.suppressed === true) base.suppressed = true;
    if (obj(r.exprs)) {
      const e = Object.fromEntries(Object.entries(r.exprs).filter(([, x]) => typeof x === "string" && x.trim()));
      if (Object.keys(e).length) base.exprs = e as Record<string, string>;
    }
    const op = OPS.includes(r.op as BodyOp) ? (r.op as BodyOp) : "add";
    let f: Feature | null = null;
    switch (r.kind) {
      case "sketch": {
        const plane = planeRef(r.plane);
        if (!plane) break;
        const shapes = Array.isArray(r.shapes) ? r.shapes.map(normShape).filter((s): s is Shape2D => !!s) : [];
        const constraints = normCons(r.constraints);
        f = { ...base, kind: "sketch", plane, shapes, ...(constraints ? { constraints } : {}) };
        break;
      }
      case "extrude":
        if (!str(r.sketch)) break;
        f = { ...base, kind: "extrude", sketch: r.sketch, op, extent: EXTENTS.includes(r.extent as Extent) ? (r.extent as Extent) : "dist", dist: num(r.dist) && r.dist > 0 ? r.dist : 10, ...(r.flip === true ? { flip: true } : {}) };
        break;
      case "revolve":
        if (!str(r.sketch)) break;
        f = { ...base, kind: "revolve", sketch: r.sketch, op, axis: r.axis === "u" ? "u" : "v", angle: num(r.angle) && r.angle > 0 ? Math.min(r.angle, 360) : 360 };
        break;
      case "fillet":
      case "chamfer": {
        const edges = Array.isArray(r.edges) ? r.edges.map(edgeSig).filter((e): e is EdgeSig => !!e) : [];
        if (r.kind === "fillet") f = { ...base, kind: "fillet", edges, r: num(r.r) && r.r > 0 ? r.r : 1 };
        else f = { ...base, kind: "chamfer", edges, d: num(r.d) && r.d > 0 ? r.d : 1 };
        break;
      }
      case "shell":
      case "draft": {
        const faces = Array.isArray(r.faces) ? r.faces.map(faceSig).filter((e): e is FaceSig => !!e) : [];
        if (r.kind === "shell") f = { ...base, kind: "shell", faces, t: num(r.t) && r.t > 0 ? r.t : 1 };
        else f = { ...base, kind: "draft", faces, angle: num(r.angle) ? r.angle : 3, neutral: BASES.includes(r.neutral as BasePlane) ? (r.neutral as BasePlane) : "XY" };
        break;
      }
      case "pattern":
        f = {
          ...base,
          kind: "pattern",
          mode: r.mode === "circular" ? "circular" : "linear",
          of: Array.isArray(r.of) ? r.of.filter(str) : [],
          axis: AXES.includes(r.axis as AxisName) ? (r.axis as AxisName) : "X",
          count: num(r.count) && r.count >= 1 ? Math.round(r.count) : 2,
          spacing: num(r.spacing) ? r.spacing : 10,
          angle: num(r.angle) ? r.angle : 360,
        };
        break;
      case "mirror":
        f = { ...base, kind: "mirror", of: Array.isArray(r.of) ? r.of.filter(str) : [], plane: BASES.includes(r.plane as BasePlane) ? (r.plane as BasePlane) : "YZ" };
        break;
      case "hole":
        if (!str(r.sketch) || !obj(r.spec)) break;
        f = { ...base, kind: "hole", sketch: r.sketch, spec: r.spec as unknown as HoleSpec, d: num(r.d) && r.d > 0 ? r.d : 5, depth: num(r.depth) && r.depth > 0 ? r.depth : null, ...(r.flip === true ? { flip: true } : {}) };
        break;
      case "sweep": {
        if (!str(r.path) || !obj(r.profile)) break;
        const pr = r.profile;
        const profile: SweepProfile | null =
          pr.kind === "sketch" && str(pr.sketch)
            ? { kind: "sketch", sketch: pr.sketch }
            : pr.kind === "circle" && num(pr.d) && pr.d > 0
              ? { kind: "circle", d: pr.d, ...(num(pr.inner) && pr.inner > 0 && pr.inner < pr.d ? { inner: pr.inner } : {}) }
              : null;
        if (!profile) break;
        f = { ...base, kind: "sweep", path: r.path, profile, op };
        break;
      }
      case "loft":
        if (!Array.isArray(r.sketches)) break;
        f = { ...base, kind: "loft", sketches: r.sketches.filter(str), op, ...(r.ruled === true ? { ruled: true } : {}) };
        break;
    }
    if (f) {
      ids.add(f.id);
      out.push(f);
    }
  }
  return out.length ? out : undefined;
}
