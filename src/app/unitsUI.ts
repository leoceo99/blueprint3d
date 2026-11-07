/**
 * 길이 단위 (10단계): 상태 표시줄의 mm/inch 단추, 단위 바꾸기 명령, 단위에 맞는 격자 목록.
 * 값은 늘 mm로 저장한다. 단위를 바꾸면 문서의 모든 부품에서 식을 고쳐 써서 모양이 그대로다.
 */
import { convertProjectUnit, projUnit } from "../core/params";
import { gridLabel, gridsFor, nearestGrid } from "../core/settings";
import { displayUnit, setUnitSource, type Unit } from "../core/units";
import { store } from "../store";
import { ui } from "../ui/state";
import { setGrid } from "../workspaces/designRibbon";
import type { Command } from "./commands";
import { onPanels } from "./context";
import { $ } from "./dom";
import { toast } from "./notify";

const NAME: Record<Unit, string> = { mm: "mm", inch: "inch" };

export function initUnits() {
  setUnitSource(() => projUnit(store.project));
  onPanels(sync);
  sync();
}

let shown: Unit | null = null;
function sync() {
  const u = displayUnit();
  const btn = $("#unitBtn");
  btn.textContent = NAME[u];
  btn.classList.toggle("on", u === "inch");
  if (u === shown) return;
  shown = u;
  // 격자 목록을 단위에 맞게 (inch: 0.05" 0.1" 1/8" 1/4" 1")
  const sel = $<HTMLSelectElement>("#grid");
  sel.innerHTML = gridsFor(u).map((g) => `<option value="${g}">${gridLabel(g)}</option>`).join("");
  const g = gridsFor(u).includes(ui.grid) ? ui.grid : nearestGrid(ui.grid, u);
  if (g !== ui.grid) setGrid(g);
  else sel.value = String(g);
}

/** 문서 전체의 길이 단위 바꾸기 (모양은 그대로) */
export function setDocUnits(u: Unit) {
  if (store.doc.parts.every((p) => projUnit(p) === u)) return toast(`이미 ${NAME[u]} 문서예요.`);
  let lost = 0;
  const ok = store.updateDoc((d) => {
    lost = 0;
    for (const p of d.parts) lost += convertProjectUnit(p, u);
  }, `길이 단위: ${NAME[u]}`);
  if (!ok) return;
  toast(
    lost
      ? `길이 단위를 ${NAME[u]}로 바꿨어요. 식 ${lost}개는 그대로 옮기지 못해 원래 글자로 두었어요 — 검사 목록을 확인하세요.`
      : `길이 단위를 ${NAME[u]}로 바꿨어요. 모양은 그대로이고, 맨 숫자는 이제 ${NAME[u]}예요.`,
  );
}

export function unitCommands(): Command[] {
  return [
    {
      id: "units.toggle",
      title: "길이 단위 바꾸기 (mm ↔ inch)",
      category: "문서",
      keywords: ["unit", "units", "inch", "mm", "인치", "밀리"],
      run: () => setDocUnits(displayUnit() === "inch" ? "mm" : "inch"),
    },
    { id: "units.mm", title: "길이 단위: mm", category: "문서", keywords: ["unit", "metric", "밀리미터"], checked: () => displayUnit() === "mm", run: () => setDocUnits("mm") },
    { id: "units.inch", title: "길이 단위: inch", category: "문서", keywords: ["unit", "imperial", "인치"], checked: () => displayUnit() === "inch", run: () => setDocUnits("inch") },
  ];
}
