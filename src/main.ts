import { getApiKey, requestReview, setApiKey, AI_MODEL } from "./ai";
import { runChecks } from "./core/checks";
import { boundsOf, mirrored, normRect, rotated, translated } from "./core/geometry2d";
import { SAMPLES } from "./core/samples";
import { HEAD_LABEL, PURPOSE_LABEL, specDiameter, THREADS, withTableHead } from "./core/standards";
import { isValidName, plainNumber, referencedNames } from "./core/expr";
import { evaluateParams, getDim, paramUsage, renameParam, setDimInput, toggleLock } from "./core/params";
import { buildSheet, sheetToDXF, type Sheet } from "./core/sheet";
import {
  emptyProject,
  VIEW_AXES,
  VIEW_IDS,
  VIEW_LABEL,
  type BuildResult,
  type Finding,
  type HoleSpec,
  type Process,
  type Project,
  type Shape2D,
  type ViewId,
} from "./core/types";
import { engine } from "./engine";
import { pickTextFile, safeName, saveFile } from "./files";
import { normalizeProject } from "./core/project";
import { ImportDialog } from "./ui/importDialog";
import { ReviewDialog } from "./ui/reviewDialog";
import { loadUnderlay, onUnderlayReady, putUnderlay } from "./underlay";
import { getFile, putFile } from "./fileStore";
import { fromBase64, listProjects, toBase64 } from "./library";
import { Session } from "./session";
import { initTabs } from "./tabs";
import { setupPWA } from "./pwa";
import { ProjectsDialog, VersionsDialog } from "./ui/libraryDialogs";
import { newId, setSaveErrorHandler, store } from "./store";
import { DraftBoard } from "./ui/board";
import { fmt, refreshColors, shapeLabel } from "./ui/sketch";
import { ui, type HoleSettings, type Tool } from "./ui/state";
import { Viewer3D } from "./ui/viewer";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------------- 화면 만들기 ----------------
// 2D 설계: 세 뷰를 한 장의 제도판에 / 3D 보기: 전체 화면 3D / 도면 출력: 자동 3면도
const board = new DraftBoard($<HTMLCanvasElement>("#board"));
const panes = board.panes;
for (const v of VIEW_IDS) panes[v].onPolyDraft = () => renderStatus();
const viewer = new Viewer3D($("#viewer3d"));
const dark = matchMedia("(prefers-color-scheme: dark)");
viewer.setDark(dark.matches);
dark.addEventListener("change", () => {
  viewer.setDark(dark.matches);
  refreshColors();
  requestRender();
});

let lastBuild: BuildResult | null = null;
let buildError: string | undefined;
let lastSheet: Sheet | null = null;
let ruleFindings: Finding[] = [];
let ai: { summary: string; findings: Finding[]; version: number; loading: boolean; error?: string } | null = null;

// ---------------- 화면 갱신 (프레임당 한 번) ----------------
let rafPending = false;
let panelKey = "";
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (workspace === "design") board.render();
    renderStatus();
    const key = `${workspace}|${store.version}|${ui.sel?.view}:${ui.sel?.id}|${ui.findings.length}:${ui.findings.map((f) => f.id).join(",")}|${ui.activeView}|${ai?.loading}|${ai?.version}|${buildStamp}`;
    if (key !== panelKey) {
      panelKey = key;
      renderTree();
      renderSourceBar();
      renderParams();
      renderProps();
      renderFindings();
      renderRibbon();
    }
  });
}
ui.subscribe(requestRender);
store.subscribe(() => {
  // 지워진 도형을 선택하고 있으면 해제
  if (ui.sel && !store.project.views[ui.sel.view].some((s) => s.id === ui.sel!.id)) ui.sel = null;
  scheduleBuild();
  updateFindings();
  requestRender();
});

