import { getApiKey, requestReview, setApiKey, AI_MODEL } from "./ai";
import { runChecks } from "./core/checks";
import { boundsOf, mirrored, normRect, rotated, translated } from "./core/geometry2d";
import { SAMPLES } from "./core/samples";
import { buildSheet, sheetToDXF, type Sheet } from "./core/sheet";
import {
  emptyProject,
  VIEW_AXES,
  VIEW_IDS,
  VIEW_LABEL,
  type BuildResult,
  type Finding,
  type Process,
  type Project,
  type Shape2D,
  type ViewId,
} from "./core/types";
import { engine } from "./engine";
import { pickTextFile, safeName, saveFile } from "./files";
import { newId, store } from "./store";
import { fmt, refreshColors, shapeLabel, SketchPane } from "./ui/sketch";
import { ui, type Tool } from "./ui/state";
import { Viewer3D } from "./ui/viewer";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------------- 창 만들기 ----------------
const panes = {} as Record<ViewId, SketchPane>;
for (const v of VIEW_IDS) {
  const vp = $(`.vp[data-vp="${v}"]`);
  panes[v] = new SketchPane(vp.querySelector("canvas")!, v);
  vp.querySelector(".vp-title")!.textContent = panes[v].title;
  panes[v].onPolyDraft = () => renderStatus();
}
const viewer = new Viewer3D($("#viewer3d"));
viewer.setActive(true);
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
    for (const v of VIEW_IDS) panes[v].render();
    $$(".vp").forEach((el) => el.classList.toggle("active", el.dataset.vp === ui.activeView));
    renderStatus();
    const key = `${store.version}|${ui.sel?.view}:${ui.sel?.id}|${ui.findings.length}:${ui.findings.map((f) => f.id).join(",")}|${ui.activeView}|${ai?.loading}|${ai?.version}|${buildStamp}`;
    if (key !== panelKey) {
      panelKey = key;
      renderTree();
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

// ---------------- 작업 공간 (모델링 / 도면) ----------------
function showWorkspace(ws: "model" | "sheet") {
  $$(".ws-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.ws === ws));
  $("#ws-model").hidden = ws !== "model";
  $("#ws-sheet").hidden = ws !== "sheet";
  $("#ribbon").hidden = ws !== "model";
  if (ws === "sheet") renderSheet();
  else requestRender();
}
$$(".ws-tabs button").forEach((b) => (b.onclick = () => showWorkspace(b.dataset.ws as "model" | "sheet")));

// 창 크게 보기
$$(".vp").forEach((vp) => {
  const toggle = () => {
    const vps = $("#viewports");
    const on = !vp.classList.contains("maxed");
    $$(".vp").forEach((x) => x.classList.remove("maxed"));
    vps.classList.toggle("max", on);
    if (on) vp.classList.add("maxed");
    requestRender();
  };
  vp.querySelector<HTMLButtonElement>(".vp-max")!.onclick = toggle;
  vp.querySelector<HTMLElement>(".vp-head")!.ondblclick = toggle;
});

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
  const t = parseFloat(thick.value);
  if (t > 0) store.update((p) => (p.thickness = t));
  else thick.value = String(store.project.thickness);
};
gridSel.value = String(ui.grid);
gridSel.onchange = () => {
  ui.grid = parseFloat(gridSel.value);
  ui.emit();
};
nameInput.onchange = () => store.update((p) => (p.name = nameInput.value.trim() || "새 부품"));

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
  if (document.activeElement !== thick) thick.value = String(p.thickness);
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
const HINTS: Record<Tool, string> = {
  select: "클릭: 선택 · 끌기: 이동 · 꼭짓점 끌기: 크기 · 빈 곳 끌기/휠 클릭/스페이스+끌기: 화면 이동 · 휠: 확대",
  rect: "끌거나 두 번 클릭해서 사각형 · 그리는 중 숫자 입력 → 정확한 치수 (예: 40,20) · Shift: 정사각형",
  circle: "중심에서 끌어서 원 · 그리는 중 숫자 입력 → 지름 · 몸체 안에 그리면 자동으로 구멍",
  poly: "클릭으로 점 추가 · 첫 점 클릭/더블클릭/Enter: 닫기 · Shift: 수평·수직·45° · 숫자 입력: 30<90 또는 Δx,Δy · Backspace: 점 취소",
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
    const disabled = p.mode === "revolve" && v !== "front";
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
      e.textContent = disabled ? "회전체 모드에서는 사용 안 함" : "비어 있음";
      box.appendChild(e);
    }
    for (const s of p.views[v]) {
      const it = document.createElement("div");
      const sel = ui.sel?.view === v && ui.sel.id === s.id;
      it.className = "tree-item" + (s.hole ? " hole" : "") + (sel ? " sel" : "");
      const ic = SHAPE_ICON[s.kind];
      const sev = worstSeverity(v, s.id);
      it.innerHTML =
        `${ic}<span>${esc(shapeLabel(s))}</span>` +
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

function renderProps() {
  const box = $("#props");
  if (box.contains(document.activeElement) && document.activeElement !== box) return;
  box.innerHTML = "";
  const s = selectedShape();
  if (!s || !ui.sel) {
    box.innerHTML = `<div class="props-empty">도형을 선택하면 치수를 숫자로 고칠 수 있어요.<br/>단축키: <kbd>V</kbd> 선택 <kbd>R</kbd> 사각형 <kbd>C</kbd> 원 <kbd>L</kbd> 다각형 <kbd>S</kbd> 장공 <kbd>E</kbd> 모서리 <kbd>M</kbd> 측정 <kbd>H</kbd> 구멍 전환 <kbd>F</kbd> 전체 보기<br/>선택한 도형의 ◆ 손잡이를 끌면 변이 둥글게 휩니다.</div>`;
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
  if (s.kind === "rect") {
    const r = normRect(s);
    box.append(
      ...numRow(`${ua} (왼쪽)`, r.x, (n) => (s.x = n)),
      ...numRow(`${va} (아래)`, r.y, (n) => (s.y = n)),
      ...numRow("가로", r.w, (n) => Object.assign(s, { x: r.x, w: n }), 0.01),
      ...numRow("세로", r.h, (n) => Object.assign(s, { y: r.y, h: n }), 0.01),
    );
  } else if (s.kind === "slot") {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    box.append(
      ...numRow(`중심1 ${ua}`, s.a[0], (n) => (s.a = [n, s.a[1]])),
      ...numRow(`중심1 ${va}`, s.a[1], (n) => (s.a = [s.a[0], n])),
      ...numRow(`중심2 ${ua}`, s.b[0], (n) => (s.b = [n, s.b[1]])),
      ...numRow(`중심2 ${va}`, s.b[1], (n) => (s.b = [s.b[0], n])),
      ...numRow("중심거리", len, (n) => {
        const dir = len > 1e-9 ? [(s.b[0] - s.a[0]) / len, (s.b[1] - s.a[1]) / len] : [1, 0];
        s.b = [s.a[0] + dir[0] * n, s.a[1] + dir[1] * n];
      }, 0),
      ...numRow("폭", s.w, (n) => (s.w = n), 0.01),
    );
  } else if (s.kind === "circle") {
    box.append(
      ...numRow(`중심 ${ua}`, s.cx, (n) => (s.cx = n)),
      ...numRow(`중심 ${va}`, s.cy, (n) => (s.cy = n)),
      ...numRow("지름 Ø", s.r * 2, (n) => (s.r = n / 2), 0.01),
    );
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
  if (s.kind === "rect" || s.kind === "poly") box.append(...cornerControls(s));
  box.append(...copyControls(s, ui.sel.view));
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
  showWorkspace("model");
  aiAbort = new AbortController();
  const version = store.version;
  ai = { summary: "", findings: [], version, loading: true };
  $("#aiBtn").textContent = "■ 검토 중지";
  updateFindings();
  requestRender();
  try {
    await waitForBuild();
    const sheet = lastBuild ? buildSheet(lastBuild, store.project.name) : null;
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
  const hasAny = VIEW_IDS.some((v) => store.project.views[v].some((s) => !s.hole));
  if (!hasAny) {
    lastBuild = null;
    buildError = undefined;
    viewer.setMesh(null);
    setBuildStatus("도형을 그리면 3D가 자동으로 만들어져요", "");
    finishBuild();
    return;
  }
  try {
    const res = await engine.build(structuredClone(store.project));
    if (seq !== buildSeq) return;
    lastBuild = res;
    buildError = undefined;
    viewer.setMesh(res.mesh);
    const [[x0, y0, z0], [x1, y1, z1]] = res.bbox;
    setBuildStatus(`✓ 3D ${fmt(x1 - x0)}×${fmt(y1 - y0)}×${fmt(z1 - z0)} mm`, "ok");
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
  lastSheet = buildSheet(lastBuild, store.project.name);
  host.innerHTML = lastSheet.svg;
}
const base = () => safeName(store.project.name);
$("#expSvg").onclick = () => lastSheet && saveFile(`${base()}_도면.svg`, lastSheet.svg, "image/svg+xml", "svg");
$("#expDxf").onclick = () => lastSheet && saveFile(`${base()}_도면.dxf`, sheetToDXF(lastSheet), "application/dxf", "dxf");
$("#printBtn").onclick = () => lastSheet && window.print();
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
  b.onclick = () => loadProject(structuredClone(s));
  $("#samples").appendChild(b);
}
fileMenu.querySelector<HTMLButtonElement>('[data-act="new"]')!.onclick = () => loadProject(emptyProject());
fileMenu.querySelector<HTMLButtonElement>('[data-act="open"]')!.onclick = openProject;
fileMenu.querySelector<HTMLButtonElement>('[data-act="save"]')!.onclick = saveProject;

async function openProject() {
  fileMenu.hidden = true;
  const text = await pickTextFile(".json,application/json");
  if (!text) return;
  try {
    const p = JSON.parse(text);
    if (p?.version !== 1 || !p.views) throw new Error();
    loadProject(p);
  } catch {
    toast("프로젝트 파일을 읽을 수 없습니다.");
  }
}
function saveProject() {
  fileMenu.hidden = true;
  saveFile(`${base()}.blueprint3d.json`, JSON.stringify(store.project, null, 2), "application/json", "json");
}
function loadProject(p: Project) {
  fileMenu.hidden = true;
  ai = null;
  ui.sel = null;
  store.replace(p);
  fitAll();
}

/** 세 뷰가 모두 화면에 들어오게 공유 카메라 맞춤 */
function fitAll() {
  const ranges: ([number, number] | null)[] = [null, null, null];
  const AX = { X: 0, Y: 1, Z: 2 } as const;
  const merge = (i: number, a: number, b: number) => {
    const r = ranges[i];
    ranges[i] = r ? [Math.min(r[0], a), Math.max(r[1], b)] : [a, b];
  };
  for (const v of VIEW_IDS) {
    const b = boundsOf(store.project.views[v]);
    if (!b) continue;
    const [u, w] = VIEW_AXES[v];
    merge(AX[u], b[0], b[2]);
    merge(AX[w], b[1], b[3]);
  }
  if (lastBuild) for (let i = 0; i < 3; i++) merge(i, lastBuild.bbox[0][i], lastBuild.bbox[1][i]);
  const r = ranges.map((x) => x ?? [0, 40]);
  let scale = Infinity;
  for (const v of VIEW_IDS) {
    const canvas = $(`.vp[data-vp="${v}"] canvas`);
    if (!canvas.clientWidth) continue;
    const [u, w] = VIEW_AXES[v];
    const du = Math.max(r[AX[u]][1] - r[AX[u]][0], 10);
    const dw = Math.max(r[AX[w]][1] - r[AX[w]][0], 10);
    scale = Math.min(scale, (canvas.clientWidth * 0.72) / du, (canvas.clientHeight * 0.72) / dw);
  }
  ui.camera.scale = Number.isFinite(scale) ? Math.min(Math.max(scale, 0.05), 400) : 4;
  ui.camera.c = [0, 1, 2].map((i) => (r[i][0] + r[i][1]) / 2) as [number, number, number];
  ui.emit();
}

// ---------------- 단축키 ----------------
function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}
window.addEventListener("keydown", (e) => {
  if (settings.open) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject();
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
  if (mod && e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    loadProject(emptyProject());
    return;
  }
  if (mod || e.altKey) return;
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

// ---------------- 시작 ----------------
if (!VIEW_IDS.some((v) => store.project.views[v].length)) store.project = structuredClone(SAMPLES[0]);
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
