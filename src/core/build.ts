/**
 * 2D 뷰(정면/평면/측면) → 3D 솔리드 → 2D 투영도.
 * replicad(OpenCascade) 위에서 동작하며, 호출 전에 setOC()가 되어 있어야 한다.
 */
import {
  addHolesInFace,
  basicFaceExtrusion,
  draw,
  drawCircle,
  drawRectangle,
  drawProjection,
  makeCompound,
  Plane,
  ProjectionCamera,
  type Drawing,
  type Shape3D,
} from "replicad";
import { arcInfo, boundsOf, distToBoundary, isDegenerate, normRect, outline, pointInShape } from "./geometry2d";
import type { BuildResult, HoleSpec, Project, ProjectedView, Shape2D, ViewId } from "./types";
import { VIEW_IDS, VIEW_LABEL } from "./types";

export class BuildError extends Error {}

function shapeToDrawing(s: Shape2D): Drawing {
  if (s.kind === "circle") return drawCircle(s.r).translate(s.cx, s.cy);
  if (s.kind === "rect" && !s.corners?.some(Boolean)) {
    const r = normRect(s);
    return drawRectangle(r.w, r.h).translate(r.x + r.w / 2, r.y + r.h / 2);
  }
  // 선과 원호로 이루어진 외곽선을 그대로 따라 그린다 (원호는 세 점 원호)
  const segs = outline(s);
  let pen = draw(segs[0].a);
  segs.forEach((seg, i) => {
    const end = i === segs.length - 1 ? segs[0].a : seg.b;
    const arc = arcInfo(seg);
    if (i === segs.length - 1 && !arc) return; // 마지막 직선은 close()가 그린다
    pen = arc ? pen.threePointsArcTo(end, arc.mid) : pen.lineTo(end);
  });
  return pen.close();
}

/**
 * 2D 단면에서 바로 빼는 구멍: 깊이 지정 없이 관통하는 구멍.
 * 깊이가 있거나 머리 자리(카운터보어·카운터싱크)가 있는 구멍은 3D를 만든 뒤 따로 판다.
 */
function isProfileHole(s: Shape2D): boolean {
  return s.hole && s.depth === undefined && !(s.kind === "circle" && s.spec && s.spec.head !== "none");
}

/**
 * 몸체 도형을 모두 합친 2D 단면. withHoles면 관통 구멍도 2D에서 뺀다 (회전체용).
 * 돌출할 때는 extrudeProfile이 구멍을 더 빠른 방법으로 넣는다.
 */
export function profileOf(shapes: Shape2D[], withHoles = true): Drawing | null {
  const valid = shapes.filter((s) => !isDegenerate(s));
  const solids = valid.filter((s) => !s.hole);
  if (!solids.length) return null;
  let d = shapeToDrawing(solids[0]);
  for (const s of solids.slice(1)) d = d.fuse(shapeToDrawing(s));
  if (withHoles) for (const h of valid.filter(isProfileHole)) d = d.cut(shapeToDrawing(h));
  return d;
}

type Pt = [number, number];
function ptSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
/** 두 선분(점일 수도 있음) 사이의 최소 거리 */
function segDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cross = (o: Pt, p: Pt, q: Pt) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
}

/**
 * 뷰의 관통 구멍을 그 뷰 방향으로 끝까지 뚫는다.
 * 서로 겹치지 않는 구멍끼리 한 묶음(compound)으로 만들어 불리언 연산을 묶음마다 한 번만 한다.
 */
function cutThroughHoles(view: ViewId, shape: Shape3D, holes: Shape2D[], big: number): Shape3D {
  type Group = { tools: Shape3D[]; boxes: [number, number, number, number][] };
  const groups: Group[] = [];
  const apart = (a: number[], b: number[]) => a[2] < b[0] - 1e-3 || b[2] < a[0] - 1e-3 || a[3] < b[1] - 1e-3 || b[3] < a[1] - 1e-3;
  for (const h of holes) {
    const box = boundsOf([{ ...h, hole: false }]);
    if (!box) continue;
    let g = groups.find((x) => x.boxes.every((o) => apart(o, box)));
    if (!g) groups.push((g = { tools: [], boxes: [] }));
    g.tools.push(extrudeView(view, shapeToDrawing(h), [-big, big]));
    g.boxes.push(box);
  }
  for (const g of groups) shape = shape.cut(g.tools.length === 1 ? g.tools[0] : (makeCompound(g.tools) as unknown as Shape3D)) as Shape3D;
  return shape;
}

