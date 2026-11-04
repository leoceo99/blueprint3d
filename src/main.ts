import { buildSheet, sheetToDXF, type Sheet } from "./core/sheet";
import { SAMPLES } from "./core/samples";
import { emptyProject, VIEW_IDS, VIEW_LABEL, type BuildResult, type Shape2D, type ViewId } from "./core/types";
import { engine } from "./engine";
import { pickTextFile, safeName, saveFile } from "./files";
import { store } from "./store";
import { fmt, SketchEditor, type Tool } from "./ui/sketch";
import { Viewer3D } from "./ui/viewer";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

const editor = new SketchEditor($<HTMLCanvasElement>("#sketch"));
const viewer = new Viewer3D($("#viewer"));
let lastResult: BuildResult | null = null;
let lastSheet: Sheet | null = null;

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
viewer.setDark(darkQuery.matches);
darkQuery.addEventListener("change", () => viewer.setDark(darkQuery.matches));

// ---------------- 탭 ----------------
type Pane = "sketch" | "3d" | "sheet";
function showPane(p: Pane) {
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.pane === p));
  $$(".pane").forEach((el) => el.classList.toggle("active", el.id === `pane-${p}`));
  viewer.setActive(p === "3d");
  closeMenu();
}
$$(".tabbar button").forEach((b) => (b.onclick = () => showPane(b.dataset.pane as Pane)));

// ---------------- 뷰 선택 ----------------
const viewTabs = $("#viewTabs");
for (const v of VIEW_IDS) {
  const b = document.createElement("button");
  b.dataset.view = v;
  b.setAttribute("role", "tab");
  b.innerHTML = `${VIEW_LABEL[v]}<i class="dot" hidden></i>`;
  b.onclick = () => {
    editor.setView(v);
    syncUI();
  };
  viewTabs.appendChild(b);
}

// ---------------- 도구 ----------------
$$("#tools button").forEach(
  (b) =>
    (b.onclick = () => {
      editor.setTool(b.dataset.tool as Tool);
      syncUI();
    }),
);
$("#undo").onclick = () => store.undo();
$("#redo").onclick = () => store.redo();
$("#fit").onclick = () => editor.fit();
$("#polyDone").onclick = () => editor.finishPoly();
$("#polyCancel").onclick = () => editor.cancelPoly();
$("#polyUndo").onclick = () => editor.undoPolyPoint();
editor.onPolyDraft = (n) => {
  $("#polyBar").hidden = n === 0;
  $("#polyCount").textContent = `점 ${n}개`;
  $<HTMLButtonElement>("#polyDone").disabled = n < 3;
};

// ---------------- 설정 ----------------
const modeSel = $<HTMLSelectElement>("#mode");
const thick = $<HTMLInputElement>("#thickness");
const gridSel = $<HTMLSelectElement>("#grid");
const nameInput = $<HTMLInputElement>("#name");
modeSel.onchange = () => store.update((p) => (p.mode = modeSel.value as any));
thick.onchange = () => {
  const t = parseFloat(thick.value);
  if (t > 0) store.update((p) => (p.thickness = t));
  else thick.value = String(store.project.thickness);
};
gridSel.value = "5";
gridSel.onchange = () => {
  editor.grid = parseFloat(gridSel.value);
  editor.render();
};
nameInput.onchange = () => store.update((p) => (p.name = nameInput.value.trim() || "새 부품"));

// ---------------- 선택한 도형 속성 ----------------
const props = $("#props");
editor.onSelect = (s) => renderProps(s);

function numField(label: string, value: number, onSet: (n: number) => void, min?: number) {
  const l = document.createElement("label");
  l.textContent = label;
  const i = document.createElement("input");
  i.type = "number";
  i.inputMode = "decimal";
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
  l.appendChild(i);
  return l;
}

