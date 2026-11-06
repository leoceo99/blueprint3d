/**
 * 작업 공간 ① 2D 설계: 3각법 제도판에 세 뷰를 그리고 고친다.
 * 리본(도구·편집·3D 생성·검사 기준·보기), 왼쪽 트리·변수, 오른쪽 속성·검사, 상태 표시줄의 스냅 단추.
 */
import type { Command } from "../app/commands";
import { app, onFrame } from "../app/context";
import { $, $$ } from "../app/dom";
import {
  centerShape,
  deleteSelected,
  duplicateSelected,
  escape,
  fitAll,
  focusView,
  selectedShape,
  setTool,
  straightenSelected,
  toggleHole,
} from "../app/edit";
import { VIEW_IDS, VIEW_LABEL, type ViewId } from "../core/types";
import { store } from "../store";
import { ui, type Tool } from "../ui/state";
import { addParam } from "../panels/params";
import { initRibbon, PROCESS_LABEL, setCornerKind, setGrid, setMode, setProcess } from "./designRibbon";
import type { Workspace } from "./registry";
import { GRIDS } from "../core/settings";

/** 2D 설계에서만 보이는 상태 표시줄 요소 */
const STATUS_ITEMS = ["#toolHint", "#coords", "#snapGridBtn", "#snapAlignBtn", "#resultBtn"];

const TOOLS: [Tool, string, string, string[]][] = [
  ["select", "선택 · 이동", "V", ["select", "move", "선택"]],
  ["rect", "사각형 그리기", "R", ["rectangle", "box"]],
  ["circle", "원 그리기", "C", ["circle", "원형"]],
  ["poly", "다각형 그리기", "L", ["polygon", "line", "선"]],
  ["slot", "장공 그리기", "S", ["slot", "긴 구멍"]],
  ["hole", "규격 구멍 놓기", "D", ["hole", "bolt", "tap", "drill", "counterbore", "countersink", "탭", "볼트", "드릴", "카운터보어", "카운터싱크"]],
  ["corner", "모서리 R · 모따기", "E", ["fillet", "chamfer", "round", "라운드", "필렛"]],
  ["measure", "측정", "M", ["measure", "distance", "ruler", "거리", "재기"]],
];

const hasSel = () => !!selectedShape();

