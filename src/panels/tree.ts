/** 왼쪽 패널: 모델 트리 (뷰별 도형 목록 + 3D 결과 요약) */
import { type Finding } from "../core/types";
import { slotAxes, slotLabel, slotShapes, type SlotId } from "../core/featureModel";
import { store } from "../store";
import { fmt, shapeLabel } from "../ui/sketch";
import { fmtVol, unitLabel } from "../core/units";
import { ui } from "../ui/state";
import { app, onPanels } from "../app/context";
import { $, esc } from "../app/dom";

const ico = (body: string) =>
  `<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">${body}</svg>`;
const SHAPE_ICON = {
  rect: ico('<rect x="3" y="5" width="14" height="10"/>'),
  circle: ico('<circle cx="10" cy="10" r="6.5"/>'),
  poly: ico('<path d="M10 3l7 5-2.7 8.5H5.7L3 8z"/>'),
  slot: ico('<rect x="2.5" y="6.5" width="15" height="7" rx="3.5"/>'),
};
const SEV_COLOR = { error: "var(--sev-error)", warning: "var(--sev-warning)", info: "var(--sev-info)" };

export function initTree() {
  onPanels(renderTree);
}

function renderTree() {
  const p = store.project;
  const tree = $("#tree");
  tree.innerHTML = "";
  for (const v of app.board.activePanes().map((x) => x.view)) {
    const list = slotShapes(p, v);
    const holesOnly = p.mode === "revolve" && (v === "top" || v === "side");
    const box = document.createElement("div");
    box.className = "tree-view";
    const head = document.createElement("div");
    head.className = "tv-head" + (ui.activeView === v ? " active" : "");
    const [ua, va] = slotAxes(v);
    head.innerHTML = `<span>▾</span>${esc(slotLabel(p, v))} <span class="muted">(${ua}–${va})</span><span class="cnt">${list.length}</span>`;
    head.onclick = () => {
      ui.activeView = v;
      ui.emit();
    };
    box.appendChild(head);
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "tree-empty";
      e.textContent = holesOnly ? "구멍만 그릴 수 있어요" : "비어 있음";
      box.appendChild(e);
    }
    for (const s of list) {
      const it = document.createElement("div");
      const sel = ui.sel?.view === v && ui.sel.id === s.id;
      it.className = "tree-item" + (s.hole ? " hole" : "") + (sel ? " sel" : "") + (s.construction ? " cons" : "");
      const sev = worstSeverity(v, s.id);
      it.innerHTML =
        `${SHAPE_ICON[s.kind]}<span class="name" title="${esc(shapeLabel(s))}">${esc(shapeLabel(s, true))}</span>` +
        (sev ? `<span class="dot" style="background:${SEV_COLOR[sev]}"></span>` : "") +
        `<span class="badge">${s.construction ? "참조선" : s.kind === "poly" && s.open ? "선" : s.hole ? "구멍" : "몸체"}</span>`;
      it.onclick = () => {
        ui.sel = { view: v, id: s.id };
        ui.activeView = v;
        ui.emit();
      };
      box.appendChild(it);
    }
    tree.appendChild(box);
  }
  const r = document.createElement("div");
  r.className = "tree-result";
  const b = app.lastBuild;
  if (b) {
    const [[x0, y0, z0], [x1, y1, z1]] = b.bbox;
    r.innerHTML =
      `<b>3D 결과</b><br/>크기 <span class="stat">${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)}</span> ${unitLabel()}<br/>` +
      `부피 <span class="stat">${fmtVol(b.volume)}</span> · 덩어리 ${b.solidCount}개<br/>` +
      b.notes.map((n) => `<span>${esc(n)}</span>`).join("<br/>");
  } else r.innerHTML = `<b>3D 결과</b><br/>${esc(app.buildError ?? "도형을 그리면 자동으로 만들어집니다.")}`;
  tree.appendChild(r);
}

function worstSeverity(view: SlotId, id: string) {
  let best: Finding["severity"] | null = null;
  const rank = { error: 0, warning: 1, info: 2 };
  for (const f of ui.findings)
    if (f.refs.some((r) => r.view === view && r.shapeId === id) && (!best || rank[f.severity] < rank[best])) best = f.severity;
  return best;
}
