/** 단위는 모두 mm. 각 뷰의 2D 좌표 (u = 오른쪽, v = 위쪽). */
export type ViewId = "front" | "top" | "side";

export const VIEW_IDS: ViewId[] = ["front", "top", "side"];

export const VIEW_LABEL: Record<ViewId, string> = {
  front: "정면도",
  top: "평면도",
  side: "우측면도",
};

/** 각 뷰의 (u, v)가 3D의 어느 축에 해당하는지 (3각법). */
export const VIEW_AXES: Record<ViewId, ["X" | "Y" | "Z", "X" | "Y" | "Z"]> = {
  front: ["X", "Z"],
  top: ["X", "Y"],
  side: ["Y", "Z"],
};

interface ShapeBase {
  id: string;
  /** true면 구멍(빼기), false면 몸체(더하기) */
  hole: boolean;
}

export interface RectShape extends ShapeBase {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CircleShape extends ShapeBase {
  kind: "circle";
  cx: number;
  cy: number;
  r: number;
}

export interface PolyShape extends ShapeBase {
  kind: "poly";
  pts: [number, number][];
}

export type Shape2D = RectShape | CircleShape | PolyShape;

/**
 * auto    : 그린 뷰가 1개면 두께만큼 돌출, 2~3개면 각 뷰를 돌출한 뒤 교집합
 * revolve : 정면도의 오른쪽 절반(u ≥ 0) 단면을 세로축(Z) 중심으로 회전
 */
export type BuildMode = "auto" | "revolve";

export interface Project {
  version: 1;
  name: string;
  mode: BuildMode;
  /** 뷰를 하나만 그렸을 때의 돌출 두께 */
  thickness: number;
  views: Record<ViewId, Shape2D[]>;
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: "새 부품",
    mode: "auto",
    thickness: 10,
    views: { front: [], top: [], side: [] },
  };
}

export interface MeshData {
  vertices: number[];
  normals: number[];
  triangles: number[];
  edges: number[];
}

export interface ProjectedView {
  visible: string[];
  hidden: string[];
  /** 투영 좌표계(u 오른쪽, v 위)에서의 경계 [[umin,vmin],[umax,vmax]] */
  bounds: [[number, number], [number, number]] | null;
}

export interface BuildResult {
  mesh: MeshData;
  projections: Record<ViewId, ProjectedView>;
  bbox: [[number, number, number], [number, number, number]];
  volume: number;
  /** 사용자에게 알려줄 참고 메시지 (예: 어떤 방식으로 만들었는지) */
  notes: string[];
}
