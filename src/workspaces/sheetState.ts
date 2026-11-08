/** 도면 치수 편집 상태 (가벼움 — 편집기 코드는 도면 화면을 열 때 내려받는다) */
import type { DimEdits } from "../core/sheet";

export type DimTool = "select" | "dim";
export type DimKind = "auto" | "h" | "v" | "aligned" | "angle";

/** 화면 상태 (도면 화면을 나갔다 와도 유지) */
export const sheetEdit = {
  tool: "select" as DimTool,
  kind: "auto" as DimKind,
  selected: null as string | null,
};

export interface EditorHost {
  /** 지금 도면의 치수 고침을 바꾼다 (실행 취소 가능) */
  edit: (fn: (e: DimEdits) => void, label: string) => void;
  toast: (msg: string) => void;
  /** 도구·선택이 바뀌었을 때 (도구 단추 표시) */
  changed: () => void;
}
