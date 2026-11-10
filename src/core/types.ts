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
  /** 참조선(구성선): 그리기·구속에만 쓰고 3D에는 쓰지 않음 (13단계) */
  construction?: boolean;
}

/** 출력 도면 설정 */
export interface SheetInfo {
  /** 용지 (가로 방향). auto면 1:1이 들어가는 가장 작은 용지 */
  paper?: "auto" | "A4" | "A3" | "A2";
  /** 척도 "auto" 또는 "1:1", "1:2", "2:1" … */
  scale?: string;
  material?: string;
  qty?: string;
  drawnBy?: string;
  /** 일반 공차 (기본: KS B ISO 2768-m) */
  tolerance?: string;
  /** 주기 (여러 줄) */
  note?: string;
}

/**
 * 가져온 도면 이미지를 제도판 밑그림으로 깔기 (이미지 자체는 따로 저장하고 key로 찾는다).
 * 이미지 픽셀 (x, y) → 뷰 좌표 (u, v) = ((x - ox) · mmPerPx, (oy - y) · mmPerPx)
 */
export interface Underlay {
  key: string;
  /** 처리한 이미지 크기 (px) */
  w: number;
  h: number;
  mmPerPx: number;
  views: Partial<Record<ViewId, { ox: number; oy: number; crop: [number, number, number, number] }>>;
  /** 보이기 (기본: 보임) */
  show?: boolean;
}

/** 가져온 3D 파일 */
export interface ModelSource {
  kind: "step" | "stl";
  name: string;
  key: string;
  /** 90° 돌리기 횟수: X축, Y축, Z축 순서 */
  turns: [number, number, number];
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
  /** 열린 선 (마지막 점에서 첫 점으로 닫지 않음) — 스윕 경로 등 (13단계). 3면도 몸체·구멍에는 쓰지 않음 */
  open?: boolean;
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

/** 구속 종류 (10단계) */
export type ConsKind =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "concentric"
  | "tangent"
  | "symmetric"
  | "onLine"
  | "midpoint"
  | "fix"
  | "distance"
  | "distanceX"
  | "distanceY"
  | "angle";

/**
 * 구속 대상. s: 도형 id 또는 "@o"(원점)·"@x"(가로축)·"@y"(세로축).
 * k: "c" 중심 · "v0"… 꼭짓점 · "a"/"b" 장공 끝 중심 · "e0"… 변(직선) · "o" 원 · "ra"/"rb" 장공 끝 원호
 */
export interface CRef {
  s: string;
  k: string;
}

export interface Constraint {
  id: string;
  kind: ConsKind;
  refs: CRef[];
  /** 치수 구속의 값 (mm, 각도는 °) */
  value?: number;
  /** 값을 식으로 (예: L/2) */
  expr?: string;
  /** 만들 때의 방향(부호) — 거리·접선이 반대쪽으로 뒤집히지 않게 */
  side?: number;
  /** 고정 구속의 위치 */
  at?: [number, number];
}

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
  /** 출력 도면 설정 (용지, 척도, 표제란) */
  sheet?: SheetInfo;
  /** 가져온 도면 이미지 밑그림 */
  underlay?: Underlay;
  /** 다른 CAD에서 가져온 3D 파일. 있으면 3D·도면은 이 모델로 만든다 (파일 내용은 브라우저 저장소에 key로) */
  source?: ModelSource;
  views: Record<ViewId, Shape2D[]>;
  /** 뷰마다 구속 조건 (10단계) */
  constraints?: Partial<Record<ViewId, Constraint[]>>;
  /** 길이 단위 (없으면 mm). 값은 늘 mm로 저장하고 표시·입력·식의 맨 숫자만 이 단위 (10단계) */
  units?: "inch";
  /** 피처 목록 (13단계): 3면도 몸체(있으면) 다음에 위에서부터 차례로 계산 */
  features?: import("./featureModel").Feature[];
  /** 되감기: 앞에서부터 이 개수의 피처만 계산 (없으면 전부) */
  rollback?: number;
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
  /** 면마다 삼각형 범위 [시작, 개수] (triangles 배열의 인덱스 기준, topo.faces와 같은 순서) */
  faceGroups?: [number, number][];
  /** 모서리마다 선 범위 [시작, 개수] (edges 배열의 인덱스 기준, topo.edges와 같은 순서) */
  edgeGroups?: [number, number][];
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
  /** 가져온 3D 모델에서 찾은 구멍 (뷰 좌표). 도면의 구멍 지시에 쓴다 */
  holes?: Record<ViewId, Shape2D[]>;
  /** 형상 특징 (높이·필렛·모따기·보스·원뿔) — 도면 자동 치수에 쓴다 (11단계) */
  features?: import("./featureTypes").Features3D;
  /** 피처마다 계산 결과 (13단계) */
  featureLog?: import("./featureModel").FeatureStatus[];
  /** 면·모서리 지문 (3D 화면에서 고르기 — mesh.faceGroups·edgeGroups의 순서와 같음, 13단계) */
  topo?: { faces: import("./featureModel").FaceSig[]; edges: import("./featureModel").EdgeSig[]; faceEdges?: number[][] };
}