/** 모델 전체를 덮을 만큼 긴 돌출 길이 */
function bigLength(p: Project): number {
  let m = p.thickness;
  for (const v of VIEW_IDS) {
    const b = boundsOf(p.views[v].map((s) => ({ ...s, hole: false })));
    if (b) m = Math.max(m, ...b.map(Math.abs));
  }
  return m * 4 + 100;
}

/**
 * 뷰의 단면을 그 뷰의 시선 축 방향으로 돌출해 깊이 좌표 [a, b] 범위를 채운다.
 * (정면도는 Y, 평면도는 Z, 우측면도는 X 좌표)
 */
function extrudeView(view: ViewId, profile: Drawing, range: [number, number]): Shape3D {
  return sketchView(view, profile, range).extrude(range[1] - range[0]) as Shape3D;
}

function sketchView(view: ViewId, profile: Drawing, range: [number, number]) {
  const [a, b] = range;
  // 정면도 XZ 평면: (u,v)→(x,z), 돌출 방향 -Y (보는 사람은 -Y 쪽)
  if (view === "front") return profile.sketchOnPlane("XZ", [0, b, 0]);
  // 평면도 XY 평면: (u,v)→(x,y), 돌출 방향 +Z (보는 사람은 +Z 쪽)
  if (view === "top") return profile.sketchOnPlane("XY", [0, 0, a]);
  // 우측면도 YZ 평면: (u,v)→(y,z), 돌출 방향 +X (보는 사람은 +X 쪽)
  return profile.sketchOnPlane("YZ", [a, 0, 0]);
}

/**
 * 뷰의 단면(몸체 + 관통 구멍)을 range 범위로 돌출한다.
 * 구멍을 2D에서 하나씩 빼면 구멍이 많을 때 아주 느리다(126개에 5초). 그래서
 *  - 몸체 도형 하나 안에 완전히 들어 있고 서로 떨어진 원형 구멍은 면의 안쪽 경계로 바로 넣고 (불리언 없음)
 *  - 나머지 관통 구멍은 돌출한 뒤 3D에서 한꺼번에 뺀다 (rest로 돌려줌)
 * 결과 형상은 2D에서 빼는 것과 같다.
 */
function extrudeProfile(
  view: ViewId,
  shapes: Shape2D[],
  range: [number, number],
): { solid: Shape3D; rest: Shape2D[] } | null {
  const prof = profileOf(shapes, false);
  if (!prof) return null;
  const valid = shapes.filter((s) => !isDegenerate(s));
  const solids = valid.filter((s) => !s.hole);
  const through = valid.filter(isProfileHole);
  // 원과 장공을 "축(점 또는 선분) + 반지름"으로 보고, 몸체 하나 안에 완전히 들어가는지 / 서로 떨어졌는지 본다
  type Capsule = { h: Shape2D; a: Pt; b: Pt; r: number };
  const inner: Capsule[] = [];
  for (const h of through) {
    let cap: Capsule;
    if (h.kind === "circle") cap = { h, a: [h.cx, h.cy], b: [h.cx, h.cy], r: h.r };
    else if (h.kind === "slot") cap = { h, a: h.a, b: h.b, r: h.w / 2 };
    else continue;
    // 축 위의 점들을 r/4 간격으로 찍어서 모두 몸체 안, 경계에서 r(+틈 보정) 넘게 떨어져 있으면 통과
    const L = Math.hypot(cap.b[0] - cap.a[0], cap.b[1] - cap.a[1]);
    const n = Math.max(1, Math.ceil(L / (cap.r / 4)));
    const samples: Pt[] = Array.from({ length: n + 1 }, (_, i) => [
      cap.a[0] + ((cap.b[0] - cap.a[0]) * i) / n,
      cap.a[1] + ((cap.b[1] - cap.a[1]) * i) / n,
    ]);
    const margin = L > 0 ? cap.r * 1.02 + 1e-3 : cap.r + 1e-3;
    const inside = solids.some((sol) => samples.every((q) => pointInShape(q[0], q[1], sol) && distToBoundary(q, sol) > margin));
    const apart = inner.every((o) => segDist(o.a, o.b, cap.a, cap.b) > o.r + cap.r + 1e-3);
    if (inside && apart) inner.push(cap);
  }
  const sk = sketchView(view, prof, range) as any;
  const len = range[1] - range[0];
  if (inner.length && typeof sk.face === "function") {
    try {
      const wires = inner.map((c) => (sketchView(view, shapeToDrawing(c.h), range) as any).wire);
      const face = addHolesInFace(sk.face(), wires);
      const solid = basicFaceExtrusion(face, sk.defaultDirection.multiply(len)) as unknown as Shape3D;
      return { solid, rest: through.filter((h) => !inner.some((c) => c.h === h)) };
    } catch {
      // 면 만들기가 실패하면 아래의 일반 방법으로
    }
  }
  return { solid: sk.extrude(len) as Shape3D, rest: through };
}