// ---------------- 작업 공간: 2D 설계 / 3D 보기 / 도면 출력 ----------------
type Workspace = "design" | "3d" | "sheet";
let workspace: Workspace = "design";
function showWorkspace(ws: Workspace) {
  workspace = ws;
  $$(".ws-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.ws === ws));
  $("#ws-main").hidden = ws === "sheet";
  $("#ws-sheet").hidden = ws !== "sheet";
  $("#ribbon").hidden = ws !== "design";
  $("#stage-design").hidden = ws !== "design";
  $("#stage-3d").hidden = ws !== "3d";
  viewer.setActive(ws === "3d");
  for (const id of ["#toolHint", "#coords", "#snapGridBtn", "#snapAlignBtn", "#resultBtn"]) $(id).hidden = ws !== "design";
  if (ws === "sheet") renderSheet();
  for (const v of VIEW_IDS) panes[v].cancel();
  requestRender();
}
$$(".ws-tabs button").forEach((b) => (b.onclick = () => showWorkspace(b.dataset.ws as Workspace)));
$("#buildStatus").onclick = () => lastBuild && showWorkspace("3d");
$("#back2d").onclick = () => showWorkspace("design");

// 제도판: 전체 보기 / 한 뷰만 크게
$$<HTMLButtonElement>("[data-focus]").forEach(
  (b) =>
    (b.onclick = () => {
      const f = b.dataset.focus!;
      if (f === "all") board.fitAll();
      else board.focus(f as ViewId);
      $$("[data-focus]").forEach((x) => x.classList.toggle("on", x === b));
    }),
);
function fitAll() {
  board.fitAll();
  $$("[data-focus]").forEach((x) => x.classList.toggle("on", x.getAttribute("data-focus") === "all"));
}

// ---------------- 리본 ----------------
function setTool(t: Tool) {
  for (const v of VIEW_IDS) panes[v].cancel();
  ui.tool = t;
  ui.emit();
  panelKey = "";
}
$$<HTMLButtonElement>("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));

function selectedShape(): Shape2D | null {
  if (!ui.sel) return null;
  return store.project.views[ui.sel.view].find((s) => s.id === ui.sel!.id) ?? null;
}
function toggleHole() {
  const s = selectedShape();
  if (s) store.update(() => (s.hole = !s.hole));
}
function deleteSelected() {
  const sel = ui.sel;
  if (!sel) return;
  store.update((p) => (p.views[sel.view] = p.views[sel.view].filter((s) => s.id !== sel.id)));
  ui.sel = null;
  ui.emit();
}
function duplicateSelected() {
  const s = selectedShape();
  if (!s || !ui.sel) return;
  const view = ui.sel.view;
  const off = Math.max(ui.grid * 5, 5);
  addCopies(view, [translated(s, off, -off)]);
}

/** 복사본들을 한 번에 추가 (실행 취소 한 번으로 되돌릴 수 있게) */
function addCopies(view: ViewId, copies: Shape2D[]) {
  if (!copies.length) return;
  for (const c of copies) c.id = newId();
  store.update((p) => p.views[view].push(...copies));
  ui.sel = { view, id: copies[copies.length - 1].id };
  ui.emit();
}

/** 그 뷰 몸체 전체의 가운데 (대칭·원형 배열의 기본 기준) */
function partCenter(view: ViewId): [number, number] {
  const b = boundsOf(store.project.views[view]);
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
$("#holeBtn").onclick = toggleHole;
$("#delBtn").onclick = deleteSelected;
$("#dupBtn").onclick = duplicateSelected;
$("#undoBtn").onclick = () => store.undo();
$("#redoBtn").onclick = () => store.redo();
$("#fitBtn").onclick = () => fitAll();

const modeSel = $<HTMLSelectElement>("#mode");
const thick = $<HTMLInputElement>("#thickness");
const procSel = $<HTMLSelectElement>("#process");
const gridSel = $<HTMLSelectElement>("#grid");
const nameInput = $<HTMLInputElement>("#name");
modeSel.onchange = () => store.update((p) => (p.mode = modeSel.value as Project["mode"]));
procSel.onchange = () => store.update((p) => (p.process = procSel.value as Process));
thick.onchange = () => {
  const text = thick.value.trim();
  const n = plainNumber(text);
  if (n !== null) {
    if (n > 0) store.update((p) => ((p.thickness = n), (p.thicknessExpr = undefined)));
    else toast("두께는 0보다 커야 합니다.");
  } else if (text) {
    // 식: 모르는 변수가 없는지 먼저 확인
    const { values } = evaluateParams(store.project);
    const unknown = referencedNames(text).find((n) => !values.has(n));
    if (unknown) toast(`없는 변수: ${unknown}`);
    else store.update((p) => (p.thicknessExpr = text));
  }
  thick.value = store.project.thicknessExpr ?? fmt(store.project.thickness);
};
gridSel.value = String(ui.grid);
gridSel.onchange = () => {
  ui.grid = parseFloat(gridSel.value);
  ui.emit();
};
nameInput.onchange = () => store.update((p) => (p.name = nameInput.value.trim() || "새 부품"));
nameInput.onkeydown = (e) => e.key === "Enter" && nameInput.blur();

function renderRibbon() {
  const p = store.project;
  $$<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === ui.tool));
  const has = !!selectedShape();
  $<HTMLButtonElement>("#holeBtn").disabled = !has;
  $<HTMLButtonElement>("#delBtn").disabled = !has;
  $<HTMLButtonElement>("#dupBtn").disabled = !has;
  $<HTMLButtonElement>("#undoBtn").disabled = !store.canUndo;
  $<HTMLButtonElement>("#redoBtn").disabled = !store.canRedo;
  modeSel.value = p.mode;
  procSel.value = p.process ?? "cnc";
  if (document.activeElement !== thick) thick.value = p.thicknessExpr ?? fmt(p.thickness);
  thick.title = p.thicknessExpr ? `= ${fmt(p.thickness)} mm` : "숫자 또는 식 (예: t, L/8)";
  if (document.activeElement !== nameInput) nameInput.value = p.name;
  $("#thicknessWrap").hidden = p.mode !== "auto";
  $$<HTMLButtonElement>("[data-corner]").forEach((b) => b.classList.toggle("on", b.dataset.corner === ui.cornerKind));
  if (document.activeElement !== cornerSizeInput) cornerSizeInput.value = fmt(ui.cornerSize);
}

const cornerSizeInput = $<HTMLInputElement>("#cornerSize");
cornerSizeInput.onchange = () => {
  const v = parseFloat(cornerSizeInput.value);
  if (v > 0) ui.cornerSize = v;
  else cornerSizeInput.value = fmt(ui.cornerSize);
};
// Enter를 누르면 입력칸에서 빠져나와 바로 단축키(E 등)를 쓸 수 있게
cornerSizeInput.onkeydown = (e) => e.key === "Enter" && cornerSizeInput.blur();
thick.onkeydown = (e) => e.key === "Enter" && thick.blur();
$$<HTMLButtonElement>("[data-corner]").forEach(
  (b) =>
    (b.onclick = () => {
      ui.cornerKind = b.dataset.corner as "fillet" | "chamfer";
      panelKey = "";
      if (ui.tool !== "corner") setTool("corner");
      else ui.emit();
    }),
);

// ---------------- 상태 표시줄 ----------------
const snapGridBtn = $("#snapGridBtn");
const snapAlignBtn = $("#snapAlignBtn");
snapGridBtn.onclick = () => {
  ui.snapGrid = !ui.snapGrid;
  ui.emit();
};
snapAlignBtn.onclick = () => {
  ui.snapAlign = !ui.snapAlign;
  ui.emit();
};
const underlayBtn = $("#underlayBtn");
underlayBtn.onclick = () => store.update((p) => p.underlay && (p.underlay.show = p.underlay.show === false));
onUnderlayReady(() => requestRender());
const resultBtn = $("#resultBtn");
resultBtn.onclick = () => {
  ui.showResult = !ui.showResult;
  ui.emit();
};
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
function renderStatus() {
  const c = ui.cursor;
  const f = (n: number | null) => (n === null ? "—" : fmt(n).padStart(7));
  $("#coords").textContent = c ? `X ${f(c[0])}  Y ${f(c[1])}  Z ${f(c[2])} mm` : "X —  Y —  Z —";
  $("#toolHint").textContent = HINTS[ui.tool];
  snapGridBtn.classList.toggle("on", ui.snapGrid);
  snapAlignBtn.classList.toggle("on", ui.snapAlign);
  resultBtn.classList.toggle("on", ui.showResult);
  const u = store.project.underlay;
  underlayBtn.hidden = workspace !== "design" || !u;
  underlayBtn.classList.toggle("on", !!u && u.show !== false);
}

// ---------------- 모델 트리 ----------------
const ico = (body: string) =>
  `<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">${body}</svg>`;
const SHAPE_ICON = {
  rect: ico('<rect x="3" y="5" width="14" height="10"/>'),
  circle: ico('<circle cx="10" cy="10" r="6.5"/>'),
  poly: ico('<path d="M10 3l7 5-2.7 8.5H5.7L3 8z"/>'),
  slot: ico('<rect x="2.5" y="6.5" width="15" height="7" rx="3.5"/>'),
};
const SEV_COLOR = { error: "var(--sev-error)", warning: "var(--sev-warning)", info: "var(--sev-info)" };
function renderTree() {
  const p = store.project;
  const tree = $("#tree");
  tree.innerHTML = "";
  for (const v of VIEW_IDS) {
    const disabled = false;
    const holesOnly = p.mode === "revolve" && v !== "front";
    const box = document.createElement("div");
    box.className = "tree-view" + (disabled ? " disabled" : "");
    const head = document.createElement("div");
    head.className = "tv-head" + (ui.activeView === v ? " active" : "");
    const [ua, va] = VIEW_AXES[v];
    head.innerHTML = `<span>▾</span>${VIEW_LABEL[v]} <span class="muted">(${ua}–${va})</span><span class="cnt">${p.views[v].length}</span>`;
    head.onclick = () => {
      ui.activeView = v;
      ui.emit();
    };
    box.appendChild(head);
    if (!p.views[v].length) {
      const e = document.createElement("div");
      e.className = "tree-empty";
      e.textContent = holesOnly ? "구멍만 그릴 수 있어요" : "비어 있음";
      box.appendChild(e);
    }
    for (const s of p.views[v]) {
      const it = document.createElement("div");
      const sel = ui.sel?.view === v && ui.sel.id === s.id;
      it.className = "tree-item" + (s.hole ? " hole" : "") + (sel ? " sel" : "");
      const ic = SHAPE_ICON[s.kind];
      const sev = worstSeverity(v, s.id);
      it.innerHTML =
        `${ic}<span class="name" title="${esc(shapeLabel(s))}">${esc(shapeLabel(s, true))}</span>` +
        (sev ? `<span class="dot" style="background:${SEV_COLOR[sev]}"></span>` : "") +
        `<span class="badge">${s.hole ? "구멍" : "몸체"}</span>`;
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
  if (lastBuild) {
    const [[x0, y0, z0], [x1, y1, z1]] = lastBuild.bbox;
    r.innerHTML =
      `<b>3D 결과</b><br/>크기 <span class="stat">${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)}</span> mm<br/>` +
      `부피 <span class="stat">${fmt(lastBuild.volume / 1000)}</span> cm³ · 덩어리 ${lastBuild.solidCount}개<br/>` +
      lastBuild.notes.map((n) => `<span>${esc(n)}</span>`).join("<br/>");
  } else r.innerHTML = `<b>3D 결과</b><br/>${esc(buildError ?? "도형을 그리면 자동으로 만들어집니다.")}`;
  tree.appendChild(r);
}

function worstSeverity(view: ViewId, id: string) {
  let best: Finding["severity"] | null = null;
  const rank = { error: 0, warning: 1, info: 2 };
  for (const f of ui.findings)
    if (f.refs.some((r) => r.view === view && r.shapeId === id) && (!best || rank[f.severity] < rank[best])) best = f.severity;
  return best;
}

// ---------------- 변수 ----------------
function renderParams() {
  const box = $("#params");
  if (box.contains(document.activeElement)) return;
  box.innerHTML = "";
  const p = store.project;
  const { values, errors } = evaluateParams(p);
  const list = p.params ?? [];
  if (!list.length) {
    box.append(el("div", { innerHTML: "치수에 이름을 붙여 쓰면 한 번에 고칠 수 있어요.<br/>예: <code>L = 80</code> → 가로 칸에 <code>L</code>, 구멍 위치에 <code>L/2</code>" }, "params-empty"));
    return;
  }
  list.forEach((prm, i) => {
    const row = el("div", {}, "param-row" + (errors.has(prm.name) ? " err" : ""));
    const name = el("input", { value: prm.name, spellcheck: false, title: "변수 이름" }, "pname");
    name.onchange = () => {
      const to = name.value.trim();
      if (to === prm.name) return;
      if (!isValidName(to)) return toast("이름은 영문·한글로 시작하고 영문·한글·숫자·_만 쓸 수 있어요."), (name.value = prm.name);
      if (list.some((x) => x.name === to)) return toast("같은 이름의 변수가 이미 있어요."), (name.value = prm.name);
      const from = prm.name;
      store.update((pp) => renameParam(pp, from, to));
    };
    const expr = el("input", { value: prm.expr, spellcheck: false, title: "값 또는 식" }, "pexpr");
    expr.onchange = () => {
      const t = expr.value.trim();
      if (!t) return (expr.value = prm.expr);
      store.update((pp) => (pp.params![i].expr = t));
    };
    for (const inp of [name, expr]) inp.onkeydown = (e) => e.key === "Enter" && inp.blur();
    const val = el("span", {
      textContent: errors.has(prm.name) ? "⚠" : plainNumber(prm.expr) === null ? `= ${fmt(values.get(prm.name) ?? NaN)}` : "",
      title: errors.get(prm.name) ?? "",
    }, "pval");
    const del = el("button", { textContent: "×", title: "변수 지우기" }, "pdel");
    del.onclick = () => {
      const n = paramUsage(p, prm.name);
      if (n && !confirm(`${prm.name}을(를) ${n}곳에서 쓰고 있어요. 지우면 그 치수에 오류가 납니다. 지울까요?`)) return;
      store.update((pp) => pp.params!.splice(i, 1));
    };
    row.append(name, el("span", { textContent: "=" }, "peq"), expr, val, del);
    box.append(row);
  });
}
$("#addParam").onclick = () => {
  const used = new Set((store.project.params ?? []).map((x) => x.name));
  const name = ["L", "W", "H", "t", "d", "e"].find((n) => !used.has(n)) ?? `v${used.size + 1}`;
  store.update((p) => (p.params = [...(p.params ?? []), { name, expr: "10" }]));
  requestAnimationFrame(() => $<HTMLInputElement>("#params .param-row:last-child .pexpr")?.select());
};

// ---------------- 속성 ----------------
function numRow(label: string, value: number, onSet: (n: number) => void, min?: number) {
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = label;
  const i = document.createElement("input");
  i.type = "number";
  i.step = "any";
  i.value = fmt(value);
  i.onchange = () => {
    const n = parseFloat(i.value);
    if (!Number.isFinite(n) || (min !== undefined && n < min)) {
      i.value = fmt(value);
      return;
    }
    store.update(() => onSet(n));
  };
  i.onkeydown = (e) => e.key === "Enter" && i.blur();
  return [k, i];
}

/**
 * 식에 묶을 수 있는 치수 칸. 숫자를 넣으면 값, 식(예: L/2)을 넣으면 그 식에 묶인다.
 * 🔒: 지금 값으로 잠금 (끌어도 안 바뀜), fx: 식에 묶여 있음
 */
function exprRow(label: string, s: Shape2D, key: string): HTMLElement[] {
  const k = keyCell(label);
  const wrap = el("div", {}, "expr-field");
  const bound = s.exprs?.[key];
  const value = getDim(s, key);
  const isFormula = bound !== undefined && plainNumber(bound) === null;
  const input = el("input", {
    type: "text",
    value: bound ?? fmt(value),
    spellcheck: false,
    title: "숫자 또는 식 (예: L/2, L-8, t*2)",
  });
  if (bound !== undefined) input.classList.add("bound");
  input.onchange = () => {
    store.checkpoint();
    const err = setDimInput(s, key, input.value, store.project);
    if (err) store.dropCheckpoint();
    else store.changed();
    if (err) {
      toast(err);
      input.value = s.exprs?.[key] ?? fmt(getDim(s, key));
    }
  };
  input.onkeydown = (e) => e.key === "Enter" && input.blur();
  const lock = el("button", {
    textContent: bound !== undefined ? (isFormula ? "fx" : "🔒") : "🔓",
    title: bound !== undefined ? "잠금/식 해제 (값은 그대로)" : "지금 값으로 잠그기 (끌어도 안 바뀜)",
  }, "lock" + (bound !== undefined ? " on" : ""));
  lock.onclick = () => store.update(() => toggleLock(s, key));
  wrap.append(input, lock);
  if (isFormula) wrap.append(el("span", { textContent: `= ${fmt(value)}` }, "muted computed"));
  return [k, wrap];
}

function renderProps() {
  const box = $("#props");
  if (box.contains(document.activeElement) && document.activeElement !== box) return;
  box.innerHTML = "";
  const s = selectedShape();
  if (workspace === "3d") {
    const info = lastBuild
      ? (() => {
          const [[x0, y0, z0], [x1, y1, z1]] = lastBuild.bbox;
          return `<b>3D 모델</b><br/>크기 ${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} mm<br/>부피 ${fmt(lastBuild.volume / 1000)} cm³ · 덩어리 ${lastBuild.solidCount}개`;
        })()
      : `<b>3D 모델 없음</b><br/>${esc(buildError ?? "2D 설계에서 도형을 그리면 만들어집니다.")}`;
    box.innerHTML = `<div class="props-empty">${info}<br/><br/>마우스 왼쪽 끌기: 돌리기 · 오른쪽 끌기: 이동 · 휠: 확대<br/>수정은 <kbd>1</kbd> 2D 설계에서 합니다.</div>`;
    return;
  }
  if ((!s || !ui.sel) && ui.tool === "hole") {
    const title = document.createElement("div");
    title.className = "full";
    title.innerHTML = `<b>구멍 설정</b> <span class="muted">· 클릭하면 이 구멍이 놓여요</span>`;
    box.append(
      title,
      ...holeForm(ui.hole, ui.activeView, (next) => {
        ui.hole = next;
        panelKey = "";
        ui.emit();
      }),
    );
    return;
  }
  if (!s || !ui.sel) {
    box.innerHTML = `<div class="props-empty">도형을 선택하면 치수를 숫자로 고칠 수 있어요.<br/>단축키: <kbd>V</kbd> 선택 <kbd>R</kbd> 사각형 <kbd>C</kbd> 원 <kbd>L</kbd> 다각형 <kbd>S</kbd> 장공 <kbd>D</kbd> 구멍 <kbd>E</kbd> 모서리 <kbd>M</kbd> 측정 <kbd>H</kbd> 구멍 전환 <kbd>F</kbd> 전체 보기<br/>선택한 도형의 ◆ 손잡이를 끌면 변이 둥글게 휩니다.</div>`;
    return;
  }
  const [ua, va] = VIEW_AXES[ui.sel.view];
  const head = document.createElement("div");
  head.className = "full";
  head.innerHTML = `<b>${esc(shapeLabel(s))}</b> <span class="muted">· ${VIEW_LABEL[ui.sel.view]}</span>`;
  const seg = document.createElement("div");
  seg.className = "seg full";
  for (const [hole, label] of [
    [false, "몸체 (더하기)"],
    [true, "구멍 (빼기)"],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = s.hole === hole ? "on" : "";
    b.onclick = () => store.update(() => (s.hole = hole));
    seg.appendChild(b);
  }
  box.append(head, seg);
  const view = ui.sel.view;
  if (s.hole && s.kind === "circle") {
    // 원형 구멍: 규격·용도·머리 자리·깊이를 한 곳에서
    const state: HoleSettings = {
      spec: s.spec ?? { size: nearestSize(s.r * 2), purpose: "custom", head: "none", csAngle: 90, drillPoint: false },
      d: s.r * 2,
      depth: s.depth,
    };
    box.append(
      ...exprRow(`중심 ${ua}`, s, "cx"),
      ...exprRow(`중심 ${va}`, s, "cy"),
      ...holeForm(
        state,
        view,
        (next) => {
          store.update(() => {
            const plain = next.spec.purpose === "custom" && next.spec.head === "none" && !next.spec.drillPoint;
            s.spec = plain ? undefined : next.spec;
            s.r = (specDiameter(next.spec) ?? next.d) / 2;
            // 규격 지름을 쓰면 지름 식은 의미가 없으므로 해제
            if (specDiameter(next.spec) !== null && s.exprs?.d !== undefined) toggleLock(s, "d");
            if (next.depth === undefined && s.exprs?.depth !== undefined) toggleLock(s, "depth");
            s.depth = next.depth;
          });
        },
        s,
      ),
    );
    box.append(...alignControls(s, view), ...copyControls(s, view));
    return;
  }
  if (s.hole)
    box.append(
      ...depthRow(
        s.depth,
        view,
        (d) =>
          store.update(() => {
            if (d === undefined && s.exprs?.depth !== undefined) toggleLock(s, "depth");
            s.depth = d;
          }),
        s,
      ),
    );
  if (s.kind === "rect") {
    const r = normRect(s);
    void r;
    box.append(...exprRow(`${ua} (왼쪽)`, s, "x"), ...exprRow(`${va} (아래)`, s, "y"), ...exprRow("가로", s, "w"), ...exprRow("세로", s, "h"));
  } else if (s.kind === "slot") {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    box.append(
      ...exprRow(`중심1 ${ua}`, s, "ax"),
      ...exprRow(`중심1 ${va}`, s, "ay"),
      ...exprRow(`중심2 ${ua}`, s, "bx"),
      ...exprRow(`중심2 ${va}`, s, "by"),
      ...numRow("중심거리", len, (n) => {
        const dir = len > 1e-9 ? [(s.b[0] - s.a[0]) / len, (s.b[1] - s.a[1]) / len] : [1, 0];
        s.b = [s.a[0] + dir[0] * n, s.a[1] + dir[1] * n];
      }, 0),
      ...exprRow("폭", s, "w"),
    );
  } else if (s.kind === "circle") {
    box.append(...exprRow(`중심 ${ua}`, s, "cx"), ...exprRow(`중심 ${va}`, s, "cy"), ...exprRow("지름 Ø", s, "d"));
  } else {
    const k = document.createElement("span");
    k.className = "k full";
    k.textContent = `꼭짓점 (한 줄에 ${ua}, ${va})`;
    const ta = document.createElement("textarea");
    ta.className = "full";
    ta.value = s.pts.map(([x, y]) => `${fmt(x)}, ${fmt(y)}`).join("\n");
    ta.onchange = () => {
      const pts = ta.value
        .split(/[\n;]+/)
        .map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number))
        .filter((a) => a.length >= 2 && a.every(Number.isFinite))
        .map((a) => [a[0], a[1]] as [number, number]);
      if (pts.length < 3) return toast("꼭짓점이 3개 이상 필요합니다.");
      store.update(() => {
        // 점 개수가 바뀌면 변 휘기·모서리 정보는 어느 점 것인지 알 수 없어 지운다
        if (pts.length !== s.pts.length) {
          s.bulges = undefined;
          s.corners = undefined;
        }
        s.pts = pts;
      });
    };
    box.append(k, ta);
    if (s.bulges?.some((b) => b)) {
      const btn = document.createElement("button");
      btn.className = "small full";
      btn.textContent = "휜 변을 모두 직선으로";
      btn.onclick = () => store.update(() => (s.bulges = undefined));
      box.append(btn);
    }
  }
  if (s.kind === "poly") {
    const btn = el("button", { textContent: "거의 수평·수직인 변 바로잡기" }, "small full");
    btn.title = "5° 안쪽으로 기울어진 변을 정확히 수평·수직으로 맞춥니다";
    btn.onclick = () => {
      let changed = 0;
      store.update(() => (changed = straightenPoly(s)));
      toast(changed ? `변 ${changed}개를 바로잡았어요.` : "바로잡을 변이 없어요.");
    };
    box.append(btn);
  }
  if (s.kind === "rect" || s.kind === "poly") box.append(...cornerControls(s));
  box.append(...alignControls(s, ui.sel.view), ...copyControls(s, ui.sel.view));
}

/** 거의 수평·수직(5° 이내)인 변의 두 끝점을 평균 높이/위치로 맞춘다 */
function straightenPoly(s: Extract<Shape2D, { kind: "poly" }>): number {
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

/** 부품 가운데로 맞추기 (가로/세로) — 위치가 잠겨 있으면 하지 않음 */
function alignControls(s: Shape2D, view: ViewId): HTMLElement[] {
  const row = el("div", {}, "inline");
  const go = (axis: 0 | 1) => {
    // 이 도형을 뺀 몸체들의 범위 가운데 (몸체 자신을 맞출 땐 다른 몸체 기준)
    const others = store.project.views[view].filter((o) => o.id !== s.id);
    const b = boundsOf(others) ?? boundsOf(store.project.views[view]);
    if (!b) return toast("기준이 될 몸체가 없어요.");
    const target = axis === 0 ? (b[0] + b[2]) / 2 : (b[1] + b[3]) / 2;
    const sb = boundsOf([{ ...s, hole: false }])!;
    const cur = axis === 0 ? (sb[0] + sb[2]) / 2 : (sb[1] + sb[3]) / 2;
    const keys = s.kind === "rect" ? [axis === 0 ? "x" : "y"] : s.kind === "circle" ? [axis === 0 ? "cx" : "cy"] : s.kind === "slot" ? (axis === 0 ? ["ax", "bx"] : ["ay", "by"]) : [];
    if (keys.some((k) => s.exprs?.[k] !== undefined)) return toast("위치가 잠겨 있거나 식에 묶여 있어요. 🔒를 풀고 다시 하세요.");
    const d = target - cur;
    store.update((p) => {
      const list = p.views[view];
      const i = list.findIndex((o) => o.id === s.id);
      if (i >= 0) list[i] = translated(list[i], axis === 0 ? d : 0, axis === 1 ? d : 0);
    });
  };
  const b1 = el("button", { textContent: "↔ 가로 가운데" }, "small");
  b1.onclick = () => go(0);
  const b2 = el("button", { textContent: "↕ 세로 가운데" }, "small");
  b2.onclick = () => go(1);
  row.append(b1, b2);
  return [keyCell("가운데 맞춤"), row];
}

const DEPTH_FROM: Record<ViewId, string> = { front: "앞면부터", top: "윗면부터", side: "오른쪽 면부터" };

function nearestSize(d: number): string {
  let best = THREADS[0];
  for (const t of THREADS) if (Math.abs(t.nominal - d) < Math.abs(best.nominal - d)) best = t;
  return best.size;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (cls) e.className = cls;
  return e;
}

function keyCell(text: string) {
  return el("span", { textContent: text }, "k");
}

/** 깊이: [관통] 체크 또는 mm 값 */
function depthRow(depth: number | undefined, view: ViewId, onSet: (d: number | undefined) => void, shape?: Shape2D): HTMLElement[] {
  const row = el("div", {}, "inline");
  const through = el("input", { type: "checkbox", checked: depth === undefined });
  const lab = el("label", {}, "check");
  lab.append(through, "관통");
  const bound = shape?.exprs?.depth;
  const num = el("input", { type: "text", value: bound ?? (depth !== undefined ? fmt(depth) : ""), placeholder: "mm", spellcheck: false });
  num.style.width = "64px";
  if (bound !== undefined) num.classList.add("bound");
  num.disabled = depth === undefined;
  through.onchange = () => {
    if (through.checked) onSet(undefined);
    else {
      num.disabled = false;
      num.focus();
    }
  };
  num.onchange = () => {
    const n = plainNumber(num.value);
    if (shape && n === null) {
      // 식 (예: t - 2)
      store.checkpoint();
      const err = setDimInput(shape, "depth", num.value, store.project);
      if (err) {
        store.dropCheckpoint();
        toast(err);
      } else store.changed();
      return;
    }
    if (n !== null && n > 0) {
      if (shape?.exprs?.depth !== undefined) store.update((p) => setDimInput(shape, "depth", String(n), p));
      else onSet(n);
    }
  };
  num.onkeydown = (e) => e.key === "Enter" && num.blur();
  row.append(lab, num, el("span", { textContent: DEPTH_FROM[view] }, "muted"));
  if (bound !== undefined && plainNumber(bound) === null && depth !== undefined) row.append(el("span", { textContent: `= ${fmt(depth)}` }, "muted"));
  return [keyCell("깊이"), row];
}

/** 규격 구멍 설정 (구멍 도구 기본값과 선택한 원형 구멍이 같이 쓴다) */
function holeForm(state: HoleSettings, view: ViewId, apply: (next: HoleSettings) => void, shape?: Shape2D): HTMLElement[] {
  const spec = state.spec;
  const set = (patch: Partial<HoleSpec>, extra: Partial<HoleSettings> = {}) => apply({ ...state, ...extra, spec: { ...spec, ...patch } });
  const select = <T extends string>(options: [T, string][], value: T, onChange: (v: T) => void) => {
    const sel = el("select");
    for (const [v, label] of options) sel.append(el("option", { value: v, textContent: label, selected: v === value }));
    sel.onchange = () => onChange(sel.value as T);
    return sel;
  };
  const out: HTMLElement[] = [];
  out.push(
    keyCell("용도"),
    select(Object.entries(PURPOSE_LABEL) as [HoleSpec["purpose"], string][], spec.purpose, (purpose) =>
      apply({ ...state, spec: withTableHead({ ...spec, purpose }) }),
    ),
  );
  out.push(
    keyCell("나사 규격"),
    select(THREADS.map((t) => [t.size, t.size] as [string, string]), spec.size, (size) => apply({ ...state, spec: withTableHead({ ...spec, size }) })),
  );
  const d = specDiameter(spec);
  if (d === null) out.push(...(shape ? exprRow("지름 Ø", shape, "d") : numRow("지름 Ø", state.d, (n) => apply({ ...state, d: n }), 0.01)));
  else out.push(keyCell("지름 Ø"), el("span", { textContent: `${fmt(d)} mm (표준값)` }, "stat"));
  out.push(keyCell("머리 자리"), select(Object.entries(HEAD_LABEL) as [HoleSpec["head"], string][], spec.head, (head) => set({ head })));
  if (spec.head === "counterbore")
    out.push(
      ...numRow("자리 지름", spec.cbDiameter ?? 0, (n) => set({ cbDiameter: n }), 0.01),
      ...numRow("자리 깊이", spec.cbDepth ?? 0, (n) => set({ cbDepth: n }), 0.01),
    );
  if (spec.head === "countersink")
    out.push(
      ...numRow("바깥 지름", spec.csDiameter ?? 0, (n) => set({ csDiameter: n }), 0.01),
      ...numRow("각도 (°)", spec.csAngle ?? 90, (n) => set({ csAngle: n }), 1),
    );
  out.push(...depthRow(state.depth, view, (depth) => apply({ ...state, depth }), shape));
  if (state.depth !== undefined) {
    const cb = el("input", { type: "checkbox", checked: !!spec.drillPoint });
    cb.onchange = () => set({ drillPoint: cb.checked });
    const lab = el("label", {}, "check");
    lab.append(cb, "바닥을 드릴 끝 모양(118°)으로");
    out.push(keyCell("바닥"), lab);
  }
  return out;
}

/** 모서리 R/모따기를 모든 꼭짓점에 한 번에 */
function cornerControls(s: Extract<Shape2D, { kind: "rect" | "poly" }>): HTMLElement[] {
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = "모서리 전체";
  const row = document.createElement("div");
  row.className = "inline";
  const size = document.createElement("input");
  size.type = "number";
  size.step = "any";
  size.min = "0";
  size.value = fmt(ui.cornerSize);
  size.title = "크기 (mm)";
  const n = s.kind === "rect" ? 4 : s.pts.length;
  const apply = (kind: "fillet" | "chamfer" | null) => {
    const v = parseFloat(size.value);
    if (kind && !(v > 0)) return toast("크기를 0보다 크게 입력하세요.");
    if (kind) ui.cornerSize = v;
    store.update(() => (s.corners = kind ? new Array(n).fill({ kind, size: v }).map((c) => ({ ...c })) : undefined));
  };
  const mk = (label: string, kind: "fillet" | "chamfer" | null) => {
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = label;
    b.onclick = () => apply(kind);
    return b;
  };
  row.append(size, mk("R 둥글게", "fillet"), mk("C 모따기", "chamfer"), mk("없음", null));
  return [k, row];
}

/** 대칭 복사, 직선 배열, 원형 배열 */
function copyControls(s: Shape2D, view: ViewId): HTMLElement[] {
  const [ua, va] = VIEW_AXES[view];
  const [cu, cv] = partCenter(view);
  const num = (value: number, title: string, width = 56) => {
    const i = document.createElement("input");
    i.type = "number";
    i.step = "any";
    i.value = fmt(value);
    i.title = title;
    i.style.width = `${width}px`;
    return i;
  };
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  const val = (i: HTMLInputElement) => parseFloat(i.value);
  const label = (t: string) => {
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = t;
    return k;
  };
  const row = (...els: (HTMLElement | string)[]) => {
    const r = document.createElement("div");
    r.className = "inline";
    for (const e of els) r.append(typeof e === "string" ? Object.assign(document.createElement("span"), { textContent: e, className: "muted" }) : e);
    return r;
  };

  const title = document.createElement("div");
  title.className = "full section-title";
  title.textContent = "복사";

  // 대칭 복사: 기본 기준선은 부품 가운데
  const mu = num(cu, `세로 기준선 ${ua}`);
  const mv = num(cv, `가로 기준선 ${va}`);
  const mirrorRow = row(
    `${ua}=`, mu, btn("↔ 좌우", () => addCopies(view, [mirrored(s, "u", val(mu))])),
    `${va}=`, mv, btn("↕ 상하", () => addCopies(view, [mirrored(s, "v", val(mv))])),
  );

  // 직선 배열
  const ln = num(3, "개수 (원본 포함)", 44);
  const ldu = num(10, `${ua} 간격`);
  const ldv = num(0, `${va} 간격`);
  const linRow = row("개수", ln, `Δ${ua}`, ldu, `Δ${va}`, ldv, btn("만들기", () => {
    const n = Math.round(val(ln));
    if (!(n >= 2 && n <= 200)) return toast("개수는 2~200 사이로 입력하세요.");
    addCopies(view, Array.from({ length: n - 1 }, (_, i) => translated(s, val(ldu) * (i + 1), val(ldv) * (i + 1))));
  }));

  // 원형 배열: 기본 중심은 부품 가운데, 360°면 균등 분할
  const cn = num(6, "개수 (원본 포함)", 44);
  const ccu = num(cu, `중심 ${ua}`);
  const ccv = num(cv, `중심 ${va}`);
  const cang = num(360, "전체 각도 (°)", 52);
  const circRow = row("개수", cn, "중심", ccu, ccv, "각도", cang, btn("만들기", () => {
    const n = Math.round(val(cn));
    const total = val(cang);
    if (!(n >= 2 && n <= 360)) return toast("개수는 2~360 사이로 입력하세요.");
    const step = (Math.abs(total) >= 360 ? total / n : total / (n - 1)) * (Math.PI / 180);
    addCopies(view, Array.from({ length: n - 1 }, (_, i) => rotated(s, val(ccu), val(ccv), step * (i + 1))));
  }));

  return [title, label("대칭 복사"), mirrorRow, label("직선 배열"), linRow, label("원형 배열"), circRow];
}

// ---------------- 설계 검사 ----------------
function updateFindings() {
  ruleFindings = runChecks(store.project, lastBuild, buildError);
  const aiList = ai && !ai.loading ? ai.findings.filter((f) => refsStillValid(f)) : [];
  const order = { error: 0, warning: 1, info: 2 };
  ui.findings = [...ruleFindings, ...aiList].sort((a, b) => order[a.severity] - order[b.severity]);
}

function refsStillValid(f: Finding) {
  return f.refs.every((r) => !r.shapeId || store.project.views[r.view].some((s) => s.id === r.shapeId));
}

function renderFindings() {
  const list = $("#findings");
  list.innerHTML = "";
  const n = { error: 0, warning: 0, info: 0 };
  ui.findings.forEach((f) => n[f.severity]++);
  $("#checkCounts").innerHTML =
    `<span><i class="sev error">!</i>${n.error}</span><span><i class="sev warning">!</i>${n.warning}</span><span><i class="sev info">i</i>${n.info}</span>`;

  const sum = $("#aiSummary");
  if (ai) {
    sum.hidden = false;
    if (ai.loading)
      sum.innerHTML = `<div class="loading"><div class="spinner"></div>AI가 도면을 검토하고 있어요… (보통 20초~1분)</div>`;
    else if (ai.error) sum.innerHTML = `<b>AI 검토 실패</b><br/>${esc(ai.error)}`;
    else
      sum.innerHTML =
        `<b>✦ AI 총평</b> ${esc(ai.summary)}` +
        (ai.version !== store.version ? `<br/><span class="stale">도면이 바뀌었어요. 다시 검토하면 최신 결과를 볼 수 있습니다.</span>` : "");
  } else sum.hidden = true;

  if (!ui.findings.length) {
    list.innerHTML = `<div class="all-good">✓ 규칙 검사에서 문제가 없습니다.${ai ? "" : " 더 깊은 검토는 ‘AI 설계 검토’를 눌러 보세요."}</div>`;
    return;
  }
  for (const f of ui.findings) {
    const el = document.createElement("div");
    el.className = `finding ${f.severity}`;
    el.innerHTML =
      `<div class="f-head"><i class="sev ${f.severity}">${f.severity === "info" ? "i" : "!"}</i><span>${esc(f.title)}</span></div>` +
      `<div class="f-tags"><span class="tag ${f.source === "ai" ? "ai" : ""}">${f.source === "ai" ? "✦ AI" : "규칙"}</span><span class="tag">${esc(f.category)}</span></div>` +
      `<div class="f-detail">${esc(f.detail)}</div>` +
      (f.suggestion ? `<div class="f-fix"><b>고치는 법</b> · ${esc(f.suggestion)}</div>` : "");
    el.onmouseenter = () => {
      ui.hoverFindingId = f.id;
      ui.emit();
    };
    el.onmouseleave = () => {
      ui.hoverFindingId = null;
      ui.emit();
    };
    el.onclick = () => focusFinding(f);
    list.appendChild(el);
  }
}

function focusFinding(f: Finding) {
  const r = f.refs.find((x) => x.shapeId) ?? f.refs[0];
  if (!r) return;
  ui.activeView = r.view;
  if (r.shapeId) ui.sel = { view: r.view, id: r.shapeId };
  let u = r.u;
  let v = r.v;
  if ((u === undefined || v === undefined) && r.shapeId) {
    const s = store.project.views[r.view].find((x) => x.id === r.shapeId);
    if (s) {
      const b = boundsOf([{ ...s, hole: false }])!;
      u = (b[0] + b[2]) / 2;
      v = (b[1] + b[3]) / 2;
    }
  }
  if (u !== undefined && v !== undefined) ui.flash = { view: r.view, u, v, until: performance.now() + 1800 };
  ui.emit();
}

// ---------------- AI 설계 검토 ----------------
const settings = $<HTMLDialogElement>("#settings");
$("#aiModel").textContent = AI_MODEL;
function openSettings() {
  $<HTMLInputElement>("#apiKey").value = getApiKey();
  $<HTMLInputElement>("#showExp").checked = expOn();
  void showStorage();
  settings.showModal();
}
$("#settingsBtn").onclick = openSettings;
settings.addEventListener("close", () => {
  if (settings.returnValue === "ok") {
    setApiKey($<HTMLInputElement>("#apiKey").value.trim());
    toast(getApiKey() ? "API 키를 저장했습니다." : "API 키를 지웠습니다.");
  }
});

let aiAbort: AbortController | null = null;
$("#aiBtn").onclick = async () => {
  if (!getApiKey()) {
    toast("먼저 Anthropic API 키를 입력하세요.");
    openSettings();
    return;
  }
  if (ai?.loading) {
    aiAbort?.abort();
    return;
  }
  showWorkspace("design");
  aiAbort = new AbortController();
  const version = store.version;
  ai = { summary: "", findings: [], version, loading: true };
  $("#aiBtn").textContent = "■ 검토 중지";
  updateFindings();
  requestRender();
  try {
    await waitForBuild();
    const sheet = lastBuild ? buildSheet(lastBuild, store.project) : null;
    const [imageSheet, image3d] = await Promise.all([sheet ? svgToPng(sheet.svg) : null, Promise.resolve(viewer.capture())]);
    const res = await requestReview(
      {
        project: store.project,
        build: lastBuild,
        ruleFindings,
        imageSheet: imageSheet ?? undefined,
        image3d: image3d ?? undefined,
      },
      aiAbort.signal,
    );
    ai = { summary: res.summary, findings: res.findings, version, loading: false };
    toast(`AI 검토 완료: ${res.findings.length}건`);
  } catch (e: any) {
    ai = { summary: "", findings: [], version, loading: false, error: e?.message ?? String(e) };
  } finally {
    aiAbort = null;
    $("#aiBtn").textContent = "✦ AI 설계 검토";
    updateFindings();
    panelKey = "";
    requestRender();
  }
};

async function svgToPng(svg: string): Promise<string | null> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const w = 1400;
    const h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 1000;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/png").split(",")[1];
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------- 3D 자동 생성 ----------------
let buildTimer = 0;
let buildSeq = 0;
let building: Promise<void> | null = null;
let buildStamp = 0;
function scheduleBuild() {
  clearTimeout(buildTimer);
  setBuildStatus("3D 갱신 중…", "");
  buildTimer = window.setTimeout(() => (building = runBuild()), 250);
}
async function waitForBuild() {
  clearTimeout(buildTimer);
  building = runBuild();
  await building;
}

async function runBuild() {
  const seq = ++buildSeq;
  const source = store.project.source;
  const hasAny = !!source || VIEW_IDS.some((v) => store.project.views[v].some((s) => !s.hole));
  if (!hasAny) {
    lastBuild = null;
    buildError = undefined;
    ui.result = null;
    viewer.setMesh(null);
    setBuildStatus("도형을 그리면 3D가 자동으로 만들어져요", "");
    finishBuild();
    return;
  }
  try {
    const res = source
      ? await engine.buildImported(structuredClone(source), () => getFile(source.key))
      : await engine.build(structuredClone(store.project));
    if (seq !== buildSeq) return;
    lastBuild = res;
    buildError = undefined;
    viewer.setMesh(res.mesh);
    ui.result = Object.fromEntries(
      VIEW_IDS.map((v) => [
        v,
        {
          visible: res.projections[v].visible.map((d) => new Path2D(d)),
          hidden: res.projections[v].hidden.map((d) => new Path2D(d)),
          bounds: res.projections[v].bounds,
        },
      ]),
    ) as typeof ui.result;
    const [[x0, y0, z0], [x1, y1, z1]] = res.bbox;
    setBuildStatus(`✓ 3D ${fmt(x1 - x0)}×${fmt(y1 - y0)}×${fmt(z1 - z0)} mm`, "ok");
    $("#info3d").textContent = `${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} mm · 부피 ${fmt(res.volume / 1000)} cm³`;
  } catch (e: any) {
    if (seq !== buildSeq) return;
    lastBuild = null;
    buildError = e.message;
    setBuildStatus("⚠ 3D 생성 실패", "err");
  }
  finishBuild();
}

function finishBuild() {
  buildStamp++;
  if (lastBuild) scheduleThumb();
  const ov = $("#buildOverlay");
  ov.hidden = !buildError;
  ov.textContent = buildError ?? "";
  updateFindings();
  if (!$("#ws-sheet").hidden) renderSheet();
  requestRender();
}

function setBuildStatus(text: string, cls: string) {
  const el = $("#buildStatus");
  el.textContent = text;
  el.className = "build-status " + cls;
}

// ---------------- 도면 / 내보내기 ----------------
function renderSheet() {
  const host = $("#sheetHost");
  if (!lastBuild) {
    lastSheet = null;
    host.innerHTML = `<p class="empty">3D 모델이 만들어지면 정면도·평면도·우측면도가 자동으로 그려집니다.</p>`;
    return;
  }
  lastSheet = buildSheet(lastBuild, store.project);
  host.innerHTML = lastSheet.svg;
  $("#sheetInfo").textContent = `${lastSheet.paper} · ${lastSheet.scaleLabel}`;
  syncSheetForm();
}

// 도면 설정 (용지, 척도, 표제란): 프로젝트에 저장
const sheetFields = $$<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-sheet]");
function syncSheetForm() {
  const info = store.project.sheet ?? {};
  for (const f of sheetFields) {
    if (document.activeElement === f) continue;
    const key = f.dataset.sheet as keyof NonNullable<Project["sheet"]>;
    f.value = (info[key] as string | undefined) ?? (f.tagName === "SELECT" ? "auto" : "");
  }
}
for (const f of sheetFields)
  f.onchange = () => {
    const key = f.dataset.sheet as keyof NonNullable<Project["sheet"]>;
    const value = f.value.trim();
    store.update((p) => {
      const next = { ...(p.sheet ?? {}) } as Record<string, string | undefined>;
      if (!value || value === "auto") delete next[key];
      else next[key] = f.tagName === "TEXTAREA" ? f.value : value;
      p.sheet = Object.keys(next).length ? (next as Project["sheet"]) : undefined;
    });
    renderSheet();
  };
const base = () => safeName(store.project.name);
$("#expSvg").onclick = () => lastSheet && saveFile(`${base()}_도면.svg`, lastSheet.svg, "image/svg+xml", "svg");
$("#expDxf").onclick = () => lastSheet && saveFile(`${base()}_도면.dxf`, sheetToDXF(lastSheet), "application/dxf", "dxf");
$("#printBtn").onclick = () => {
  if (!lastSheet) return toast("먼저 3D 모델을 만들어 주세요.");
  // 용지 크기를 인쇄 설정에 알려 주면 브라우저가 그 용지로, 여백 없이, 실제 척도로 찍는다
  let st = document.getElementById("printPage") as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement("style");
    st.id = "printPage";
    document.head.appendChild(st);
  }
  st.textContent = `@page { size: ${lastSheet.width}mm ${lastSheet.height}mm; margin: 0; }`;
  window.print();
};
async function export3D(f: "stl" | "step") {
  if (!lastBuild) return toast("먼저 3D 모델을 만들어 주세요.");
  try {
    const data = await engine.export(f);
    await saveFile(`${base()}.${f}`, data, f === "stl" ? "model/stl" : "model/step", f);
  } catch (e: any) {
    toast(e.message);
  }
}
$("#expStl").onclick = () => export3D("stl");
$("#expStep").onclick = () => export3D("step");
$("#expStl3d").onclick = () => export3D("stl");
$("#expStep3d").onclick = () => export3D("step");

const camDirs: Record<string, [number, number, number]> = {
  iso: [1, -1.4, 0.9],
  front: [0, -1, 0.0001],
  top: [0, -0.0001, 1],
  side: [1, 0, 0.0001],
};
$$<HTMLButtonElement>("[data-cam]").forEach((b) => (b.onclick = () => viewer.resetView(camDirs[b.dataset.cam!])));

// ---------------- 파일 메뉴 ----------------
const fileMenu = $("#menu-file");
$('[data-menu="file"]').onclick = (e) => {
  e.stopPropagation();
  fileMenu.hidden = !fileMenu.hidden;
};
document.addEventListener("click", (e) => {
  if (!fileMenu.contains(e.target as Node)) fileMenu.hidden = true;
});
for (const s of SAMPLES) {
  const b = document.createElement("button");
  b.textContent = s.name;
  b.onclick = () => openNew(structuredClone(s));
  $("#samples").appendChild(b);
}
fileMenu.querySelector<HTMLButtonElement>('[data-act="new"]')!.onclick = () => openNew(emptyProject());
fileMenu.querySelector<HTMLButtonElement>('[data-act="open"]')!.onclick = openProject;
fileMenu.querySelector<HTMLButtonElement>('[data-act="save"]')!.onclick = saveProject;
fileMenu.querySelector<HTMLButtonElement>('[data-act="import3d"]')!.onclick = () => {
  fileMenu.hidden = true;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp,.stl,model/step,model/stl";
  input.onchange = () => input.files?.[0] && import3D(input.files[0]);
  input.click();
};

// ---------------- 3D 파일 가져오기 (STEP·STL) ----------------
const is3D = (f: File) => /\.(step|stp|stl)$/i.test(f.name);
async function import3D(file: File) {
  const kind = /\.stl$/i.test(file.name) ? "stl" : "step";
  const data = await file.arrayBuffer();
  const key = `m${Date.now().toString(36)}`;
  await putFile(key, data);
  const p = emptyProject();
  p.name = file.name.replace(/\.[^.]+$/, "") || "가져온 부품";
  p.source = { kind, name: file.name, key, turns: [0, 0, 0] };
  openNew(p);
  showWorkspace("3d");
  toast(`${file.name}을(를) 읽는 중… 방향이 다르면 위쪽 ‘X ↻ Y ↻ Z ↻’로 돌리세요. 도면은 ‘도면 출력’(3)에서.`);
}
function renderSourceBar() {
  const s = store.project.source;
  $("#sourceBar").hidden = !s;
  if (!s) return;
  $("#sourceName").textContent = s.name;
  $("#sourceHint").textContent = s.kind === "stl" ? "· STL(삼각형 메쉬)" : "· STEP";
}
$$<HTMLButtonElement>("[data-turn]").forEach(
  (b) =>
    (b.onclick = () =>
      store.update((p) => {
        if (!p.source) return;
        const t = [...p.source.turns] as [number, number, number];
        const i = Number(b.dataset.turn);
        t[i] = (t[i] + 1) % 4;
        p.source.turns = t;
      })),
);
$("#sourceClose").onclick = async () => {
  await session.snapshot("3D 파일 닫기 전");
  store.update((p) => delete p.source);
};

fileMenu.querySelector<HTMLButtonElement>('[data-act="import"]')!.onclick = () => {
  fileMenu.hidden = true;
  if (needExp()) importDlg.pickFile();
};

// ---------------- 도면 이미지 가져오기 ----------------
const reviewDlg = new ReviewDialog({
  onDraft: (p) => {
    openNew(p);
    showWorkspace("3d");
    toast("AI가 읽은 치수로 3D 초안을 새 프로젝트로 만들었어요. 틀린 곳은 2D 설계(1)에서 고치세요. 앞의 프로젝트는 ‘내 프로젝트’에 그대로 있어요.");
  },
  openSettings: () => openSettings(),
});
const importDlg = new ImportDialog(
  ({ project, underlay }) => {
    if (underlay) putUnderlay(underlay.meta.key, underlay.dataUrl);
    openNew(project);
    showWorkspace("design");
    const n = VIEW_IDS.filter((v) => project.views[v].length).length;
    toast(`도면을 새 프로젝트로 가져왔어요 (뷰 ${n}개). 3D 보기(2)로 확인하고, 다른 곳은 속성 패널에서 고치세요.`);
  },
  (file) => {
    importDlg.close();
    reviewDlg.open([file]);
  },
);
fileMenu.querySelector<HTMLButtonElement>('[data-act="review"]')!.onclick = () => {
  fileMenu.hidden = true;
  if (needExp()) reviewDlg.open();
};
const isImage = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif|pdf)$/i.test(f.name) || f.type === "application/pdf";
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const all = [...(e.dataTransfer?.files ?? [])];
  const f = all[0];
  if (!f) return;
  e.preventDefault();
  if (reviewDlg.isOpen || importDlg.isOpen || projectsDlg.isOpen || versionsDlg.isOpen) return;
  // 그림 여러 장 → 도면 검토
  if (all.length > 1 && all.every(isImage)) return void (needExp() && reviewDlg.open(all));
  if (isImage(f)) needExp() && importDlg.open(f);
  else if (is3D(f)) import3D(f);
  else if (/\.json$/i.test(f.name)) f.text().then(openProjectText);
  else toast("이미지(PNG·JPG)·PDF, 3D 파일(STEP·STL), 프로젝트 파일(.json)을 놓아 주세요.");
});
window.addEventListener("paste", (e) => {
  if (isTyping() || importDlg.isOpen || reviewDlg.isOpen || projectsDlg.isOpen || versionsDlg.isOpen) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (f) {
    e.preventDefault();
    if (needExp()) importDlg.open(new File([f], "붙여넣은 이미지.png", { type: f.type }));
  }
});

