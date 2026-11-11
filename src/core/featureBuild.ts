/**
 * 피처 목록 계산 (13단계, 워커에서): 3면도 몸체(있으면) → 피처를 위에서부터 차례로.
 * 피처 하나가 실패해도 그 피처만 오류로 표시하고 몸체는 앞 피처 결과 그대로 다음 피처를 계산한다 (Onshape처럼).
 */
import { draw, drawCircle, makeCompound, Plane, type Drawing, type Shape3D } from "replicad";
import { BuildError, buildSolid, resultFor, revolvedHole, shapeToDrawing } from "./build";
import {
  frameOf,
  hasViewBody,
  toWorld,
  type AxisName,
  type BodyOp,
  type Feature,
  type FeatureStatus,
  type P3,
  type PlaneFrame,
  type SketchFeature,
} from "./featureModel";
import { arcInfo, isDegenerate } from "./geometry2d";
import { faceSig, resolveEdges, resolveFaces } from "./topo";
import type { Project, Shape2D, SpecHole } from "./types";

/** 피처 계산 결과를 함께 실어 보내는 오류 (몸체가 하나도 없을 때) */
export class FeatureBuildError extends BuildError {
  constructor(
    message: string,
    readonly log: FeatureStatus[],
  ) {
    super(message);
  }
}

interface Ctx {
  /** 계산된 스케치 평면 */
  frames: Map<string, PlaneFrame>;
  /** 피처가 몸체에 더하거나 뺀 도구 형상 (패턴·대칭이 다시 씀) */
  tools: Map<string, { tool: Shape3D; op: BodyOp }>;
  sketches: Map<string, SketchFeature>;
  /** 구멍 피처(와 그 패턴·대칭)가 뚫은 구멍 — 도면 구멍 지시 (14.6) */
  holes: Map<string, SpecHole[]>;
}

/** 점·방향 옮기기 (패턴·대칭이 구멍 자리도 같이 옮김) */
function rotAround(q: P3, deg: number, axis: P3): P3 {
  const t = (deg * Math.PI) / 180;
  const [x, y, z] = axis;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const d = x * q[0] + y * q[1] + z * q[2];
  return [
    q[0] * c + (y * q[2] - z * q[1]) * s + x * d * (1 - c),
    q[1] * c + (z * q[0] - x * q[2]) * s + y * d * (1 - c),
    q[2] * c + (x * q[1] - y * q[0]) * s + z * d * (1 - c),
  ];
}
const MIRROR_N: Record<string, P3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const mirrorPt = (q: P3, n: P3): P3 => {
  const d = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
  return [q[0] - 2 * d * n[0], q[1] - 2 * d * n[1], q[2] - 2 * d * n[2]];
};

const AXIS: Record<AxisName, P3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const scale = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

const planeOf = (f: PlaneFrame, along = 0) => new Plane(add(f.origin, scale(f.n, along)), f.x, f.n);

/** 3D에 쓰는 도형 (참조선·열린 선·망가진 도형 빼고) */
const solidShapes = (shapes: Shape2D[]) => shapes.filter((s) => !s.construction && !(s.kind === "poly" && s.open) && !isDegenerate(s));

/**
 * 스케치 → 2D 단면: 몸체 도형을 합치고 구멍 표시한 도형을 뺀다.
 * 몸체 없이 구멍 표시 도형만 있으면 그 도형들을 단면으로 (빼기 돌출용으로 원을 그렸을 때)
 */
export function sketchProfile(shapes: Shape2D[]): Drawing | null {
  const valid = solidShapes(shapes);
  let bodies = valid.filter((s) => !s.hole);
  let holes = valid.filter((s) => s.hole);
  if (!bodies.length) {
    bodies = holes;
    holes = [];
  }
  if (!bodies.length) return null;
  let d = shapeToDrawing(bodies[0]);
  for (const s of bodies.slice(1)) d = d.fuse(shapeToDrawing(s));
  for (const h of holes) d = d.cut(shapeToDrawing(h));
  return d;
}

