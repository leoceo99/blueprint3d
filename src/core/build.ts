/**
 * 2D 뷰(정면/평면/측면) → 3D 솔리드 → 2D 투영도.
 * replicad(OpenCascade) 위에서 동작하며, 호출 전에 setOC()가 되어 있어야 한다.
 */
import {
  draw,
  drawCircle,
  drawRectangle,
  drawProjection,
  ProjectionCamera,
  type Drawing,
  type Shape3D,
} from "replicad";
import { boundsOf, isDegenerate, normRect } from "./geometry2d";
import type { BuildResult, Project, ProjectedView, Shape2D, ViewId } from "./types";
import { VIEW_IDS, VIEW_LABEL } from "./types";

export class BuildError extends Error {}

function shapeToDrawing(s: Shape2D): Drawing {
  if (s.kind === "rect") {
    const r = normRect(s);
    return drawRectangle(r.w, r.h).translate(r.x + r.w / 2, r.y + r.h / 2);
  }
  if (s.kind === "circle") return drawCircle(s.r).translate(s.cx, s.cy);
  let pen = draw(s.pts[0]);
  for (const p of s.pts.slice(1)) pen = pen.lineTo(p);
  return pen.close();
}

/** 몸체 도형을 모두 합치고 구멍 도형을 뺀 2D 단면 */
export function profileOf(shapes: Shape2D[]): Drawing | null {
  const valid = shapes.filter((s) => !isDegenerate(s));
  const solids = valid.filter((s) => !s.hole);
  const holes = valid.filter((s) => s.hole);
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
    const b = boundsOf(p.views[v]);
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

export function buildSolid(p: Project): { shape: Shape3D; notes: string[] } {
  const notes: string[] = [];
  if (p.mode === "revolve") {
    const prof = profileOf(p.views.front);
    if (!prof) throw new BuildError("회전 모드: 정면도에 단면을 그려 주세요.");
    const big = bigLength(p);
    // 회전축(u=0) 오른쪽 절반만 사용
    const half = prof.intersect(drawRectangle(big, 2 * big).translate(big / 2, 0));
    if (!half.boundingBox || half.boundingBox.width < 1e-6)
      throw new BuildError("회전 모드: 단면이 회전축(가로 0) 오른쪽에 있어야 합니다.");
    const shape = half.sketchOnPlane("XZ").revolve([0, 0, 1], { origin: [0, 0, 0] }) as Shape3D;
    notes.push("정면도 단면을 세로축(Z) 중심으로 360° 회전했습니다.");
    return { shape, notes };
  }

  const drawn = VIEW_IDS.map((v) => ({ v, prof: profileOf(p.views[v]) })).filter(
    (x): x is { v: ViewId; prof: Drawing } => x.prof !== null,
  );
  if (!drawn.length) throw new BuildError("도면에 도형을 하나 이상 그려 주세요.");

  if (drawn.length === 1) {
    const { v, prof } = drawn[0];
    const t = p.thickness;
    if (!(t > 0)) throw new BuildError("두께는 0보다 커야 합니다.");
    // 정면도: y∈[0,t] (앞면 y=0) / 평면도: z∈[0,t] (윗면 z=t) / 우측면도: x∈[0,t]
    const shape = extrudeView(v, prof, [0, t]);
    notes.push(`${VIEW_LABEL[v]}만 그려서 두께 ${t}mm로 돌출했습니다.`);
    return { shape, notes };
  }

  const big = bigLength(p);
  let shape: Shape3D | null = null;
  for (const { v, prof } of drawn) {
    const ext = extrudeView(v, prof, [-big, big]);
    shape = shape ? (shape.intersect(ext) as Shape3D) : ext;
  }
  notes.push(
    `${drawn.map((d) => VIEW_LABEL[d.v]).join(" + ")}를 각각 돌출한 뒤 겹치는 부분(교집합)으로 만들었습니다.`,
  );
  if (drawn.length === 2)
    notes.push("뷰가 2개뿐이면 형상이 여러 가지로 해석될 수 있어요. 결과가 다르면 세 번째 뷰를 추가하세요.");
  return { shape: shape!, notes };
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