type Bounds3 = [[number, number, number], [number, number, number]];

/** 뷰에서 보이는 가장 바깥 면의 위치와, 그 면에서 재료 안쪽으로 들어가는 방향 */
function faceOf(view: ViewId, bb: Bounds3) {
  if (view === "front") return { axis: 1, face: bb[0][1], into: 1 as const };
  if (view === "top") return { axis: 2, face: bb[1][2], into: -1 as const };
  return { axis: 0, face: bb[1][0], into: -1 as const };
}

/** 깊이 좌표 범위: 바깥 면에서 depth만큼 (조금 바깥에서 시작해 깨끗하게 잘리게) */
function depthRange(view: ViewId, bb: Bounds3, depth: number, e: number): [number, number] {
  const { face, into } = faceOf(view, bb);
  return into > 0 ? [face - e, face + depth] : [face - depth, face + e];
}

/**
 * 원형 구멍을 단면 회전으로 만든다: 머리 자리(카운터보어/카운터싱크) + 몸통 + (막힌 구멍이면) 드릴 끝.
 * 단면은 (반지름 방향, 깊이 방향) 좌표로 그리고 구멍 축을 중심으로 360° 돌린다.
 */
export function roundHoleTool(
  view: ViewId,
  center: [number, number],
  r: number,
  depth: number | null,
  spec: HoleSpec | undefined,
  bb: Bounds3,
  big: number,
): Shape3D {
  const { face } = faceOf(view, bb);
  const [cu, cv] = center;
  // P: 바깥 면 위의 구멍 중심, D: 재료 안쪽 방향, X: 단면의 반지름 방향
  const P: [number, number, number] = view === "top" ? [cu, cv, face] : view === "front" ? [cu, face, cv] : [face, cu, cv];
  const D: [number, number, number] = view === "top" ? [0, 0, -1] : view === "front" ? [0, 1, 0] : [-1, 0, 0];
  const X: [number, number, number] = view === "side" ? [0, 1, 0] : [1, 0, 0];
  const N: [number, number, number] = [X[1] * D[2] - X[2] * D[1], X[2] * D[0] - X[0] * D[2], X[0] * D[1] - X[1] * D[0]];
  const plane = new Plane(P, X, N);

  const e = Math.max(0.5, r * 0.2);
  const bottom = depth ?? big;
  const pts: [number, number][] = [[0, -e]];
  const head = spec?.head ?? "none";
  if (head === "counterbore" && spec?.cbDiameter && spec.cbDiameter / 2 > r && spec.cbDepth && spec.cbDepth > 0) {
    const R = spec.cbDiameter / 2;
    const h = Math.min(spec.cbDepth, bottom);
    pts.push([R, -e], [R, h], [r, h]);
  } else if (head === "countersink" && spec?.csDiameter && spec.csDiameter / 2 > r) {
    const R = spec.csDiameter / 2;
    const half = (((spec.csAngle ?? 90) / 2) * Math.PI) / 180;
    const h = Math.min((R - r) / Math.tan(half), bottom);
    pts.push([R, -e], [R, 0], [r, h]);
  } else {
    pts.push([r, -e]);
  }
  pts.push([r, bottom]);
  // 막힌 구멍의 드릴 끝: 118° 원뿔
  if (depth !== null && spec?.drillPoint) pts.push([0, bottom + r / Math.tan((59 * Math.PI) / 180)]);
  else pts.push([0, bottom]);

  let pen = draw(pts[0]);
  for (const q of pts.slice(1)) pen = pen.lineTo(q);
  const sketch = pen.close().sketchOnPlane(plane) as any;
  return sketch.revolve(D, { origin: P }) as Shape3D;
}