function renderProps(s: Shape2D | null) {
  // 입력 중에는 다시 그리지 않음 (포커스 유지)
  if (props.contains(document.activeElement) && document.activeElement?.tagName !== "BUTTON") return;
  props.hidden = !s;
  props.innerHTML = "";
  if (!s) return;
  const kind = document.createElement("div");
  kind.className = "toggle";
  for (const [hole, label] of [
    [false, "몸체"],
    [true, "구멍"],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = s.hole === hole ? "on" : "";
    b.onclick = () => store.update(() => (s.hole = hole));
    kind.appendChild(b);
  }
  props.appendChild(kind);
  if (s.kind === "rect") {
    props.append(
      numField("X", s.x, (n) => (s.x = n)),
      numField("Y", s.y, (n) => (s.y = n)),
      numField("가로", s.w, (n) => (s.w = n), 0.01),
      numField("세로", s.h, (n) => (s.h = n), 0.01),
    );
  } else if (s.kind === "circle") {
    props.append(
      numField("중심 X", s.cx, (n) => (s.cx = n)),
      numField("중심 Y", s.cy, (n) => (s.cy = n)),
      numField("지름 Ø", s.r * 2, (n) => (s.r = n / 2), 0.01),
    );
  } else {
    const l = document.createElement("label");
    l.className = "grow";
    l.style.flexDirection = "column";
    l.style.alignItems = "stretch";
    l.textContent = "꼭짓점 좌표 (한 줄에 x, y)";
    const ta = document.createElement("textarea");
    ta.value = s.pts.map(([x, y]) => `${fmt(x)}, ${fmt(y)}`).join("\n");
    ta.onchange = () => {
      const pts = ta.value
        .split(/[\n;]+/)
        .map((line) => line.split(/[,\s]+/).filter(Boolean).map(Number))
        .filter((a) => a.length >= 2 && a.every(Number.isFinite))
        .map((a) => [a[0], a[1]] as [number, number]);
      if (pts.length >= 3) store.update(() => (s.pts = pts));
      else toast("점이 3개 이상 필요합니다.");
    };
    l.appendChild(ta);
    props.appendChild(l);
  }
  const del = document.createElement("button");
  del.textContent = "삭제";
  del.className = "danger";
  del.onclick = () => editor.deleteSelected();
  props.appendChild(del);
}

// ---------------- 메뉴 ----------------
const menu = $("#menu");
function closeMenu() {
  menu.hidden = true;
}
$("#menuBtn").onclick = (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
};
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target as Node)) closeMenu();
});
const samplesEl = $("#samples");
for (const s of SAMPLES) {
  const b = document.createElement("button");
  b.textContent = s.name;
  b.onclick = () => loadProject(structuredClone(s));
  samplesEl.appendChild(b);
}
menu.querySelector<HTMLButtonElement>('[data-act="new"]')!.onclick = () => loadProject(emptyProject());
menu.querySelector<HTMLButtonElement>('[data-act="saveJson"]')!.onclick = () => {
  closeMenu();
  saveFile(`${safeName(store.project.name)}.blueprint3d.json`, JSON.stringify(store.project, null, 2), "application/json");
};
menu.querySelector<HTMLButtonElement>('[data-act="openJson"]')!.onclick = async () => {
  closeMenu();
  const text = await pickTextFile(".json,application/json");
  if (!text) return;
  try {
    const p = JSON.parse(text);
    if (p?.version !== 1 || !p.views) throw new Error();
    loadProject(p);
  } catch {
    toast("프로젝트 파일을 읽을 수 없습니다.");
  }
};

function loadProject(p: typeof store.project) {
  closeMenu();
  store.replace(p);
  const first = VIEW_IDS.find((v) => p.views[v].length) ?? "front";
  editor.setView(first);
  syncUI();
}

// ---------------- 3D 생성 (자동) ----------------
let buildTimer = 0;
let buildSeq = 0;
const chip = $("#buildChip");
const status = $("#status");

function scheduleBuild() {
  clearTimeout(buildTimer);
  chip.className = "chip";
  chip.textContent = "3D 갱신 중…";
  buildTimer = window.setTimeout(runBuild, 350);
}

async function runBuild() {
  const seq = ++buildSeq;
  const hasAny = VIEW_IDS.some((v) => store.project.views[v].some((s) => !s.hole));
  if (!hasAny) {
    lastResult = null;
    viewer.setMesh(null);
    chip.textContent = "도형을 그리면 3D가 자동으로 만들어져요";
    status.className = "status";
    status.textContent = "아직 3D 모델이 없습니다. ‘2D 그리기’에서 도형을 그려 보세요.";
    renderSheet();
    return;
  }
  try {
    const res = await engine.build(structuredClone(store.project));
    if (seq !== buildSeq) return;
    lastResult = res;
    viewer.setMesh(res.mesh);
    const [[x0, y0, z0], [x1, y1, z1]] = res.bbox;
    chip.className = "chip ok";
    chip.textContent = `✓ 3D ${fmt(x1 - x0)}×${fmt(y1 - y0)}×${fmt(z1 - z0)}`;
    status.className = "status";
    status.innerHTML =
      `<b>크기</b> ${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} mm · <b>부피</b> ${fmt(res.volume / 1000)} cm³` +
      `<ul>${res.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`;
    renderSheet();
  } catch (e: any) {
    if (seq !== buildSeq) return;
    chip.className = "chip err";
    chip.textContent = "⚠ 3D 생성 실패";
    status.className = "status err";
    status.textContent = e.message;
  }
}