async function openProject() {
  fileMenu.hidden = true;
  const text = await pickTextFile(".json,application/json");
  if (text) openProjectText(text);
}
function openProjectText(text: string) {
  try {
    const raw = JSON.parse(text);
    // 프로젝트 파일에 함께 넣어 둔 밑그림 이미지
    const data = raw?.underlay?.data;
    if (raw?.underlay) delete raw.underlay.data;
    const model = raw?.source?.data;
    if (raw?.source) delete raw.source.data;
    const p = normalizeProject(raw);
    if (!p) throw new Error();
    if (p.underlay && typeof data === "string" && data.startsWith("data:image/")) putUnderlay(p.underlay.key, data);
    if (p.source && typeof model === "string") putFile(p.source.key, fromBase64(model)).then(() => openNew(p));
    else openNew(p);
  } catch {
    toast("프로젝트 파일을 읽을 수 없습니다.");
  }
}
async function saveProject() {
  fileMenu.hidden = true;
  // 밑그림 이미지와 가져온 3D 파일도 프로젝트 파일에 넣어 다른 컴퓨터에서도 열리게
  const p = store.project;
  const data = p.underlay ? await loadUnderlay(p.underlay.key) : null;
  let out: Record<string, unknown> = data && p.underlay ? { ...p, underlay: { ...p.underlay, data } } : { ...p };
  if (p.source) {
    const bytes = await getFile(p.source.key);
    if (bytes) out = { ...out, source: { ...p.source, data: toBase64(bytes) } };
  }
  saveFile(`${base()}.blueprint3d.json`, JSON.stringify(out, null, 2), "application/json", "json");
}
/** 새 프로젝트로 열기 — 지금 프로젝트는 ‘내 프로젝트’에 그대로 남는다 */
function openNew(p: Project) {
  fileMenu.hidden = true;
  commitTyping();
  session.openAsNew(p).catch(warnStorage);
}
async function openFromLibrary(id: string) {
  commitTyping();
  try {
    await session.open(id);
  } catch (e) {
    toast(errText(e) || "프로젝트를 열 수 없습니다.");
  }
}

