/**
 * 도형 편집 동작 (명령과 속성 패널이 같이 쓴다): 선택, 도구, 삭제, 복제, 복사본 추가, 가운데 맞춤, 변 바로잡기.
 */
import { boundsOf, translated } from "../core/geometry2d";
import { type Shape2D } from "../core/types";
import { slotShapes, type SlotId } from "../core/featureModel";
import { newId, store } from "../store";
import { ui, type Tool } from "../ui/state";
import { app, invalidatePanels } from "./context";
import { $$ } from "./dom";
import { toast } from "./notify";
import { cancelEdit, fedit, stopPlanePick } from "./featureEdit";
import { leaveSketch } from "./sketchMode";

export function selectedShape(): Shape2D | null {
  if (!ui.sel) return null;
  return slotShapes(store.project, ui.sel.view).find((s) => s.id === ui.sel!.id) ?? null;
}

export function setTool(t: Tool) {
  for (const p of app.board.activePanes()) p.cancel();
  ui.tool = t;
  ui.emit();
  invalidatePanels();
}

/** 제도판: 세 뷰 모두 보기 */
export function fitAll() {
  app.board.fitAll();
  $$("[data-focus]").forEach((x) => x.classList.toggle("on", x.getAttribute("data-focus") === "all"));
}
/** 제도판: 한 뷰만 크게 */
export function focusView(v: SlotId) {
  app.board.focus(v);
  $$("[data-focus]").forEach((x) => x.classList.toggle("on", x.getAttribute("data-focus") === v));
}

export function toggleHole() {
  const s = selectedShape();
  if (s) store.update(() => (s.hole = !s.hole), s.hole ? "몸체로 바꾸기" : "구멍으로 바꾸기");
}

/** 참조선(구성선): 그리기·구속에만 쓰고 3D에는 안 씀 (13단계) */
export function toggleConstruction() {
  const s = selectedShape();
  if (!s) return;
  store.update(() => {
    if (s.construction) delete s.construction;
    else s.construction = true;
  }, s.construction ? "보통 선으로" : "참조선으로");
}

export function setHole(s: Shape2D, hole: boolean) {
  store.update(() => (s.hole = hole), hole ? "구멍으로 바꾸기" : "몸체로 바꾸기");
}

export function deleteSelected() {
  const sel = ui.sel;
  if (!sel) return;
  store.update((p) => {
    const list = slotShapes(p, sel.view);
    const i = list.findIndex((s) => s.id === sel.id);
    if (i >= 0) list.splice(i, 1);
  }, "삭제");
  ui.sel = null;
  ui.emit();
}

export function duplicateSelected() {
  const s = selectedShape();
  if (!s || !ui.sel) return;
  const off = Math.max(ui.grid * 5, 5);
  addCopies(ui.sel.view, [translated(s, off, -off)], "복제");
}

/** 복사본들을 한 번에 추가 (실행 취소 한 번으로 되돌릴 수 있게) */
export function addCopies(view: SlotId, copies: Shape2D[], label = "복사") {
  if (!copies.length) return;
  for (const c of copies) c.id = newId();
  store.update((p) => slotShapes(p, view).push(...copies), label);
  ui.sel = { view, id: copies[copies.length - 1].id };
  ui.emit();
}

/** 그 뷰 몸체 전체의 가운데 (대칭·원형 배열의 기본 기준) */
export function partCenter(view: SlotId): [number, number] {
  const b = boundsOf(slotShapes(store.project, view));
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}

/** 부품 가운데로 맞추기 (axis 0: 가로, 1: 세로) — 위치가 잠겨 있으면 하지 않음 */
export function centerShape(s: Shape2D, view: SlotId, axis: 0 | 1) {
  // 이 도형을 뺀 몸체들의 범위 가운데 (몸체 자신을 맞출 땐 다른 몸체 기준)
  const others = slotShapes(store.project, view).filter((o) => o.id !== s.id);
  const b = boundsOf(others) ?? boundsOf(slotShapes(store.project, view));
  if (!b) return toast("기준이 될 몸체가 없어요.");
  const target = axis === 0 ? (b[0] + b[2]) / 2 : (b[1] + b[3]) / 2;
  const sb = boundsOf([{ ...s, hole: false }])!;
  const cur = axis === 0 ? (sb[0] + sb[2]) / 2 : (sb[1] + sb[3]) / 2;
  const keys = s.kind === "rect" ? [axis === 0 ? "x" : "y"] : s.kind === "circle" ? [axis === 0 ? "cx" : "cy"] : s.kind === "slot" ? (axis === 0 ? ["ax", "bx"] : ["ay", "by"]) : [];
  if (keys.some((k) => s.exprs?.[k] !== undefined)) return toast("위치가 잠겨 있거나 식에 묶여 있어요. 🔒를 풀고 다시 하세요.");
  const d = target - cur;
  store.update((p) => {
    const list = slotShapes(p, view);
    const i = list.findIndex((o) => o.id === s.id);
    if (i >= 0) list[i] = translated(list[i], axis === 0 ? d : 0, axis === 1 ? d : 0);
  }, axis === 0 ? "가로 가운데 맞춤" : "세로 가운데 맞춤");
}

/** 거의 수평·수직(5° 이내)인 변의 두 끝점을 평균 높이/위치로 맞춘다 */
export function straightenPoly(s: Extract<Shape2D, { kind: "poly" }>): number {
  const tol = Math.tan((5 * Math.PI) / 180);
  let count = 0;
  for (let pass = 0; pass < 2; pass++) {
    const n = s.pts.length;
    for (let i = 0; i < n; i++) {
      if (s.bulges?.[i]) continue;
      const a = s.pts[i];
      const b = s.pts[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      if (Math.abs(dy) > 1e-9 && Math.abs(dy) <= Math.abs(dx) * tol) {
        const m = Math.round(((a[1] + b[1]) / 2) * 1e4) / 1e4;
        a[1] = m;
        b[1] = m;
        if (pass === 0) count++;
      } else if (Math.abs(dx) > 1e-9 && Math.abs(dx) <= Math.abs(dy) * tol) {
        const m = Math.round(((a[0] + b[0]) / 2) * 1e4) / 1e4;
        a[0] = m;
        b[0] = m;
        if (pass === 0) count++;
      }
    }
  }
  return count;
}

export function straightenSelected() {
  const s = selectedShape();
  if (!s || s.kind !== "poly") return;
  let changed = 0;
  store.update(() => (changed = straightenPoly(s)), "변 바로잡기");
  toast(changed ? `변 ${changed}개를 바로잡았어요.` : "바로잡을 변이 없어요.");
}

/** Esc: 그리던 것 취소 → 선택 도구로 → 선택 해제 */
export function escape() {
  // 3D 설계: 평면 고르기·피처 편집 취소
  if (app.workspace === "3d") {
    if (fedit.plane) stopPlanePick();
    else if (fedit.id) cancelEdit();
    return;
  }
  const pane = app.board.pane(ui.activeView);
  if (pane.cancel()) return;
  if (ui.tool !== "select") setTool("select");
  else if (ui.sel) {
    ui.sel = null;
    ui.emit();
  } else if (ui.sketch && !ui.selCons) leaveSketch(); // 스케치 편집: 더 취소할 것이 없으면 끝내기
}
