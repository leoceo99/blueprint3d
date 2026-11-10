/**
 * 작업 공간 ① 2D 설계: 3각법 제도판에 세 뷰를 그리고 고친다.
 * 리본(도구·편집·3D 생성·검사 기준·보기), 왼쪽 트리·변수, 오른쪽 속성·검사, 상태 표시줄의 스냅 단추.
 */
import type { Command } from "../app/commands";
import { app, onFrame, onPanels } from "../app/context";
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
  toggleConstruction,
  toggleHole,
} from "../app/edit";
import { VIEW_IDS, VIEW_LABEL, type ViewId } from "../core/types";
import { store } from "../store";
import { ui, type Tool } from "../ui/state";
import { KIND_LABEL, SIGNATURES } from "../core/constraints";
import type { ConsKind } from "../core/types";
import { deleteConstraint } from "../consActions";
import { addParam } from "../panels/params";
import { initRibbon, PROCESS_LABEL, setCornerKind, setGrid, setMode, setProcess } from "./designRibbon";
import type { Workspace } from "./registry";
import { slotLabel, slotShapes } from "../core/featureModel";
import { GRIDS, gridLabel, INCH_GRIDS } from "../core/settings";
import { displayUnit } from "../core/units";

/** 2D 설계에서만 보이는 상태 표시줄 요소 */
const STATUS_ITEMS = ["#toolHint", "#coords", "#grid", "#snapGridBtn", "#snapAlignBtn", "#resultBtn"];

const CONS_WORDS: Record<ConsKind, string[]> = {
  coincident: ["coincident", "일치", "붙이기"],
  horizontal: ["horizontal", "수평"],
  vertical: ["vertical", "수직"],
  parallel: ["parallel", "평행"],
  perpendicular: ["perpendicular", "직각", "수직선"],
  equal: ["equal", "같은 길이", "같은 지름"],
  concentric: ["concentric", "동심원"],
  tangent: ["tangent", "접선", "접하게"],
  symmetric: ["symmetric", "symmetry", "대칭"],
  midpoint: ["midpoint", "중점", "가운데"],
  onLine: ["point on", "on line", "선 위"],
  fix: ["fix", "lock", "고정"],
  distance: ["distance", "dimension", "치수", "거리"],
  distanceX: ["horizontal distance", "dimension", "가로 치수"],
  distanceY: ["vertical distance", "dimension", "세로 치수"],
  angle: ["angle", "각도"],
};

/** 구속 도구 시작 */
function startConstrain(k: ConsKind) {
  ui.consKind = k;
  ui.consPicks = [];
  setTool("constrain");
}

const TOOLS: [Tool, string, string, string[]][] = [
  ["select", "선택 · 이동", "V", ["select", "move", "선택"]],
  ["rect", "사각형 그리기", "R", ["rectangle", "box"]],
  ["circle", "원 그리기", "C", ["circle", "원형"]],
  ["poly", "다각형 그리기", "L", ["polygon", "다각형"]],
  ["line", "선 이어 그리기 (열린 선 — 스윕 경로·참조)", "Shift+L", ["line", "polyline", "path", "선", "경로"]],
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
    {
      id: "edit.delete",
      title: "선택한 도형·구속 삭제",
      category: "편집",
      keywords: ["delete", "remove", "지우기"],
      keys: ["Delete", "Backspace"],
      enabled: () => hasSel() || !!ui.selCons,
      run: () => {
        if (ui.selCons) {
          const { view, id } = ui.selCons;
          ui.selCons = null;
          deleteConstraint(view, id);
          ui.emit();
        } else deleteSelected();
      },
    },
    { id: "edit.duplicate", title: "복제", category: "편집", keywords: ["duplicate", "copy", "복사"], keys: ["Ctrl+D"], enabled: hasSel, run: duplicateSelected },
    { id: "edit.toggleHole", title: "몸체 ↔ 구멍 바꾸기", category: "편집", keywords: ["hole", "body", "구멍 전환"], keys: ["H"], enabled: hasSel, run: toggleHole },
    {
      id: "edit.toggleConstruction",
      title: "참조선 ↔ 보통 선 바꾸기",
      category: "편집",
      keywords: ["construction", "reference", "참조선", "구성선", "보조선"],
      keys: ["X"],
      enabled: hasSel,
      checked: () => !!selectedShape()?.construction,
      run: toggleConstruction,
    },
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
    ...GRIDS.map((g) => ({ id: `grid.${g}`, title: `격자 ${gridLabel(g)}`, category: "보기", keywords: ["grid"], when: () => displayUnit() === "mm", checked: () => ui.grid === g, run: () => setGrid(g) })),
    ...INCH_GRIDS.map((g) => ({ id: `grid.in${g}`, title: `격자 ${gridLabel(g)}`, category: "보기", keywords: ["grid", "inch"], when: () => displayUnit() === "inch", checked: () => ui.grid === g, run: () => setGrid(g) })),
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
    ...(Object.keys(SIGNATURES) as ConsKind[]).map((k) => ({
      id: `cons.${k}`,
      title: `구속: ${KIND_LABEL[k]}`,
      category: "구속",
      keywords: ["constraint", "구속", ...CONS_WORDS[k]],
      keys: k === "distance" ? ["K"] : [],
      checked: () => ui.tool === "constrain" && ui.consKind === k,
      run: () => startConstrain(k),
    })),
    { id: "cons.show", title: "구속 기호 보이기", category: "구속", keywords: ["constraints", "show", "hide"], checked: () => ui.showCons, run: () => ((ui.showCons = !ui.showCons), ui.emit()) },
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
  // 리본 ‘구속’ 옆: 지금 뷰의 남은 자유도
  onPanels(() => {
    const badge = $("#dofBadge");
    const pane = app.board.pane(ui.activeView);
    const shapes = slotShapes(store.project, ui.activeView);
    if (!shapes.length) {
      badge.textContent = "";
      return;
    }
    const an = pane.cons.analysis();
    badge.className = "dof-badge" + (an.unsatisfied.length ? " bad" : an.dof === 0 ? " full" : "");
    badge.textContent = an.unsatisfied.length ? "⚠ 안 풀림" : an.dof === 0 ? "✓ 다 정해짐" : `자유도 ${an.dof}`;
    badge.title = `${slotLabel(store.project, ui.activeView)}: ${an.unsatisfied.length ? "지켜지지 않는 구속이 있어요" : an.dof === 0 ? "모든 도형의 크기·위치가 정해졌어요" : `더 정해야 할 값이 ${an.dof}개 남았어요 (치수 잠금🔒·구속으로)`}`;
  });
}
