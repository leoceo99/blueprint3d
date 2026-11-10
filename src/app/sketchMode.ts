/**
 * 스케치 편집 모드 (13단계): 2D 설계 화면이 스케치 피처 한 장만 보여 준다.
 * 그 평면에 지금 모델을 비춘 모습을 밑그림으로 깔아 붙기·위치 잡기에 쓴다.
 * 끝내면 3D 설계로 돌아간다.
 */
import { frameOf, planeLabel, sketchOf } from "../core/featureModel";
import { engine } from "../engine";
import { store } from "../store";
import { ui } from "../ui/state";
import { showWorkspace } from "../workspaces/registry";
import { app, emit, invalidatePanels, on, requestRender } from "./context";
import { $ } from "./dom";

let seq = 0;

/** 스케치 편집 시작 */
export function enterSketch(id: string) {
  const sk = sketchOf(store.project, id);
  if (!sk) return;
  for (const p of app.board.activePanes()) p.cancel();
  ui.sketch = id;
  ui.activeView = id;
  ui.sel = null;
  ui.selCons = null;
  ui.tool = "select";
  document.body.classList.add("sketch-mode");
  showWorkspace("design");
  syncBar();
  app.board.fitAll();
  void refreshUnderlay();
  emit("sketch", id);
  invalidatePanels();
  requestRender();
}

/** 스케치 편집 끝 → 3D 설계 (to로 다른 작업 공간) */
export function leaveSketch(to: string | null = "3d") {
  if (!ui.sketch) return;
  for (const p of app.board.activePanes()) p.cancel();
  if (ui.result) delete ui.result[ui.sketch];
  ui.sketch = null;
  ui.activeView = "front";
  ui.sel = null;
  ui.selCons = null;
  document.body.classList.remove("sketch-mode");
  syncBar();
  app.board.fitAll();
  emit("sketch", null);
  invalidatePanels();
  if (to) showWorkspace(to);
  requestRender();
}

/** 스케치 띠: 이름·평면 */
function syncBar() {
  const bar = $("#sketchBar");
  const sk = ui.sketch ? sketchOf(store.project, ui.sketch) : undefined;
  bar.hidden = !sk;
  if (!sk) return;
  $("#sketchName").textContent = sk.name;
  $("#sketchPlane").textContent = planeLabel(sk.plane);
}

/** 밑그림: 지금 모델을 스케치 평면에 비춘 모습 */
export async function refreshUnderlay() {
  const id = ui.sketch;
  const sk = id ? sketchOf(store.project, id) : undefined;
  if (!id || !sk || !app.lastBuild) return;
  const my = ++seq;
  const f = frameOf(sk.plane);
  const view = await engine.projectPlane(f.n, f.x);
  if (my !== seq || ui.sketch !== id || !view) return;
  ui.result = {
    ...(ui.result ?? {}),
    [id]: { visible: view.visible.map((d) => new Path2D(d)), hidden: view.hidden.map((d) => new Path2D(d)), bounds: view.bounds },
  };
  requestRender();
}

export function initSketchMode() {
  $("#sketchDone").addEventListener("click", () => leaveSketch());
  // 3D가 새로 만들어지면 밑그림도 (3D 결과는 3면도 뷰만 채우므로 스케치 것을 다시)
  on("built", () => {
    if (ui.sketch) void refreshUnderlay();
  });
  // 실행 취소 등으로 스케치가 없어지면 / 이름·평면이 바뀌면
  store.subscribe(() => {
    if (ui.sketch && !sketchOf(store.project, ui.sketch)) leaveSketch();
    else if (ui.sketch) syncBar();
  });
  // 다른 작업 공간(도면 출력 등)으로 가면 스케치 편집은 끝
  on("workspace", (ws) => {
    if (ui.sketch && ws !== "design") leaveSketch(null);
  });
}