/** 스윕 경로: 첫 열린 선, 없으면 첫 닫힌 도형의 외곽선 */
function pathDrawing(shapes: Shape2D[]): Drawing | null {
  const usable = shapes.filter((s) => !s.construction);
  const open = usable.find((s): s is Extract<Shape2D, { kind: "poly" }> => s.kind === "poly" && !!s.open && s.pts.length >= 2);
  if (open) {
    let pen = draw(open.pts[0]);
    for (let i = 0; i < open.pts.length - 1; i++) {
      const a = open.pts[i];
      const b = open.pts[i + 1];
      const bulge = open.bulges?.[i] ?? 0;
      if (Math.abs(bulge) > 1e-9) {
        const arc = arcInfo({ a, b, bulge });
        pen = arc ? pen.threePointsArcTo(b, arc.mid) : pen.lineTo(b);
      } else pen = pen.lineTo(b);
    }
    return pen.done();
  }
  const closed = usable.find((s) => !(s.kind === "poly" && s.open) && !isDegenerate(s));
  return closed ? shapeToDrawing(closed) : null;
}

/** 모델 전체를 덮을 길이 (끝까지 돌출·관통 구멍) */
function bigFor(shape: Shape3D | null, f: PlaneFrame): number {
  if (!shape) return 1000;
  const [lo, hi] = shape.boundingBox.bounds as [P3, P3];
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const c: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return 2 * (diag + Math.hypot(c[0] - f.origin[0], c[1] - f.origin[1], c[2] - f.origin[2])) + 10;
}

function combine(shape: Shape3D | null, tool: Shape3D, op: BodyOp): Shape3D {
  if (!shape) {
    if (op === "add") return tool;
    throw new BuildError(op === "cut" ? "뺄 몸체가 아직 없어요 (더하기로 먼저 만들어 주세요)" : "겹칠 몸체가 아직 없어요");
  }
  const out = (op === "add" ? shape.fuse(tool) : op === "cut" ? shape.cut(tool) : shape.intersect(tool)) as Shape3D;
  const bb = out.boundingBox;
  if (!bb || !(bb.width + bb.height + bb.depth > 0)) throw new BuildError("결과 몸체가 비어 버려요");
  return out;
}

function needSketch(ctx: Ctx, id: string): { sk: SketchFeature; frame: PlaneFrame } {
  const sk = ctx.sketches.get(id);
  const frame = ctx.frames.get(id);
  if (!sk || !frame) throw new BuildError("쓰는 스케치가 없거나 이 피처보다 아래에 있어요");
  return { sk, frame };
}

function needShape(shape: Shape3D | null): Shape3D {
  if (!shape) throw new BuildError("몸체가 아직 없어요");
  return shape;
}

const msg = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return e instanceof BuildError ? m : `형상 엔진이 계산하지 못했어요 (${m})`;
};

