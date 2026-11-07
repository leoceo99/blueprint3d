/**
 * 다른 CAD의 3D 파일(STEP, STL) → 앱의 3D 결과(메쉬, 3면도 투영, 크기, 부피, 구멍).
 * STEP은 OpenCascade로 읽어 정확한 숨은선 투영을, STL은 삼각형 메쉬라서 직접 만든 투영을 쓴다.
 */
import { importSTEP, type Shape3D } from "replicad";
import { resultFor } from "./build";
import { applyCones, detectHoles } from "./holes3d";
import { meshBBox, meshComponents, meshForViewer, meshVolume, parseSTL, projectMesh, rotateQuarter, type Mesh } from "./mesh";
import type { BuildResult, ModelSource, ProjectedView, ViewId } from "./types";
import { VIEW_IDS } from "./types";

export async function readStep(bytes: ArrayBuffer): Promise<Shape3D> {
  const shape = (await importSTEP(new Blob([bytes]))) as unknown as Shape3D;
  const bb = shape.boundingBox;
  if (!bb || !(bb.width + bb.height + bb.depth > 0)) throw new Error("STEP 파일에서 3D 형상을 찾지 못했습니다.");
  return shape;
}

export function readStl(bytes: ArrayBuffer): Mesh {
  const m = parseSTL(bytes);
  if (!m.tri.length) throw new Error("STL 파일에 삼각형이 없습니다.");
  return m;
}

/** 90° 단위로 돌린 복사본 (X → Y → Z 순서, 원점 기준) */
export function orientShape(shape: Shape3D, turns: [number, number, number]): Shape3D {
  let s = shape.clone() as Shape3D;
  const axes: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  turns.forEach((k, i) => {
    const n = ((k % 4) + 4) % 4;
    if (n) s = s.rotate(90 * n, [0, 0, 0], axes[i]) as Shape3D;
  });
  return s;
}

const turnNote = (t: [number, number, number]) =>
  t.some((k) => ((k % 4) + 4) % 4) ? ` (돌림: X ${t[0] * 90}°, Y ${t[1] * 90}°, Z ${t[2] * 90}°)` : "";

export function stepResult(shape: Shape3D, src: Pick<ModelSource, "name" | "turns">): BuildResult {
  const res = resultFor(shape, [`STEP 파일 ‘${src.name}’에서 가져왔습니다${turnNote(src.turns)}. 정확한 곡면 그대로 3면도를 만들었습니다.`]);
  try {
    res.holes = detectHoles(shape);
    if (res.features) applyCones(res.holes, res.features, res.bbox);
    const n = VIEW_IDS.reduce((a, v) => a + res.holes![v].length, 0);
    if (n) res.notes.push(`X·Y·Z 방향 구멍 ${n}개를 찾아 도면에 지시를 붙였습니다.`);
  } catch {
    /* 구멍 찾기는 선택 */
  }
  return res;
}

export function stlResult(mesh: Mesh, src: Pick<ModelSource, "name" | "turns">): BuildResult {
  const projections = {} as Record<ViewId, ProjectedView>;
  for (const v of VIEW_IDS) projections[v] = projectMesh(mesh, v);
  return {
    mesh: meshForViewer(mesh),
    projections,
    bbox: meshBBox(mesh),
    volume: meshVolume(mesh),
    solidCount: meshComponents(mesh),
    notes: [
      `STL 파일 ‘${src.name}’에서 가져왔습니다${turnNote(src.turns)}. 삼각형 ${mesh.tri.length / 3}개.`,
      "STL은 삼각형으로 근사한 모양이라 원이 여러 각형으로 그려지고, 구멍 지시는 붙지 않습니다. 정확한 도면이 필요하면 STEP으로 받아 오세요.",
    ],
  };
}

export { rotateQuarter };