// ---------------- 단축키 ----------------
/** 입력 중인 칸이 있으면 먼저 반영 (프로젝트를 바꾸기 전에) */
function commitTyping() {
  if (isTyping()) (document.activeElement as HTMLElement).blur();
}
function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}
window.addEventListener("keydown", (e) => {
  if (settings.open || importDlg.isOpen || reviewDlg.isOpen || projectsDlg.isOpen || versionsDlg.isOpen) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void projectsDlg.open();
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void versionsDlg.saveNow();
    return;
  }
  if (mod && e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    openNew(emptyProject());
    return;
  }
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject();
    return;
  }
  if (mod && e.key.toLowerCase() === "i") {
    e.preventDefault();
    if (needExp()) importDlg.pickFile();
    return;
  }
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openProject();
    return;
  }
  if (isTyping()) return;
  const pane = panes[ui.activeView];
  if (!mod && pane.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    store.redo();
    return;
  }
  if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === "1" || e.key === "2" || e.key === "3") {
    showWorkspace(e.key === "1" ? "design" : e.key === "2" ? "3d" : "sheet");
    e.preventDefault();
    return;
  }
  if (workspace !== "design" && e.key !== "Escape") return;
  switch (e.key.toLowerCase()) {
    case "v":
      setTool("select");
      break;
    case "r":
      setTool("rect");
      break;
    case "c":
      setTool("circle");
      break;
    case "l":
      setTool("poly");
      break;
    case "s":
      setTool("slot");
      break;
    case "d":
      setTool("hole");
      break;
    case "e":
      setTool("corner");
      break;
    case "m":
      setTool("measure");
      break;
    case "h":
      toggleHole();
      break;
    case "f":
      fitAll();
      break;
    case "g":
      ui.snapGrid = !ui.snapGrid;
      ui.emit();
      break;
    case "a":
      ui.snapAlign = !ui.snapAlign;
      ui.emit();
      break;
    case "delete":
    case "backspace":
      deleteSelected();
      break;
    case "escape":
      if (!pane.cancel()) {
        if (ui.tool !== "select") setTool("select");
        else if (ui.sel) {
          ui.sel = null;
          ui.emit();
        }
      }
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---------------- 공통 ----------------
let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2800);
}

