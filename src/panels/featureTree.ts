/**
 * 3D 설계의 왼쪽 패널 (13단계): 기본 평면 + 3면도 + 피처 목록.
 * 누르면 고르기, 두 번 누르면 고치기(스케치는 스케치 편집), 끄기·이름 바꾸기·지우기, 결과(오류) 표시.
 */
import { BASE_PLANE_LABEL, FEATURE_ICON, FEATURE_LABEL, hasViewBody, type BasePlane, type Feature } from "../core/featureModel";
import { store } from "../store";
import { app, onPanels } from "../app/context";
import { $, el, esc } from "../app/dom";
import { createSketch, deleteFeature, editFeature, fedit, moveFeature, renameFeature, setRollback, toggleSuppress } from "../app/featureEdit";
import { showWorkspace } from "../workspaces/registry";

const STATE_TITLE = { ok: "", warn: "주의", error: "오류", off: "꺼짐", rolled: "되감기 아래 (계산 안 함)" };

let renaming: string | null = null;

/** 끌어서 놓기: 피처 → 그 자리로 옮기기, 되감기 막대 → 그 자리까지 계산 */
const DRAG_FEAT = "application/x-b3d-feature";
const DRAG_BAR = "application/x-b3d-rollback";
let dragKind: "feat" | "bar" | null = null;

/** 놓는 자리: 이 줄의 위쪽 절반이면 이 줄 앞, 아래쪽이면 뒤 */
function dropIndex(e: DragEvent, rowEl: HTMLElement, index: number): number {
  const r = rowEl.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? index : index + 1;
}

function clearMarks() {
  for (const x of document.querySelectorAll(".feat-row.drop-before, .feat-row.drop-after")) x.classList.remove("drop-before", "drop-after");
}

function wireDrop(target: HTMLElement, index: number) {
  target.addEventListener("dragover", (e) => {
    if (!dragKind) return;
    e.preventDefault();
    clearMarks();
    target.classList.add(dropIndex(e, target, index) === index ? "drop-before" : "drop-after");
  });
  target.addEventListener("dragleave", () => target.classList.remove("drop-before", "drop-after"));
  target.addEventListener("drop", (e) => {
    e.preventDefault();
    clearMarks();
    const at = dropIndex(e, target, index);
    const id = e.dataTransfer?.getData(DRAG_FEAT);
    if (dragKind === "bar" || e.dataTransfer?.getData(DRAG_BAR)) setRollback(at);
    else if (id) moveFeature(id, at);
    dragKind = null;
  });
}

function rollbackBar(): HTMLElement {
  const bar = el("div", { innerHTML: "<span>◀ 여기까지 계산</span><button class='ghost tiny' title='끝까지 계산'>끝까지 ▼</button>", title: "끌어서 옮기면 그 위의 피처까지만 계산해요 (아래 피처는 잠시 꺼짐). 새 피처는 이 자리에 들어가요" }, "feat-rollback");
  bar.draggable = true;
  bar.addEventListener("dragstart", (e) => {
    dragKind = "bar";
    e.dataTransfer?.setData(DRAG_BAR, "1");
  });
  bar.addEventListener("dragend", () => ((dragKind = null), clearMarks()));
  (bar.querySelector("button") as HTMLButtonElement).onclick = () => setRollback(Infinity);
  return bar;
}

function row(f: Feature, index: number): HTMLElement {
  const st = app.featureLog.find((x) => x.id === f.id);
  const state = f.suppressed ? "off" : (st?.state ?? "ok");
  const r = el("div", {}, `feat-row ${state}` + (fedit.sel === f.id ? " sel" : "") + (fedit.id === f.id ? " editing" : ""));
  r.dataset.feat = f.id;
  r.title = [FEATURE_LABEL[f.kind], STATE_TITLE[state], st?.message].filter(Boolean).join(" · ");
  r.append(el("span", { textContent: FEATURE_ICON[f.kind] }, "fi"));
  if (renaming === f.id) {
    const inp = el("input", { type: "text", value: f.name }, "feat-rename");
    const done = () => {
      renaming = null;
      renameFeature(f.id, inp.value);
      render();
    };
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") inp.blur();
      if (e.key === "Escape") {
        inp.value = f.name;
        inp.blur();
      }
    };
    inp.onblur = done;
    r.append(inp);
    queueMicrotask(() => (inp.focus(), inp.select()));
  } else r.append(el("span", { textContent: f.name }, "fname"));
  if (state === "error" || state === "warn") r.append(el("span", { textContent: state === "error" ? "⚠" : "ⓘ" }, `fstate ${state}`));
  const acts = el("span", {}, "facts");
  const btn = (text: string, title: string, fn: () => void) => {
    const b = el("button", { textContent: text, title }, "ghost tiny");
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    acts.append(b);
  };
  btn(f.suppressed ? "◌" : "◉", f.suppressed ? "켜기" : "끄기 (계산에서 빼기)", () => toggleSuppress(f.id));
  btn("▲", "위로", () => moveFeature(f.id, index - 1));
  btn("▼", "아래로", () => moveFeature(f.id, index + 2));
  btn("⤓", "여기까지만 계산 (되감기)", () => setRollback(index + 1));
  btn("✎", "이름 바꾸기", () => {
    renaming = f.id;
    render();
  });
  btn("🗑", "지우기", () => deleteFeature(f.id));
  r.append(acts);
  r.onclick = () => {
    fedit.sel = f.id;
    render();
  };
  r.ondblclick = () => editFeature(f.id);
  r.draggable = renaming !== f.id;
  r.addEventListener("dragstart", (e) => {
    dragKind = "feat";
    e.dataTransfer?.setData(DRAG_FEAT, f.id);
  });
  r.addEventListener("dragend", () => ((dragKind = null), clearMarks()));
  wireDrop(r, index);
  return r;
}

function render() {
  const box = $("#featTree");
  if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
  const p = store.project;
  box.innerHTML = "";
  // 기본 평면: 누르면 그 평면에 새 스케치
  const planes = el("div", {}, "feat-planes");
  for (const b of ["XY", "XZ", "YZ"] as BasePlane[]) {
    const r = el("div", { textContent: `▱ ${BASE_PLANE_LABEL[b]}`, title: "누르면 이 평면에 새 스케치" }, "feat-row plane");
    r.dataset.plane = b;
    r.onclick = () => createSketch({ kind: "base", base: b, offset: 0 });
    planes.append(r);
  }
  box.append(planes);
  if (hasViewBody(p)) {
    const r = el("div", { innerHTML: `<span class="fi">▣</span><span class="fname">3면도 몸체</span>`, title: "2D 설계의 3면도로 만든 몸체 — 두 번 누르면 2D 설계로" }, "feat-row base");
    r.ondblclick = () => showWorkspace("design");
    box.append(r);
  }
  const feats = p.features ?? [];
  const bar = p.rollback ?? feats.length;
  feats.forEach((f, i) => {
    if (i === bar) box.append(rollbackBar());
    box.append(row(f, i));
  });
  if (feats.length && bar >= feats.length) {
    // 끝에 있는 막대: 위로 끌어 되감기
    const end = rollbackBar();
    end.classList.add("at-end");
    box.append(end);
  }
  if (!feats.length && !hasViewBody(p)) box.append(el("div", { innerHTML: "아직 피처가 없어요. 위의 평면을 누르거나 <b>✎ 스케치</b>로 시작하세요." }, "tree-empty"));
  $("#featCount").textContent = feats.length ? `${feats.length}` : "";
}

export function initFeatureTree() {
  onPanels(() => {
    if (app.workspace === "3d") render();
  });
}

export const renderFeatureTree = render;
