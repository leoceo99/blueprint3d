/** 도면 치수 편집 상태 (가벼움 — 편집기 코드는 도면 화면을 열 때 내려받는다) */
import type { DimEdits } from "../core/sheet";
import type { DrawingView } from "../core/sheetViews";

/** 선택 · 치수 · (14단계) 단면도 · 보조 투상도 · 상세도 */
export type DimTool = "select" | "dim" | "section" | "aux" | "detail";
export type DimKind = "auto" | "h" | "v" | "aligned" | "angle";

/** 화면 상태 (도면 화면을 나갔다 와도 유지) */
export const sheetEdit = {
  tool: "select" as DimTool,
  kind: "auto" as DimKind,
  selected: null as string | null,
  /** 고른 추가 뷰 (14단계) */
  selectedView: null as string | null,
};

export interface EditorHost {
  /** 지금 도면의 치수 고침을 바꾼다 (실행 취소 가능) */
  edit: (fn: (e: DimEdits) => void, label: string) => void;
  toast: (msg: string) => void;
  /** 도구·선택이 바뀌었을 때 (도구 단추 표시) */
  changed: () => void;
  /** 지금 도면의 추가 뷰 */
  views: () => DrawingView[];
  /** 추가 뷰 바꾸기 (실행 취소 가능) */
  editViews: (fn: (list: DrawingView[]) => DrawingView[], label: string) => void;
}