// ---------------- 알림 (오래 남는 것: 새 버전, 다른 탭, 저장 문제) ----------------
type NoticeAction = { label: string; run: () => unknown };
function notice(text: string, actions: NoticeAction[] = [], kind: "info" | "warn" | "err" = "info", key?: string) {
  const host = $("#notices");
  if (key) closeNotice(key);
  const el = document.createElement("div");
  el.className = `notice ${kind}`;
  if (key) el.dataset.key = key;
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.onclick = () => {
      el.remove();
      void a.run();
    };
    el.append(b);
  }
  const x = document.createElement("button");
  x.className = "ghost";
  x.textContent = "✕";
  x.title = "닫기";
  x.onclick = () => el.remove();
  el.append(x);
  host.append(el);
}
function closeNotice(key: string) {
  $("#notices").querySelector(`[data-key="${key}"]`)?.remove();
}
const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "");
const isQuota = (e: unknown) => e instanceof DOMException && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");

// ---------------- 실험 기능 (도면 이미지 인식·AI) ----------------
const EXP_KEY = "blueprint3d.showExperimental";
function expOn() {
  try {
    return localStorage.getItem(EXP_KEY) !== "0";
  } catch {
    return true;
  }
}
const applyExp = () => document.body.classList.toggle("no-exp", !expOn());
/** 실험 기능을 쓰려 할 때: 꺼져 있으면 알려 주고 false */
function needExp() {
  if (expOn()) return true;
  toast("도면 이미지 인식과 AI는 실험 기능이에요. 설정(⚙)에서 ‘실험 기능 보이기’를 켜면 쓸 수 있어요.");
  return false;
}
const showExp = $<HTMLInputElement>("#showExp");
showExp.onchange = () => {
  try {
    localStorage.setItem(EXP_KEY, showExp.checked ? "1" : "0");
  } catch {
    /* 무시 */
  }
  applyExp();
};
applyExp();

