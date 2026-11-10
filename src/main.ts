/**
 * 도면3D 시작점: 모듈들을 순서대로 붙인다. 실제 동작은 각 모듈에.
 *  app/        명령 시스템, 단축키, 파일·프로젝트, 설정, 명령 찾기, 패널 배치, 알림
 *  panels/     트리, 변수, 속성, 설계 검사
 *  workspaces/ 작업 공간 모듈 (2D 설계 · 3D 보기 · 도면 출력 · 예제)
 */
import { VIEW_IDS } from "./core/types";
import { sketchOf, slotShapes } from "./core/featureModel";
import { initSketchMode, leaveSketch } from "./app/sketchMode";
import { syncEditState } from "./app/featureEdit";
import { initFeatureTree } from "./panels/featureTree";
import { store } from "./store";
import { DraftBoard } from "./ui/board";
import { refreshColors } from "./ui/sketch";
import { ui } from "./ui/state";
import { LazyViewer } from "./app/lazyViewer";
import { isApp, setTitle } from "./app/native";
import { appCommands } from "./app/appCommands";
import { buildStats, scheduleBuild, scheduleBuildIfChanged } from "./app/build";
import { bindCommands, refreshCommandStates } from "./app/commandUI";
import { app, commands, on, onFrame, requestRender } from "./app/context";
import { $ } from "./app/dom";
import { fitAll } from "./app/edit";
import { fileCommands, importDialogsOpen, initFileMenu } from "./app/fileMenu";
import { initKeyboard, setKeyboardBlocker } from "./app/keyboard";
import { initLayout, layoutCommands } from "./app/layout";
import { initMenus } from "./app/menus";
import { toast } from "./app/notify";
import { applyExp, applyTheme, isDark, onSystemTheme, prefs } from "./app/prefs";
import { initProjects, projectCommands } from "./app/projects";
import { initSettings, settingsOpen } from "./app/settingsDialog";
import { initUnits, unitCommands } from "./app/unitsUI";
import { initShell, shellCommands } from "./app/shell";
import { initStatusbar } from "./app/statusbar";
import { pushRecent } from "./core/settings";
import { initFindings, updateFindings } from "./panels/findings";
import { initParams } from "./panels/params";
import { initProps } from "./panels/props";
import { initTree } from "./panels/tree";
import { docCommands, initDocTree, syncPartCommands } from "./panels/docTree";
import { designWorkspace, initDesign } from "./workspaces/design";
import { exampleWorkspace } from "./workspaces/example";
import { registerWorkspace, showWorkspace, unregisterWorkspace, workspaces } from "./workspaces/registry";
import { initSheet, sheetWorkspace } from "./workspaces/sheet";
import { initView3d, view3dWorkspace } from "./workspaces/view3d";

// ---------------- 화면 ----------------
app.board = new DraftBoard($<HTMLCanvasElement>("#board"));
app.viewer = new LazyViewer($("#viewer3d"));
function applyLook() {
  applyTheme();
  app.viewer.setDark(isDark());
  refreshColors();
  applyExp();
  requestRender();
}
applyLook();
onSystemTheme(applyLook);

// ---------------- 프로젝트 (시작 프로젝트를 정함) ----------------
initProjects();

// ---------------- 명령 · 작업 공간 ----------------
commands.setOverrides(prefs.get().keys);
commands.onRun = (c) => {
  // 명령 찾기 자신은 ‘최근’에 넣지 않는다
  if (!c.hidden && c.id !== "app.palette") prefs.set({ recent: pushRecent(prefs.get().recent, c.id) });
};
commands.register([...appCommands(), ...fileCommands(), ...projectCommands(), ...docCommands(), ...layoutCommands(), ...shellCommands(), ...unitCommands()]);
for (const ws of [designWorkspace, view3dWorkspace, sheetWorkspace]) registerWorkspace(ws);
const syncExample = () => {
  const on = workspaces().some((w) => w.id === exampleWorkspace.id);
  if (prefs.get().devExample && !on) registerWorkspace(exampleWorkspace);
  if (!prefs.get().devExample && on) unregisterWorkspace(exampleWorkspace.id);
};
syncExample();

// ---------------- 모듈 ----------------
initDesign();
initView3d();
initSketchMode();
initFeatureTree();
initSheet();
initDocTree();
initTree();
initParams();
initProps();
initFindings();
initStatusbar();
initUnits();
initFileMenu();
initMenus();
initLayout();
initSettings();
initShell();
initKeyboard();
setKeyboardBlocker(() => settingsOpen() || importDialogsOpen());
bindCommands();
onFrame(() => refreshCommandStates());

// 설정이 바뀌면: 테마, 실험 기능, 단축키, 예제 작업 공간, 격자
let keysJson = JSON.stringify(prefs.get().keys);
on("settings", () => {
  const s = prefs.get();
  applyLook();
  const kj = JSON.stringify(s.keys);
  if (kj !== keysJson) {
    keysJson = kj;
    commands.setOverrides(s.keys);
  }
  syncExample();
  bindCommands();
});

store.onUndoRedo = (kind, label) => toast(`${kind === "undo" ? "실행 취소" : "다시 실행"}: ${label}`);
store.onConstraintError = (msg) => toast(msg);
store.snapBaseline();
ui.subscribe(requestRender);
// 설치형 앱: 창 제목 = 파일(또는 문서) 이름
let titleKey = "";
store.subscribe(() => {
  const tk = `${store.projectId}|${store.doc.name}`;
  if (isApp() && tk !== titleKey) {
    titleKey = tk;
    void setTitle(store.projectId, store.doc.name);
  }
});
store.subscribe(() => {
  // 지워진 도형을 선택하고 있으면 해제
  if (ui.sel && !slotShapes(store.project, ui.sel.view).some((s) => s.id === ui.sel!.id)) ui.sel = null;
  // 지워진 스케치를 편집하고 있었으면 3면도로
  if (ui.sketch && !sketchOf(store.project, ui.sketch)) leaveSketch();
  syncEditState();
  // 3D 모양이 바뀐 경우에만 다시 만든다 (이름·표제란·제조 방식만 바뀌면 건너뜀)
  scheduleBuildIfChanged();
  syncPartCommands();
  updateFindings();
  requestRender();
});

// ---------------- 시작 ----------------
showWorkspace("design");
ui.activeView = VIEW_IDS.find((v) => store.project.views[v].length) ?? "front";
updateFindings();
requestAnimationFrame(() => {
  fitAll();
  scheduleBuild();
  // 첫 화면이 그려진 때 (다듬기 측정용: performance.getEntriesByName("b3d-first-frame"))
  performance.mark("b3d-first-frame");
});
// 처음 빌드가 끝나면 3D 크기까지 포함해 다시 맞춤
const firstFit = setInterval(() => {
  if (app.lastBuild || app.buildError) {
    clearInterval(firstFit);
    fitAll();
  }
}, 200);

// 개발·시험용 (나중에 플러그인 API의 출발점)
Object.assign(window, { blueprint3d: { commands, workspaces, registerWorkspace, unregisterWorkspace, store, buildStats, board: app.board, app, ui } });