function renderSheet() {
  const host = $("#sheetHost");
  if (!lastResult) {
    lastSheet = null;
    host.innerHTML = `<p class="empty">3D 모델이 만들어지면<br/>정면도·평면도·우측면도가 자동으로 그려집니다.</p>`;
    return;
  }
  lastSheet = buildSheet(lastResult, store.project.name);
  host.innerHTML = lastSheet.svg;
}

// ---------------- 카메라/내보내기 ----------------
const camDirs: Record<string, [number, number, number]> = {
  iso: [1, -1.4, 0.9],
  front: [0, -1, 0.0001],
  top: [0, -0.0001, 1],
  side: [1, 0, 0.0001],
};
$$(".cam-btns button").forEach((b) => (b.onclick = () => viewer.resetView(camDirs[b.dataset.cam!])));

async function export3D(fmtName: "stl" | "step") {
  if (!lastResult) return toast("먼저 3D 모델을 만들어 주세요.");
  try {
    const data = await engine.export(fmtName);
    await saveFile(`${safeName(store.project.name)}.${fmtName}`, data, fmtName === "stl" ? "model/stl" : "model/step");
  } catch (e: any) {
    toast(e.message);
  }
}
$("#expStl").onclick = () => export3D("stl");
$("#expStep").onclick = () => export3D("step");
$("#expSvg").onclick = () => {
  if (!lastSheet) return toast("먼저 3D 모델을 만들어 주세요.");
  saveFile(`${safeName(store.project.name)}_도면.svg`, lastSheet.svg, "image/svg+xml");
};
$("#expDxf").onclick = () => {
  if (!lastSheet) return toast("먼저 3D 모델을 만들어 주세요.");
  saveFile(`${safeName(store.project.name)}_도면.dxf`, sheetToDXF(lastSheet), "application/dxf");
};

// ---------------- 공통 ----------------
let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

const HINTS: Record<Tool, string> = {
  select: "도형을 눌러 선택·이동, 꼭짓점을 끌어 크기 조절. 빈 곳을 끌면 화면 이동, 두 손가락으로 확대.",
  rect: "끌어서 사각형을 그립니다. 몸체 안에 그리면 자동으로 ‘구멍’이 됩니다.",
  circle: "중심에서 끌어서 원을 그립니다. 몸체 안에 그리면 자동으로 ‘구멍’이 됩니다.",
  poly: "눌러서 꼭짓점을 찍고, 첫 점을 다시 누르거나 ‘닫기’로 완성합니다.",
};

function syncUI() {
  const p = store.project;
  if (document.activeElement !== nameInput) nameInput.value = p.name;
  modeSel.value = p.mode;
  thick.value = String(p.thickness);
  $("#thicknessWrap").hidden = p.mode !== "auto";
  $$<HTMLButtonElement>("#viewTabs button").forEach((b) => {
    const v = b.dataset.view as ViewId;
    b.classList.toggle("active", v === editor.view);
    const has = p.views[v].some((s) => !s.hole);
    (b.querySelector(".dot") as HTMLElement).hidden = !has;
    b.disabled = p.mode === "revolve" && v !== "front";
  });
  $$("#tools button").forEach((b) => b.classList.toggle("active", b.dataset.tool === editor.tool));
  $<HTMLButtonElement>("#undo").disabled = !store.canUndo;
  $<HTMLButtonElement>("#redo").disabled = !store.canRedo;
  $("#hint").textContent =
    p.mode === "revolve"
      ? "회전체: 정면도에서 회전축(세로선) 오른쪽에 단면 절반을 그리면 축을 중심으로 돌린 3D가 됩니다."
      : HINTS[editor.tool] +
        " 뷰를 1개만 그리면 두께만큼 돌출, 2~3개를 그리면 겹치는 부분으로 3D를 만듭니다.";
  renderProps(editor.selected());
}

store.subscribe(() => {
  if (store.project.mode === "revolve" && editor.view !== "front") editor.setView("front");
  syncUI();
  scheduleBuild();
});

// 시작
if (!VIEW_IDS.some((v) => store.project.views[v].length)) {
  // 처음 실행이면 예제를 보여 준다
  store.project = structuredClone(SAMPLES[0]);
}
editor.setView(VIEW_IDS.find((v) => store.project.views[v].length) ?? "front");
syncUI();
scheduleBuild();