/** 피처 하나 계산 → 새 몸체 (경고가 있으면 warn에) */
function applyFeature(f: Feature, shape: Shape3D | null, ctx: Ctx, warn: string[]): Shape3D | null {
  switch (f.kind) {
    case "sketch": {
      let pl = f.plane;
      if (pl.kind === "face" && shape) {
        const { faces } = resolveFaces(shape, [pl.face]);
        if (faces.length) pl = { ...pl, face: faceSig(faces[0]) };
        else warn.push("붙인 면을 찾지 못해 처음 자리에 두었어요");
      }
      ctx.frames.set(f.id, frameOf(pl));
      ctx.sketches.set(f.id, f);
      return shape;
    }
    case "extrude": {
      const { sk, frame } = needSketch(ctx, f.sketch);
      const prof = sketchProfile(sk.shapes);
      if (!prof) throw new BuildError("스케치에 닫힌 도형이 없어요");
      let start: number;
      let length: number;
      if (f.extent === "dist" || f.extent === "sym") {
        if (!(f.dist > 0)) throw new BuildError("거리는 0보다 커야 해요");
        length = f.dist;
        start = f.extent === "sym" ? -f.dist / 2 : f.flip ? -f.dist : 0;
      } else {
        if (!shape) throw new BuildError("‘끝까지’는 몸체가 있어야 해요");
        const big = bigFor(shape, frame);
        length = f.extent === "throughBoth" ? 2 * big : big;
        start = f.extent === "throughBoth" ? -big : f.flip ? -big : 0;
      }
      const tool = (prof.sketchOnPlane(planeOf(frame, start)) as any).extrude(length) as Shape3D;
      ctx.tools.set(f.id, { tool: tool.clone(), op: f.op });
      return combine(shape, tool, f.op);
    }
    case "revolve": {
      const { sk, frame } = needSketch(ctx, f.sketch);
      const prof = sketchProfile(sk.shapes);
      if (!prof) throw new BuildError("스케치에 닫힌 도형이 없어요");
      const axis = f.axis === "u" ? frame.x : frame.y;
      const tool = (prof.sketchOnPlane(planeOf(frame)) as any).revolve(axis, { origin: frame.origin, angle: f.angle }) as Shape3D;
      ctx.tools.set(f.id, { tool: tool.clone(), op: f.op });
      return combine(shape, tool, f.op);
    }
    case "fillet":
    case "chamfer": {
      const s = needShape(shape);
      if (!f.edges.length) throw new BuildError("모서리를 골라 주세요");
      const { edges, missing } = resolveEdges(s, f.edges);
      if (!edges.length) throw new BuildError("고른 모서리를 찾지 못했어요 (앞 피처가 바뀌었나요?)");
      if (missing) warn.push(`고른 모서리 ${missing}개를 찾지 못해 빼고 했어요`);
      const finder = (e: any) => e.inList(edges);
      return (f.kind === "fillet" ? s.fillet(f.r, finder) : s.chamfer(f.d, finder)) as Shape3D;
    }
    case "shell": {
      const s = needShape(shape);
      const { faces, missing } = resolveFaces(s, f.faces);
      if (f.faces.length && !faces.length) throw new BuildError("고른 면을 찾지 못했어요");
      if (missing) warn.push(`고른 면 ${missing}개를 찾지 못해 빼고 했어요`);
      if (!(f.t > 0)) throw new BuildError("두께는 0보다 커야 해요");
      return (s as any).shell(f.t, (x: any) => x.inList(faces)) as Shape3D;
    }
    case "draft": {
      const s = needShape(shape);
      if (!f.faces.length) throw new BuildError("기울일 면을 골라 주세요");
      const { faces, missing } = resolveFaces(s, f.faces);
      if (!faces.length) throw new BuildError("고른 면을 찾지 못했어요");
      if (missing) warn.push(`고른 면 ${missing}개를 찾지 못해 빼고 했어요`);
      return (s as any).draft(f.angle, (x: any) => x.inList(faces), f.neutral) as Shape3D;
    }
    case "pattern": {
      if (!f.of.length) throw new BuildError("따라 만들 피처를 골라 주세요");
      if (f.count < 2) return shape;
      const dir = AXIS[f.axis];
      let out = shape;
      const copies: Shape3D[] = [];
      for (const id of f.of) {
        const src = ctx.tools.get(id);
        if (!src) throw new BuildError("따라 만들 피처가 계산되지 않았어요 (꺼졌거나 오류, 또는 이 피처보다 아래)");
        const step = f.mode === "circular" ? (Math.abs(f.angle) >= 360 - 1e-9 ? 360 / f.count : f.angle / (f.count - 1)) : 0;
        for (let k = 1; k < f.count; k++) {
          const c =
            f.mode === "linear"
              ? (src.tool.clone().translate(scale(dir, f.spacing * k)) as Shape3D)
              : (src.tool.clone().rotate(step * k, [0, 0, 0], dir) as Shape3D);
          copies.push(c);
          out = combine(out, c, src.op);
          const hs = ctx.holes.get(id);
          if (hs)
            ctx.holes.set(f.id, [
              ...(ctx.holes.get(f.id) ?? []),
              ...hs.map((h) => (f.mode === "linear" ? { ...h, c: add(h.c, scale(dir, f.spacing * k)) } : { ...h, c: rotAround(h.c, step * k, dir), dir: rotAround(h.dir, step * k, dir) })),
            ]);
        }
      }
      if (copies.length) ctx.tools.set(f.id, { tool: makeCompound(copies.map((c) => c.clone())) as unknown as Shape3D, op: ctx.tools.get(f.of[0])!.op });
      return out;
    }
    case "mirror": {
      if (!f.of.length) {
        const s = needShape(shape);
        // 몸체 전체 대칭: 지금까지의 구멍도 모두
        const n = MIRROR_N[f.plane];
        const all = [...ctx.holes.values()].flat();
        if (n && all.length) ctx.holes.set(f.id, all.map((h) => ({ ...h, c: mirrorPt(h.c, n), dir: mirrorPt(h.dir, n) })));
        return s.fuse(s.clone().mirror(f.plane, [0, 0, 0]) as Shape3D) as Shape3D;
      }
      let out = shape;
      for (const id of f.of) {
        const src = ctx.tools.get(id);
        if (!src) throw new BuildError("대칭할 피처가 계산되지 않았어요 (꺼졌거나 오류, 또는 이 피처보다 아래)");
        const c = src.tool.clone().mirror(f.plane, [0, 0, 0]) as Shape3D;
        ctx.tools.set(f.id, { tool: c.clone(), op: src.op });
        const hs = ctx.holes.get(id);
        const n = MIRROR_N[f.plane];
        if (hs && n) ctx.holes.set(f.id, [...(ctx.holes.get(f.id) ?? []), ...hs.map((h) => ({ ...h, c: mirrorPt(h.c, n), dir: mirrorPt(h.dir, n) }))]);
        out = combine(out, c, src.op);
      }
      return out;
    }
    case "hole": {
      const s = needShape(shape);
      const { sk, frame } = needSketch(ctx, f.sketch);
      const centers = sk.shapes.filter((x): x is Extract<Shape2D, { kind: "circle" }> => x.kind === "circle" && !x.construction);
      if (!centers.length) throw new BuildError("스케치에 구멍 자리(원)를 그려 주세요");
      if (!(f.d > 0)) throw new BuildError("지름은 0보다 커야 해요");
      const D = f.flip ? frame.n : scale(frame.n, -1);
      const big = bigFor(s, frame);
      const tools = centers.map((c) => revolvedHole(toWorld(frame, c.cx, c.cy), D, frame.x, f.d / 2, f.depth, f.spec, big));
      ctx.holes.set(
        f.id,
        centers.map((c) => ({ c: toWorld(frame, c.cx, c.cy), dir: D, d: f.d, depth: f.depth, spec: f.spec })),
      );
      const tool = tools.length === 1 ? tools[0] : (makeCompound(tools) as unknown as Shape3D);
      ctx.tools.set(f.id, { tool: tool.clone(), op: "cut" });
      return s.cut(tool) as Shape3D;
    }
    case "sweep": {
      const { sk, frame } = needSketch(ctx, f.path);
      const path = pathDrawing(sk.shapes);
      if (!path) throw new BuildError("경로 스케치에 선을 그려 주세요");
      // 단면: 바깥 도형들(더함)과 안쪽 도형들(뺌) — replicad 스윕은 닫힌 선 하나씩만 받으므로 따로 쓸고 합친다
      let outer: Drawing[];
      let inner: Drawing[] = [];
      if (f.profile.kind === "circle") {
        if (!(f.profile.d > 0)) throw new BuildError("지름은 0보다 커야 해요");
        outer = [drawCircle(f.profile.d / 2)];
        if (f.profile.inner) inner = [drawCircle(f.profile.inner / 2)];
      } else {
        const p2 = needSketch(ctx, f.profile.sketch);
        const shapes = solidShapes(p2.sk.shapes);
        outer = shapes.filter((x) => !x.hole).map(shapeToDrawing);
        inner = shapes.filter((x) => x.hole).map(shapeToDrawing);
        if (!outer.length) throw new BuildError("단면 스케치에 닫힌 도형이 없어요");
      }
      const sweepOne = (d: Drawing): Shape3D => {
        const spine = (path as any).sketchOnPlane(planeOf(frame));
        return spine.sweepSketch((plane: Plane, origin: P3) => (d as any).sketchOnPlane(plane, origin), { frenet: true }) as Shape3D;
      };
      let tool = sweepOne(outer[0]);
      for (const d of outer.slice(1)) tool = tool.fuse(sweepOne(d)) as Shape3D;
      for (const d of inner) tool = tool.cut(sweepOne(d)) as Shape3D;
      ctx.tools.set(f.id, { tool: tool.clone(), op: f.op });
      return combine(shape, tool, f.op);
    }
    case "loft": {
      if (f.sketches.length < 2) throw new BuildError("스케치를 두 개 이상 골라 주세요");
      const secs = f.sketches.map((id) => {
        const { sk, frame } = needSketch(ctx, id);
        const first = solidShapes(sk.shapes).find((x) => !x.hole) ?? solidShapes(sk.shapes)[0];
        if (!first) throw new BuildError(`‘${sk.name}’에 닫힌 도형이 없어요`);
        return (shapeToDrawing(first) as any).sketchOnPlane(planeOf(frame));
      });
      const tool = secs[0].loftWith(secs.slice(1), { ruled: !!f.ruled }) as Shape3D;
      ctx.tools.set(f.id, { tool: tool.clone(), op: f.op });
      return combine(shape, tool, f.op);
    }
  }
}