// ---------------- 저장 공간 ----------------
const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
async function showStorage() {
  const info = $("#storageInfo");
  const btn = $<HTMLButtonElement>("#persistBtn");
  const st = navigator.storage;
  const n = (await listProjects().catch(() => [])).filter((p) => !p.deletedAt).length;
  if (!st?.estimate) {
    info.textContent = `프로젝트 ${n}개. 이 브라우저는 저장 공간 크기를 알려 주지 않아요.`;
    return;
  }
  const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([st.estimate(), st.persisted ? st.persisted() : Promise.resolve(false)]);
  info.textContent =
    `프로젝트 ${n}개 · 쓰는 중 ${mb(usage)} / 쓸 수 있는 공간 ${mb(quota)} (3D 엔진 등 앱 파일 포함). ` +
    (persisted ? "브라우저가 자동으로 지우지 않게 보호돼 있어요." : "공간이 모자라면 브라우저가 지울 수도 있어요 — 가끔 ‘내 프로젝트 → 전체 백업 내보내기’를 해 두세요.");
  btn.hidden = persisted || !st.persist;
}
$("#persistBtn").onclick = async () => {
  const ok = await navigator.storage.persist().catch(() => false);
  toast(ok ? "저장 공간을 보호하도록 했어요." : "브라우저가 요청을 받아 주지 않았어요. 앱으로 설치하면 보통 보호돼요.");
  void showStorage();
};

