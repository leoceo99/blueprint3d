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

/** 꼭짓점 처리: 모서리 R(둥글게) 또는 모따기 */
export interface Corner {
  kind: "fillet" | "chamfer";
  /** fillet이면 반지름, chamfer면 꼭짓점에서 양쪽으로 자르는 거리 (mm) */
  size: number;
}

export interface RectShape extends ShapeBase {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  /** 꼭짓점 순서: 왼쪽아래, 오른쪽아래, 오른쪽위, 왼쪽위 */
  corners?: (Corner | null)[];
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
  /**
   * 변 i (pts[i] → pts[i+1])의 휨 정도 (DXF bulge = tan(호 각도/4)).
   * 0이면 직선, 양수면 반시계 방향 호, 1이면 반원.
   */
  bulges?: number[];
  /** 꼭짓점 i의 모서리 처리 (양쪽 변이 직선일 때만 적용) */
  corners?: (Corner | null)[];
}

/** 장공(긴 구멍): 두 중심점 a, b와 폭 w, 양끝은 반원 */
export interface SlotShape extends ShapeBase {
  kind: "slot";
  a: [number, number];
  b: [number, number];
  w: number;
}

export type Shape2D = RectShape | CircleShape | PolyShape | SlotShape;

/**
 * auto    : 그린 뷰가 1개면 두께만큼 돌출, 2~3개면 각 뷰를 돌출한 뒤 교집합
 * revolve : 정면도의 오른쪽 절반(u ≥ 0) 단면을 세로축(Z) 중심으로 회전
 */
export type BuildMode = "auto" | "revolve";

/** 제조 방식: 설계 검사 기준이 달라진다 */
export type Process = "cnc" | "print3d" | "laser";

export const PROCESS_LABEL: Record<Process, string> = {
  cnc: "기계 가공 (CNC 밀링·드릴)",
  print3d: "3D 프린팅 (FDM)",
  laser: "판금 · 레이저 절단",
};

export interface Project {
  version: 1;
  name: string;
  mode: BuildMode;
  /** 없으면 cnc */
  process?: Process;
  /** 뷰를 하나만 그렸을 때의 돌출 두께 */
  thickness: number;
  views: Record<ViewId, Shape2D[]>;
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: "새 부품",
    mode: "auto",
    process: "cnc",
    thickness: 10,
    views: { front: [], top: [], side: [] },
  };
}

export type Severity = "error" | "warning" | "info";

/** 도면 위의 위치 (어느 뷰의 어느 도형, 어느 좌표) */
export interface FindingRef {
  view: ViewId;
  shapeId?: string;
  u?: number;
  v?: number;
}

/** 설계 검사 결과 한 건 (규칙 검사와 AI 검토가 같은 형식을 쓴다) */
export interface Finding {
  id: string;
  source: "rule" | "ai";
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  suggestion?: string;
  refs: FindingRef[];
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
  /** 결과 솔리드 개수 (1이 아니면 서로 떨어진 덩어리가 있음) */
  solidCount: number;
  /** 사용자에게 알려줄 참고 메시지 (예: 어떤 방식으로 만들었는지) */
  notes: string[];
}