/** 부품 → 3D + 화면·도면에 필요한 것 (워커의 “build”) */
export function buildAllPart(p: Project, opts: { proj?: boolean; cache?: BuildCache } = {}): { shape: Shape3D; result: import("./types").BuildResult } {
  const { shape, notes, log, holes } = buildPart(p, opts.cache);
  const result = resultFor(shape!, notes, opts);
  if (log.length) result.featureLog = log;
  if (holes?.length) result.specHoles = holes;
  return { shape: shape!, result };
}

export interface PartBuild {
  shape: Shape3D | null;
  notes: string[];
  log: FeatureStatus[];
  /** 구멍 피처의 구멍 (14.6) */
  holes?: SpecHole[];
}

/**
 * 앞 피처 결과 기억 (13.8): 피처를 하나 고치면 그 앞까지는 기억해 둔 몸체에서 이어 계산한다.
 * 단계마다 열쇠 = (앞 단계 열쇠 + 이 피처의 내용) — 앞쪽이 하나라도 바뀌면 그 뒤는 모두 다시.
 * 기억한 몸체는 이 기억만 갖고 있고, 돌려주는 몸체는 늘 복사본이라 밖에서 지워도 괜찮다.
 */
export interface BuildCache {
  baseKey: string;
  base: Shape3D | null;
  baseNotes: string[];
  steps: CacheStep[];
}
interface CacheStep {
  key: string;
  shape: Shape3D | null;
  status: FeatureStatus;
  frame?: PlaneFrame;
  sketch?: SketchFeature;
  tool?: { tool: Shape3D; op: BodyOp };
  holes?: SpecHole[];
  counted: boolean;
}