/** 단면 회전/돌출로 만든 몸체에 깊이 있는 구멍, 머리 자리, 몸체 없는 뷰의 구멍을 판다 */
function cutHoleFeatures(p: Project, shape: Shape3D, solidViews: Set<ViewId>, notes: string[]): Shape3D {
  const bb = shape.boundingBox.bounds as Bounds3;
  const big = bigLength(p);
  let count = 0;
  let crossCount = 0;
  for (const v of VIEW_IDS) {
    for (const h of p.views[v]) {
      if (!h.hole || isDegenerate(h)) continue;
      const inProfile = solidViews.has(v) && isProfileHole(h);
      if (inProfile) continue;
      let tool: Shape3D;
      if (h.kind === "circle") {
        tool = roundHoleTool(v, [h.cx, h.cy], h.r, h.depth ?? null, h.spec, bb, big);
      } else {
        const range: [number, number] = h.depth !== undefined ? depthRange(v, bb, h.depth, 0.5) : [-big, big];
        tool = extrudeView(v, shapeToDrawing(h), range);
      }
      shape = shape.cut(tool) as Shape3D;
      if (solidViews.has(v)) count++;
      else crossCount++;
    }
  }
  if (count) notes.push(`깊이 또는 머리 자리가 있는 구멍·포켓 ${count}개를 바깥 면부터 팠습니다.`);
  if (crossCount) notes.push(`몸체 없이 구멍만 그린 뷰의 구멍 ${crossCount}개를 그 방향으로 팠습니다.`);
  return shape;
}

export function buildSolid(p: Project): { shape: Shape3D; notes: string[] } {
  const notes: string[] = [];
  let shape: Shape3D;
  const solidViews = new Set<ViewId>();

  if (p.mode === "revolve") {
    const prof = profileOf(p.views.front);
    if (!prof) throw new BuildError("회전 모드: 정면도에 단면을 그려 주세요.");
    const big = bigLength(p);
    // 회전축(u=0) 오른쪽 절반만 사용
    const half = prof.intersect(drawRectangle(big, 2 * big).translate(big / 2, 0));
    if (!half.boundingBox || half.boundingBox.width < 1e-6)
      throw new BuildError("회전 모드: 단면이 회전축(가로 0) 오른쪽에 있어야 합니다.");
    shape = half.sketchOnPlane("XZ").revolve([0, 0, 1], { origin: [0, 0, 0] }) as Shape3D;
    solidViews.add("front");
    notes.push("정면도 단면을 세로축(Z) 중심으로 360° 회전했습니다.");
    if ((["top", "side"] as ViewId[]).some((v) => p.views[v].some((s) => !s.hole)))
      notes.push("회전체 모드에서는 평면도·우측면도의 몸체는 쓰지 않고 구멍만 반영합니다.");
  } else {
    const drawn = VIEW_IDS.filter((v) => p.views[v].some((s) => !s.hole && !isDegenerate(s)));
    if (!drawn.length) {
      if (VIEW_IDS.some((v) => p.views[v].some((s) => !s.hole)))
        throw new BuildError("몸체 도형이 잘못되어(꼬인 다각형, 크기 0 등) 3D를 만들 수 없습니다. 아래 검사 항목을 확인하세요.");
      throw new BuildError("도면에 몸체 도형을 하나 이상 그려 주세요.");
    }
    drawn.forEach((v) => solidViews.add(v));
    const big = bigLength(p);

    if (drawn.length === 1) {
      const v = drawn[0];
      const t = p.thickness;
      if (!(t > 0)) throw new BuildError("두께는 0보다 커야 합니다.");
      // 정면도: y∈[0,t] (앞면 y=0) / 평면도: z∈[0,t] (윗면 z=t) / 우측면도: x∈[0,t]
      const { solid, rest } = extrudeProfile(v, p.views[v], [0, t])!;
      shape = cutThroughHoles(v, solid, rest, big);
      notes.push(`${VIEW_LABEL[v]}만 그려서 두께 ${t}mm로 돌출했습니다.`);
    } else {
      let acc: Shape3D | null = null;
      const rests: [ViewId, Shape2D[]][] = [];
      for (const v of drawn) {
        const { solid, rest } = extrudeProfile(v, p.views[v], [-big, big])!;
        rests.push([v, rest]);
        acc = acc ? (acc.intersect(solid) as Shape3D) : solid;
      }
      shape = acc!;
      for (const [v, rest] of rests) shape = cutThroughHoles(v, shape, rest, big);
      notes.push(`${drawn.map((v) => VIEW_LABEL[v]).join(" + ")}를 각각 돌출한 뒤 겹치는 부분(교집합)으로 만들었습니다.`);
      if (drawn.length === 2)
        notes.push("뷰가 2개뿐이면 형상이 여러 가지로 해석될 수 있어요. 결과가 다르면 세 번째 뷰를 추가하세요.");
    }
  }

  const bb = shape.boundingBox;
  if (bb && bb.width + bb.height + bb.depth > 0) shape = cutHoleFeatures(p, shape, solidViews, notes);
  return { shape, notes };
}

