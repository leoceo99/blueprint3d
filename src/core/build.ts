/**
 * 2D 뷰(정면/평면/측면) → 3D 솔리드 → 2D 투영도.
 * replicad(OpenCascade) 위에서 동작하며, 호출 전에 setOC()가 되어 있어야 한다.
 */
import {
  draw,
  drawCircle,
  drawRectangle,
  drawProjection,
  Plane,
  ProjectionCamera,
  type Drawing,
  type Shape3D,
} from "replicad";
import { arcInfo, boundsOf, isDegenerate, normRect, outline } from "./geometry2d";
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

/** 몸체 도형을 모두 합치고 관통 구멍을 뺀 2D 단면 */
export function profileOf(shapes: Shape2D[]): Drawing | null {
  const valid = shapes.filter((s) => !isDegenerate(s));
  const solids = valid.filter((s) => !s.hole);
  const holes = valid.filter((s) => s.hole && s.depth === undefined);
  if (!solids.length) return null;
  let d = shapeToDrawing(solids[0]);
  for (const s of solids.slice(1)) d = d.fuse(shapeToDrawing(s));
  for (const h of holes) d = d.cut(shapeToDrawing(h));
  return d;
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
  const [a, b] = range;
  const len = b - a;
  if (view === "front") {
    // XZ 평면: (u,v)→(x,z), 돌출 방향 -Y. 보는 사람은 -Y 쪽.
    return profile.sketchOnPlane("XZ", [0, b, 0]).extrude(len) as Shape3D;
  }
  if (view === "top") {
    // XY 평면: (u,v)→(x,y), 돌출 방향 +Z. 보는 사람은 +Z 쪽.
    return profile.sketchOnPlane("XY", [0, 0, a]).extrude(len) as Shape3D;
  }
  // YZ 평면: (u,v)→(y,z), 돌출 방향 +X. 보는 사람은 +X 쪽.
  return profile.sketchOnPlane("YZ", [a, 0, 0]).extrude(len) as Shape3D;
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
    const drawn = VIEW_IDS.map((v) => ({ v, prof: profileOf(p.views[v]) })).filter(
      (x): x is { v: ViewId; prof: Drawing } => x.prof !== null,
    );
    if (!drawn.length) throw new BuildError("도면에 몸체 도형을 하나 이상 그려 주세요.");
    drawn.forEach((d) => solidViews.add(d.v));

    if (drawn.length === 1) {
      const { v, prof } = drawn[0];
      const t = p.thickness;
      if (!(t > 0)) throw new BuildError("두께는 0보다 커야 합니다.");
      // 정면도: y∈[0,t] (앞면 y=0) / 평면도: z∈[0,t] (윗면 z=t) / 우측면도: x∈[0,t]
      shape = extrudeView(v, prof, [0, t]);
      notes.push(`${VIEW_LABEL[v]}만 그려서 두께 ${t}mm로 돌출했습니다.`);
    } else {
      const big = bigLength(p);
      let acc: Shape3D | null = null;
      for (const { v, prof } of drawn) {
        const ext = extrudeView(v, prof, [-big, big]);
        acc = acc ? (acc.intersect(ext) as Shape3D) : ext;
      }
      shape = acc!;
      notes.push(`${drawn.map((d) => VIEW_LABEL[d.v]).join(" + ")}를 각각 돌출한 뒤 겹치는 부분(교집합)으로 만들었습니다.`);
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
