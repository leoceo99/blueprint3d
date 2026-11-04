import type { Finding, ViewId } from "../core/types";

export type Tool = "select" | "rect" | "circle" | "poly";

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
