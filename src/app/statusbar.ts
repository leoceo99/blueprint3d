/** 상태 표시줄: 좌표, 도구 설명, 스냅 단추, 3D 상태 */
import { store } from "../store";
import { fmt } from "../ui/sketch";
import { ui, type Tool } from "../ui/state";
import { onUnderlayReady } from "../underlay";
import { showWorkspace } from "../workspaces/registry";
import { app, onFrame, requestRender } from "./context";
import { $ } from "./dom";

const HINTS: Record<Tool, string> = {
  select: "클릭: 선택 · 끌기: 이동 · 꼭짓점 끌기: 크기 · 빈 곳 끌기/휠 클릭/스페이스+끌기: 화면 이동 · 휠: 확대",
  rect: "끌거나 두 번 클릭해서 사각형 · 그리는 중 숫자 입력 → 정확한 치수 (예: 40,20) · Shift: 정사각형",
  circle: "중심에서 끌어서 원 · 그리는 중 숫자 입력 → 지름 · 몸체 안에 그리면 자동으로 구멍",
  poly: "클릭으로 점 추가 · 첫 점 클릭/더블클릭/Enter: 닫기 · Shift: 수평·수직·45° · 숫자 입력: 30<90 또는 Δx,Δy · Backspace: 점 취소",
  hole: "클릭한 곳에 규격 구멍을 놓습니다 · 규격·용도·머리 자리·깊이는 오른쪽 ‘구멍 설정’에서 · 다른 뷰의 3D 윤곽(흐린 선)에 맞춰 놓으면 옆으로 뚫는 구멍",
  slot: "한쪽 끝 중심에서 다른 쪽 끝 중심까지 끌기 · 숫자 입력: 중심거리,폭 (예: 20,6) · Shift: 수평·수직·45°",
  corner: "사각형·다각형의 꼭짓점 클릭: 모서리 R/모따기 적용 (같은 값이면 해제) · Shift+클릭: 그 도형의 모든 꼭짓점",
  measure: "두 점을 클릭해서 거리 재기 (점·중심·정렬선에 붙음) · Esc: 지우기",
};

export function initStatusbar() {
  for (const [sel, cmd] of [
    ["#snapGridBtn", "snap.grid"],
    ["#snapAlignBtn", "snap.align"],
    ["#resultBtn", "view.result"],
    ["#underlayBtn", "view.underlay"],
  ] as const) {
    const b = $(sel);
    b.dataset.cmd = cmd;
    b.dataset.activeClass = "on";
    b.dataset.noDisable = "1";
  }
  $("#buildStatus").onclick = () => app.lastBuild && showWorkspace("3d");
  onUnderlayReady(() => requestRender());
  for (const v of Object.values(app.board.panes)) v.onPolyDraft = () => requestRender();
  onFrame(renderStatus);
}

function renderStatus() {
  const c = ui.cursor;
  const f = (n: number | null) => (n === null ? "—" : fmt(n).padStart(7));
  $("#coords").textContent = c ? `X ${f(c[0])}  Y ${f(c[1])}  Z ${f(c[2])} mm` : "X —  Y —  Z —";
  $("#toolHint").textContent = HINTS[ui.tool];
  $("#snapGridBtn").classList.toggle("on", ui.snapGrid);
  $("#snapAlignBtn").classList.toggle("on", ui.snapAlign);
  $("#resultBtn").classList.toggle("on", ui.showResult);
  const u = store.project.underlay;
  const ub = $("#underlayBtn");
  ub.hidden = app.workspace !== "design" || !u;
  ub.classList.toggle("on", !!u && u.show !== false);
}