export const newBuildCache = (): BuildCache => ({ baseKey: "", base: null, baseNotes: [], steps: [] });

/** 기억한 몸체를 모두 지움 (부품을 닫을 때) */
export function clearBuildCache(c: BuildCache) {
  c.base?.delete?.();
  dropSteps(c, 0);
  c.baseKey = "";
  c.base = null;
}

function dropSteps(c: BuildCache, from: number) {
  const seen = new Set<Shape3D>();
  for (const st of c.steps.slice(from)) {
    // 몸체가 그대로인 단계(스케치·꺼짐·오류)는 앞 단계와 같은 물체 — 한 번만 지움
    if (st.shape && !seen.has(st.shape) && st.shape !== c.base && !c.steps.slice(0, from).some((x) => x.shape === st.shape)) {
      seen.add(st.shape);
      st.shape.delete?.();
    }
    st.tool?.tool.delete?.();
  }
  c.steps.length = Math.min(c.steps.length, from);
}

/** 짧은 문자열 열쇠 (FNV-1a 두 갈래 → 16자리) */
function hashKey(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** 부품 계산: 3면도 몸체(있으면) + 피처. 피처가 없으면 지금까지와 똑같이 3면도만. cache를 주면 앞 피처 결과를 다시 씀 */
export function buildPart(p: Project, cache?: BuildCache): PartBuild {
  const feats = p.features ?? [];
  if (!feats.length) {
    if (cache) clearBuildCache(cache);
    const r = buildSolid(p);
    return { shape: r.shape, notes: r.notes, log: [] };
  }
  const notes: string[] = [];
  let shape: Shape3D | null = null;
  const baseKey = hasViewBody(p) ? hashKey(JSON.stringify([p.views, p.mode, p.thickness])) : "-";
  if (cache && cache.baseKey === baseKey) {
    shape = cache.base;
    notes.push(...cache.baseNotes);
  } else {
    if (cache) clearBuildCache(cache);
    if (hasViewBody(p)) {
      const r = buildSolid(p);
      shape = r.shape;
      notes.push(...r.notes);
    }
    if (cache) Object.assign(cache, { baseKey, base: shape, baseNotes: [...notes], steps: [] });
  }
  const ctx: Ctx = { frames: new Map(), tools: new Map(), sketches: new Map(), holes: new Map() };
  const limit = p.rollback ?? feats.length;
  const log: FeatureStatus[] = [];
  let ok = 0;
  let key = baseKey;
  let reusing = !!cache;
  feats.forEach((f, i) => {
    if (i >= limit) return void log.push({ id: f.id, state: "rolled" });
    key = hashKey(key + "|" + JSON.stringify(f));
    const hit = reusing ? cache!.steps[i] : undefined;
    if (hit && hit.key === key) {
      // 기억한 단계: 몸체·평면·도구를 그대로
      shape = hit.shape;
      if (hit.frame) ctx.frames.set(f.id, hit.frame);
      if (hit.sketch) ctx.sketches.set(f.id, hit.sketch);
      if (hit.tool) ctx.tools.set(f.id, { tool: hit.tool.tool.clone(), op: hit.tool.op });
      if (hit.holes) ctx.holes.set(f.id, hit.holes);
      log.push(hit.status);
      if (hit.counted) ok++;
      return;
    }
    if (reusing && cache) {
      dropSteps(cache, i);
      reusing = false;
    }
    let status: FeatureStatus;
    let counted = false;
    if (f.suppressed) status = { id: f.id, state: "off" };
    else {
      const warn: string[] = [];
      try {
        shape = applyFeature(f, shape, ctx, warn);
        status = warn.length ? { id: f.id, state: "warn", message: warn.join(" · ") } : { id: f.id, state: "ok" };
        counted = f.kind !== "sketch";
      } catch (e) {
        status = { id: f.id, state: "error", message: msg(e) };
      }
    }
    if (counted) ok++;
    log.push(status);
    if (cache) {
      const t = ctx.tools.get(f.id);
      cache.steps[i] = {
        key,
        shape,
        status,
        counted,
        ...(ctx.frames.has(f.id) ? { frame: ctx.frames.get(f.id) } : {}),
        ...(ctx.sketches.has(f.id) ? { sketch: structuredClone(ctx.sketches.get(f.id)!) } : {}),
        ...(t ? { tool: { tool: t.tool.clone(), op: t.op } } : {}),
        ...(ctx.holes.has(f.id) ? { holes: ctx.holes.get(f.id) } : {}),
      };
    }
  });
  for (const t of ctx.tools.values()) t.tool.delete?.();
  if (!shape) {
    const bad = log.find((x) => x.state === "error");
    throw new FeatureBuildError(bad ? `몸체를 만들지 못했어요: ${bad.message}` : "아직 몸체가 없어요 — 스케치를 돌출하거나 회전해 보세요", log);
  }
  const errs = log.filter((x) => x.state === "error").length;
  notes.push(`피처 ${ok}개를 계산했어요${errs ? ` (오류 ${errs}개 — 피처 목록에서 확인)` : ""}.`);
  // 기억한 몸체는 기억만 갖고, 밖에는 복사본을
  // 꺼진·오류난 피처의 구멍은 빼고 (그 피처는 ctx.holes에 안 들어감 — 계산 중 오류면 지움)
  for (const st of log) if (st.state === "error" || st.state === "off" || st.state === "rolled") ctx.holes.delete(st.id);
  const holes = [...ctx.holes.values()].flat();
  return { shape: cache ? (shape as Shape3D).clone() : shape, notes, log, ...(holes.length ? { holes } : {}) };
}