// ---------------- 내 프로젝트 · 버전 기록 · 자동 저장 ----------------
const saveStateBtn = $<HTMLButtonElement>("#saveState");
function setSaveState(st: "saving" | "saved" | "error") {
  saveStateBtn.classList.toggle("err", st === "error");
  saveStateBtn.textContent = st === "saving" ? "저장 중…" : st === "saved" ? "✓ 저장됨" : "⚠ 저장 실패";
}
let storageWarned = false;
function warnStorage(e: unknown) {
  console.error(e);
  if (storageWarned) return;
  storageWarned = true;
  notice(
    isQuota(e)
      ? "브라우저 저장 공간이 가득 찼어요. 휴지통을 비우거나, 전체 백업을 내보낸 뒤 안 쓰는 프로젝트를 지워 주세요."
      : `저장하다 문제가 생겼어요${errText(e) ? ` (${errText(e)})` : ""}. ‘파일로 저장’이나 전체 백업으로 작업을 지켜 두세요.`,
    [
      { label: "내 프로젝트", run: () => projectsDlg.open() },
      { label: "파일로 저장", run: () => saveProject() },
    ],
    "err",
    "storage",
  );
}
setSaveErrorHandler(warnStorage);

const tabs = initTabs({
  currentId: () => store.projectId,
  onDuplicate: () => notice("이 프로젝트가 다른 탭에서도 열려 있어요. 두 곳에서 고치면 나중에 저장한 쪽이 남아요.", [], "warn", "dup"),
  onRemoteSaved: () =>
    notice("다른 탭에서 이 프로젝트를 고쳤어요.", [{ label: "다시 불러오기", run: () => session.reload() }], "warn", "remote"),
});
const session = new Session({
  onSwitched: () => {
    ai = null;
    ui.sel = null;
    ui.activeView = VIEW_IDS.find((v) => store.project.views[v].length) ?? "front";
    closeNotice("remote");
    closeNotice("dup");
    tabs.announce();
    fitAll();
    requestRender();
  },
  onSaved: () => tabs.saved(),
  onState: setSaveState,
  onError: warnStorage,
});
setSaveState("saved");
tabs.announce();

