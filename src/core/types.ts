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
  /**
   * 구멍일 때만: 그 뷰에서 보이는 가장 바깥 면부터 파 들어가는 깊이 (mm).
   * 없으면 끝까지 관통. (정면도는 앞면, 평면도는 윗면, 우측면도는 오른쪽 면부터)
   */
  depth?: number;
  /**
   * 치수를 식이나 변수에 묶어 둔 것 (예: { w: "L", cx: "L/2" }).
   * 묶인 치수는 변수가 바뀌면 다시 계산되고, 끌어서 바꿀 수 없다(잠금).
   * 키는 도형마다 다르다: 사각형 x y w h / 원 cx cy d / 장공 ax ay bx by w / 구멍 depth
   */
  exprs?: Record<string, string>;
}

/** 이름 붙은 변수 (예: L = 80, t = 10, e = L/10) */
export interface Param {
  name: string;
  expr: string;
}

/** 구멍 도구로 만든 원형 구멍의 규격 */
export interface HoleSpec {
  /** 나사 호칭 (예: "M4"). purpose가 custom이면 무시 */
  size: string;
  /** 볼트 관통(정밀·보통·거침), 탭(나사), 직접 지정 */
  purpose: "clearance-close" | "clearance-normal" | "clearance-loose" | "tap" | "custom";
  /** 볼트 머리 자리 */
  head: "none" | "counterbore" | "countersink";
  /** 카운터보어 지름·깊이 */
  cbDiameter?: number;
  cbDepth?: number;
  /** 카운터싱크 바깥 지름과 각도 (기본 90°) */
  csDiameter?: number;
  csAngle?: number;
  /** 막힌 구멍 바닥을 드릴 끝 모양(118°)으로 */
  drillPoint?: boolean;
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
  /** 구멍 도구로 만든 규격 구멍이면 그 정보 */
  spec?: HoleSpec;
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
  /** 두께를 식으로 지정했으면 그 식 */
  thicknessExpr?: string;
  /** 변수 목록 */
  params?: Param[];
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