/** 3각법 카메라: 정면은 -Y에서, 평면은 +Z에서, 우측면은 +X에서 본다. */
export function cameraFor(view: ViewId): ProjectionCamera {
  if (view === "front") return new ProjectionCamera([0, 0, 0], [0, -1, 0], [1, 0, 0]);
  if (view === "top") return new ProjectionCamera([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  return new ProjectionCamera([0, 0, 0], [1, 0, 0], [0, 1, 0]);
}

function flatPaths(paths: string[] | string[][]): string[] {
  return (paths as (string | string[])[]).flat();
}

export function project(shape: Shape3D, view: ViewId): ProjectedView {
  const { visible, hidden } = drawProjection(shape, cameraFor(view));
  const bb = visible.boundingBox;
  return {
    visible: flatPaths(visible.toSVGPaths()),
    hidden: hidden.boundingBox ? flatPaths(hidden.toSVGPaths()) : [],
    bounds: bb
      ? [
          [bb.bounds[0][0], bb.bounds[0][1]],
          [bb.bounds[1][0], bb.bounds[1][1]],
        ]
      : null,
  };
}

export function buildAll(p: Project): { shape: Shape3D; result: BuildResult } {
  const { shape, notes } = buildSolid(p);
  const bbox = shape.boundingBox;
  if (!bbox || !(bbox.width + bbox.height + bbox.depth > 0)) throw new BuildError("결과 형상이 비어 있습니다. 뷰끼리 서로 겹치는지 확인하세요.");
  const size = Math.max(bbox.width, bbox.height, bbox.depth);
  const tol = Math.max(0.005, size / 2000);
  const m = shape.mesh({ tolerance: tol, angularTolerance: 0.2 });
  const e = shape.meshEdges({ tolerance: tol, angularTolerance: 0.2 });
  const projections = {} as Record<ViewId, ProjectedView>;
  for (const v of VIEW_IDS) projections[v] = project(shape, v);
  let volume = 0;
  try {
    volume = measureVolume(shape);
  } catch {
    volume = 0;
  }
  return {
    shape,
    result: {
      mesh: {
        vertices: Array.from(m.vertices),
        normals: Array.from(m.normals),
        triangles: Array.from(m.triangles),
        edges: Array.from(e.lines),
      },
      projections,
      bbox: bbox.bounds as BuildResult["bbox"],
      volume,
      solidCount: countSolids(shape),
      notes,
    },
  };
}

function countSolids(shape: Shape3D): number {
  try {
    return (shape as any).solids?.length ?? 1;
  } catch {
    return 1;
  }
}

/** 메쉬 기반 부피 (발산 정리) */
function measureVolume(shape: Shape3D): number {
  const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.2 });
  const v = m.vertices;
  const t = m.triangles;
  let vol = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3;
    vol +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return Math.abs(vol);
}