// 3D가 새로 만들어지면 썸네일 (보관함 카드·버전 기록에 쓰임)
let thumbTimer = 0;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  const id = store.projectId;
  const stamp = buildStamp;
  thumbTimer = window.setTimeout(() => {
    if (!lastBuild || store.projectId !== id || buildStamp !== stamp || document.visibilityState !== "visible") return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "#fbfcfd";
    const url = viewer.snapshot(320, 240, "image/jpeg", 0.82, bg);
    if (url) session.setThumbnail(url);
  }, 1500);
}

const projectsDlg = new ProjectsDialog({
  currentId: () => store.projectId,
  open: openFromLibrary,
  newProject: () => openNew(emptyProject()),
  flush: () => session.flush(),
  toast,
  download: (name, text) => void saveFile(name, text, "application/json", "json"),
  pickText: () => pickTextFile(".json,application/json"),
  showVersions: (id) => void versionsDlg.open(id),
  renameCurrent: (name) => store.update((p) => (p.name = name)),
});
const versionsDlg = new VersionsDialog({
  currentId: () => store.projectId,
  current: () => store.project,
  restore: (p) => {
    ai = null;
    ui.sel = null;
    store.replace(p);
    fitAll();
  },
  openAsNew: openNew,
  open: openFromLibrary,
  flush: () => session.flush(),
  thumb: () => session.thumb,
  toast,
});
const act = (a: string) => fileMenu.querySelector<HTMLButtonElement>(`[data-act="${a}"]`)!;
act("projects").onclick = () => {
  fileMenu.hidden = true;
  void projectsDlg.open();
};
act("versions").onclick = () => {
  fileMenu.hidden = true;
  void versionsDlg.open();
};
act("snapshot").onclick = () => {
  fileMenu.hidden = true;
  void versionsDlg.saveNow();
};
saveStateBtn.onclick = () => void versionsDlg.open();

// ---------------- 앱으로 설치 · 오프라인 ----------------
let installApp: (() => Promise<boolean>) | null = null;
setupPWA({
  onUpdate: (apply) =>
    notice(
      "새 버전이 준비됐어요.",
      [
        {
          label: "지금 업데이트",
          run: async () => {
            await session.flush();
            apply();
          },
        },
      ],
      "info",
      "update",
    ),
  onOfflineReady: () => toast("이제 인터넷 없이도 쓸 수 있어요 (3D 엔진까지 이 컴퓨터에 저장됨)."),
  onInstallable: (install) => {
    installApp = install;
    $("#installItem").hidden = false;
  },
  onInstalled: () => {
    installApp = null;
    $("#installItem").hidden = true;
    toast("앱으로 설치했어요. 바탕화면이나 시작 메뉴에서 열 수 있어요.");
  },
});
act("install").onclick = async () => {
  fileMenu.hidden = true;
  if (installApp && (await installApp())) $("#installItem").hidden = true;
};
const netState = $("#netState");
const updateNet = () => (netState.hidden = navigator.onLine);
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);
updateNet();

// ---------------- 예상하지 못한 오류 ----------------
let lastCrash = 0;
function reportCrash(e: unknown) {
  const m = errText(e) || String(e ?? "");
  if (!m || /ResizeObserver loop|AbortError|aborted/i.test(m)) return;
  console.error(e);
  const now = Date.now();
  if (now - lastCrash < 8000) return;
  lastCrash = now;
  notice(
    `예상하지 못한 문제가 생겼어요: ${m.slice(0, 140)}. 작업은 자동 저장돼 있으니, 이상하면 새로 고침 하세요.`,
    [{ label: "새로 고침", run: () => session.flush().then(() => location.reload()) }],
    "err",
    "crash",
  );
}
window.addEventListener("error", (e) => reportCrash(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportCrash(e.reason));

// ---------------- 시작 ----------------
// 시작 프로젝트: 브라우저에 남은 작업 (처음이면 예제) — Session이 정함
ui.activeView = VIEW_IDS.find((v) => store.project.views[v].length) ?? "front";
updateFindings();
requestAnimationFrame(() => {
  fitAll();
  scheduleBuild();
});
// 처음 빌드가 끝나면 3D 크기까지 포함해 다시 맞춤
const firstFit = setInterval(() => {
  if (lastBuild || buildError) {
    clearInterval(firstFit);
    fitAll();
  }
}, 200);
