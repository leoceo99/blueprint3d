/** 2D 설계의 리본: 방식·두께·제조 방식·격자·모서리 크기 입력칸 */
import { plainNumber, referencedNames } from "../core/expr";
import { evaluateParams } from "../core/params";
import type { Process, Project } from "../core/types";
import { store } from "../store";
import { fmt } from "../ui/sketch";
import { ui } from "../ui/state";
import { invalidatePanels, onPanels } from "../app/context";
import { $, $$ } from "../app/dom";
import { setTool } from "../app/edit";
import { toast } from "../app/notify";
import { prefs } from "../app/prefs";

export const PROCESS_LABEL: Record<Process, string> = { cnc: "CNC 가공", print3d: "3D 프린팅", laser: "판금 · 레이저" };

export function setMode(m: Project["mode"]) {
  store.update((p) => (p.mode = m), m === "revolve" ? "회전체로" : "돌출·교집합으로");
}
export function setProcess(v: Process) {
  store.update((p) => (p.process = v), `제조 방식: ${PROCESS_LABEL[v]}`);
}
export function setGrid(g: number) {
  ui.grid = g;
  $<HTMLSelectElement>("#grid").value = String(g);
  prefs.set({ grid: g });
  ui.emit();
}
export function setCornerKind(k: "fillet" | "chamfer") {
  ui.cornerKind = k;
  if (ui.tool !== "corner") setTool("corner");
  else ui.emit();
  invalidatePanels();
}

export function initRibbon() {
  const modeSel = $<HTMLSelectElement>("#mode");
  const thick = $<HTMLInputElement>("#thickness");
  const procSel = $<HTMLSelectElement>("#process");
  const gridSel = $<HTMLSelectElement>("#grid");
  const cornerSizeInput = $<HTMLInputElement>("#cornerSize");

  modeSel.onchange = () => setMode(modeSel.value as Project["mode"]);
  procSel.onchange = () => setProcess(procSel.value as Process);
  thick.onchange = () => {
    const text = thick.value.trim();
    const n = plainNumber(text);
    if (n !== null) {
      if (n > 0) store.update((p) => ((p.thickness = n), (p.thicknessExpr = undefined)), "두께 고치기");
      else toast("두께는 0보다 커야 합니다.");
    } else if (text) {
      // 식: 모르는 변수가 없는지 먼저 확인
      const { values } = evaluateParams(store.project);
      const unknown = referencedNames(text).find((n) => !values.has(n));
      if (unknown) toast(`없는 변수: ${unknown}`);
      else store.update((p) => (p.thicknessExpr = text), "두께 고치기");
    }
    thick.value = store.project.thicknessExpr ?? fmt(store.project.thickness);
  };
  ui.grid = prefs.get().grid;
  gridSel.value = String(ui.grid);
  gridSel.onchange = () => setGrid(parseFloat(gridSel.value));
  cornerSizeInput.onchange = () => {
    const v = parseFloat(cornerSizeInput.value);
    if (v > 0) ui.cornerSize = v;
    else cornerSizeInput.value = fmt(ui.cornerSize);
  };
  // Enter를 누르면 입력칸에서 빠져나와 바로 단축키(E 등)를 쓸 수 있게
  cornerSizeInput.onkeydown = (e) => e.key === "Enter" && cornerSizeInput.blur();
  thick.onkeydown = (e) => e.key === "Enter" && thick.blur();

  onPanels(() => {
    const p = store.project;
    modeSel.value = p.mode;
    procSel.value = p.process ?? "cnc";
    if (document.activeElement !== thick) thick.value = p.thicknessExpr ?? fmt(p.thickness);
    thick.title = p.thicknessExpr ? `= ${fmt(p.thickness)} mm` : "숫자 또는 식 (예: t, L/8)";
    $("#thicknessWrap").hidden = p.mode !== "auto";
    $$<HTMLButtonElement>("[data-corner]").forEach((b) => b.classList.toggle("on", b.dataset.corner === ui.cornerKind));
    if (document.activeElement !== cornerSizeInput) cornerSizeInput.value = fmt(ui.cornerSize);
  });
}