function designCommands(): Command[] {
  const cmds: Command[] = TOOLS.map(([t, title, key, kw]) => ({
    id: `tool.${t}`,
    title,
    category: "그리기",
    keywords: kw,
    keys: [key],
    checked: () => ui.tool === t,
    run: () => setTool(t),
  }));
  cmds.push(
    { id: "edit.delete", title: "선택한 도형 삭제", category: "편집", keywords: ["delete", "remove", "지우기"], keys: ["Delete", "Backspace"], enabled: hasSel, run: deleteSelected },
    { id: "edit.duplicate", title: "복제", category: "편집", keywords: ["duplicate", "copy", "복사"], keys: ["Ctrl+D"], enabled: hasSel, run: duplicateSelected },
    { id: "edit.toggleHole", title: "몸체 ↔ 구멍 바꾸기", category: "편집", keywords: ["hole", "body", "구멍 전환"], keys: ["H"], enabled: hasSel, run: toggleHole },
    {
      id: "edit.centerH",
      title: "가로 가운데 맞춤",
      category: "편집",
      keywords: ["center", "align", "정렬"],
      enabled: hasSel,
      run: () => ui.sel && centerShape(selectedShape()!, ui.sel.view, 0),
    },
    {
      id: "edit.centerV",
      title: "세로 가운데 맞춤",
      category: "편집",
      keywords: ["center", "align", "정렬"],
      enabled: hasSel,
      run: () => ui.sel && centerShape(selectedShape()!, ui.sel.view, 1),
    },
    {
      id: "edit.straighten",
      title: "거의 수평·수직인 변 바로잡기",
      category: "편집",
      keywords: ["straighten", "수평", "수직"],
      enabled: () => selectedShape()?.kind === "poly",
      run: straightenSelected,
    },
    { id: "edit.escape", title: "그리기 취소 · 선택 해제", category: "편집", keywords: ["cancel", "escape", "deselect"], keys: ["Escape"], when: () => true, run: escape },
    { id: "view.fit", title: "세 뷰 모두 보기", category: "보기", keywords: ["fit", "zoom", "전체 보기"], keys: ["F"], run: fitAll },
    ...VIEW_IDS.map((v: ViewId) => ({ id: `view.focus.${v}`, title: `${VIEW_LABEL[v]}만 크게`, category: "보기", keywords: ["focus", "zoom", v], run: () => focusView(v) })),
    { id: "snap.grid", title: "격자 스냅", category: "보기", keywords: ["snap", "grid"], keys: ["G"], checked: () => ui.snapGrid, run: () => ((ui.snapGrid = !ui.snapGrid), ui.emit()) },
    { id: "snap.align", title: "정렬 스냅", category: "보기", keywords: ["snap", "align", "추론"], keys: ["A"], checked: () => ui.snapAlign, run: () => ((ui.snapAlign = !ui.snapAlign), ui.emit()) },
    { id: "view.result", title: "3D 결과 겹쳐 보기", category: "보기", keywords: ["overlay", "result", "투영"], checked: () => ui.showResult, run: () => ((ui.showResult = !ui.showResult), ui.emit()) },
    {
      id: "view.underlay",
      title: "도면 이미지 밑그림 보기",
      category: "보기",
      keywords: ["underlay", "image", "밑그림"],
      enabled: () => !!store.project.underlay,
      checked: () => !!store.project.underlay && store.project.underlay.show !== false,
      run: () => store.update((p) => p.underlay && (p.underlay.show = p.underlay.show === false), "밑그림 보이기/숨기기"),
    },
    ...GRIDS.map((g) => ({ id: `grid.${g}`, title: `격자 ${g} mm`, category: "보기", keywords: ["grid"], checked: () => ui.grid === g, run: () => setGrid(g) })),
    { id: "corner.fillet", title: "모서리 방식: 둥글게 (R)", category: "그리기", keywords: ["fillet"], checked: () => ui.cornerKind === "fillet", run: () => setCornerKind("fillet") },
    { id: "corner.chamfer", title: "모서리 방식: 모따기 (C)", category: "그리기", keywords: ["chamfer"], checked: () => ui.cornerKind === "chamfer", run: () => setCornerKind("chamfer") },
    { id: "mode.auto", title: "3D 방식: 자동 (돌출·교집합)", category: "3D 생성", keywords: ["extrude", "돌출"], checked: () => store.project.mode === "auto", run: () => setMode("auto") },
    { id: "mode.revolve", title: "3D 방식: 회전체", category: "3D 생성", keywords: ["revolve", "lathe", "선반"], checked: () => store.project.mode === "revolve", run: () => setMode("revolve") },
    ...(Object.keys(PROCESS_LABEL) as (keyof typeof PROCESS_LABEL)[]).map((k) => ({
      id: `process.${k}`,
      title: `검사 기준: ${PROCESS_LABEL[k]}`,
      category: "검사",
      keywords: ["process", "manufacturing", "제조"],
      checked: () => (store.project.process ?? "cnc") === k,
      run: () => setProcess(k),
    })),
    { id: "params.add", title: "변수 추가", category: "편집", keywords: ["parameter", "variable", "변수"], run: addParam },
  );
  return cmds;
}

export const designWorkspace: Workspace = {
  id: "design",
  title: "2D 설계",
  icon: "✎",
  order: 10,
  hint: "3각법 제도판에 정면도·평면도·우측면도를 그리면 3D가 만들어져요",
  show() {
    $("#ws-main").hidden = false;
    $("#ribbon").hidden = false;
    $("#stage-design").hidden = false;
    for (const id of STATUS_ITEMS) $(id).hidden = false;
  },
  hide() {
    $("#ribbon").hidden = true;
    $("#stage-design").hidden = true;
    $("#ws-main").hidden = true;
    for (const id of STATUS_ITEMS) $(id).hidden = true;
    for (const v of VIEW_IDS) app.board.panes[v].cancel();
  },
  commands: designCommands(),
};

export function initDesign() {
  initRibbon();
  // 제도판: 전체 보기 / 한 뷰만 크게
  $$<HTMLButtonElement>("[data-focus]").forEach((b) => {
    const f = b.dataset.focus!;
    b.dataset.cmd = f === "all" ? "view.fit" : `view.focus.${f}`;
  });
  onFrame(() => {
    if (app.workspace === "design") app.board.render();
  });
}
