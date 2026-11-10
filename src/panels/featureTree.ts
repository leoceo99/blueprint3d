/**
 * 3D 설계의 왼쪽 패널 (13단계): 기본 평면 + 3면도 + 피처 목록.
 * 누르면 고르기, 두 번 누르면 고치기(스케치는 스케치 편집), 끄기·이름 바꾸기·지우기, 결과(오류) 표시.
 */
import { BASE_PLANE_LABEL, FEATURE_ICON, FEATURE_LABEL, hasViewBody, type BasePlane, type Feature } from "../core/featureModel";
import { store } from "../store";
import { app, onPanels } from "../app/context";
import { $, el, esc } from "../app/dom";
import { createSketch, deleteFeature, editFeature, fedit, renameFeature, toggleSuppress } from "../app/featureEdit";
import { showWorkspace } from "../workspaces/registry";

const STATE_TITLE = { ok: "", warn: "주의", error: "오류", off: "꺼짐", rolled: "되감기 아래 (계산 안 함)" };

let renaming: string | null = null;

function row(f: Feature): HTMLElement {
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
  for (const f of feats) box.append(row(f));
  if (!feats.length && !hasViewBody(p)) box.append(el("div", { innerHTML: "아직 피처가 없어요. 위의 평면을 누르거나 <b>✎ 스케치</b>로 시작하세요." }, "tree-empty"));
  $("#featCount").textContent = feats.length ? `${feats.length}` : "";
}

export function initFeatureTree() {
  onPanels(() => {
    if (app.workspace === "3d") render();
  });
}

export const renderFeatureTree = render;
