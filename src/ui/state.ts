import type { Finding, HoleSpec, ViewId } from "../core/types";

export type Tool = "select" | "rect" | "circle" | "poly" | "slot" | "hole" | "corner" | "measure";

/** 구멍 도구로 다음에 놓을 구멍 */
export interface HoleSettings {
  spec: HoleSpec;
  /** 직접 지정일 때 지름 */
  d: number;
  /** 없으면 관통 */
  depth?: number;
}

/**
 * 모든 2D 창이 함께 쓰는 화면 상태.
 * 카메라는 3D 좌표(X, Y, Z)의 중심과 배율 하나만 가진다 →
 * 정면도·평면도는 X가, 정면도·우측면도는 Z가 항상 일직선으로 맞는다 (3각법 정렬).
 */
class UIState {
  tool: Tool = "select";
  sel: { view: ViewId; id: string } | null = null;
  activeView: ViewId = "front";
  camera = { scale: 4, c: [30, 20, 20] as [number, number, number] };
  grid = 1;
  /** 모서리 도구: 둥글게(R) 또는 모따기(C)와 크기 */
  cornerKind: "fillet" | "chamfer" = "fillet";
  cornerSize = 2;
  /** 장공 도구의 기본 폭 */
  slotWidth = 6;
  hole: HoleSettings = {
    spec: { size: "M4", purpose: "clearance-normal", head: "none", cbDiameter: 8, cbDepth: 4.4, csDiameter: 9, csAngle: 90, drillPoint: true },
    d: 5,
  };
  /** 3D 결과를 각 2D 창에 흐리게 겹쳐 보기 */
  showResult = true;
  /** 3D 결과의 뷰별 투영선 (Path2D로 미리 만들어 둠) */
  result: Record<ViewId, { visible: Path2D[]; hidden: Path2D[]; bounds: [[number, number], [number, number]] | null }> | null = null;
  snapGrid = true;
  /** 다른 뷰/도형의 좌표에 맞춰 붙기 (추론 스냅) */
  snapAlign = true;
  /** 현재 커서의 3D 좌표 (모르는 축은 null) → 다른 창에 투영선 표시 */
  cursor: [number | null, number | null, number | null] | null = null;
  /** 검사 결과에서 고른 위치 (깜빡임 표시) */
  flash: { view: ViewId; u: number; v: number; until: number } | null = null;
  findings: Finding[] = [];
  hoverFindingId: string | null = null;

  private listeners = new Set<() => void>();
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((l) => l());
  }
}

export const ui = new UIState();
