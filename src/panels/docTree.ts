/**
 * 왼쪽 위 ‘문서’: 문서 안의 부품·도면·장면 목록 (9단계).
 * 부품을 누르면 그 부품을 편집, 도면을 누르면 도면 출력에서 그 도면.
 */
import { addPart, drawingsOf, duplicatePart, removePart, renamePart, type Part } from "../core/document";
import { VIEW_IDS } from "../core/types";
import { store } from "../store";
import { ui } from "../ui/state";
import type { Command } from "../app/commands";
import { app, commands, onPanels } from "../app/context";
import { $, el, esc } from "../app/dom";
import { fitAll } from "../app/edit";
import { toast } from "../app/notify";
import { showWorkspace } from "../workspaces/registry";

const shapeCount = (p: Part) => VIEW_IDS.reduce((n, v) => n + p.views[v].length, 0);

/** 다른 부품 열기: 선택을 풀고 화면을 맞춘다 */
export function openPart(id: string) {
  if (id === store.doc.view.part) return;
  ui.sel = null;
  store.openPart(id);
  ui.activeView = VIEW_IDS.find((v) => store.project.views[v].length) ?? "front";
  requestAnimationFrame(() => fitAll());
}

function renamePartPrompt(id: string) {
  const p = store.doc.parts.find((x) => x.id === id);
  if (!p) return;
  const name = prompt("부품 이름", p.name)?.trim();
  if (!name || name === p.name) return;
  store.updateDoc((d) => {
    renamePart(d, id, name);
    if (d.parts.length === 1) d.name = name;
  }, `부품 이름: ${name}`);
}

function deletePart(id: string) {
  const d = store.doc;
  const p = d.parts.find((x) => x.id === id);
  if (!p) return;
  if (d.parts.length <= 1) return toast("문서에 부품이 하나는 있어야 해요. 문서를 지우려면 ‘내 프로젝트’에서.");
  const n = drawingsOf(d, id).length;
  if (shapeCount(p) && !confirm(`‘${p.name}’ 부품${n ? `과 그 도면 ${n}장` : ""}을 지울까요? (실행 취소로 되돌릴 수 있어요)`)) return;
  ui.sel = null;
  store.updateDoc((doc) => void removePart(doc, id), `부품 삭제: ${p.name}`);
}

export function initDocTree() {
  onPanels(render);
}

function render() {
  const doc = store.doc;
  const box = $("#docTree");
  box.innerHTML = "";
  $("#treePart").textContent = doc.parts.length > 1 ? `· ${store.project.name}` : "";
  const nameRow = el("div", {}, "doc-name");
  nameRow.append(el("span", { textContent: "▣" }, "di-ico"), el("span", { textContent: doc.name }, "di-name"));
  box.append(nameRow);

  // 부품
  const partHead = el("div", { textContent: `부품 ${doc.parts.length}` }, "doc-sec");
  const addBtn = el("button", { textContent: "＋ 부품", title: "이 문서에 빈 부품 추가" });
  addBtn.dataset.cmd = "doc.addPart";
  addBtn.onclick = () => commands.run("doc.addPart");
  partHead.append(addBtn);
  box.append(partHead);
  for (const p of doc.parts) {
    const on = p.id === doc.view.part;
    const row = el("div", { title: on ? "지금 편집 중" : "눌러서 이 부품 편집" }, "doc-item" + (on ? " on" : ""));
    row.dataset.part = p.id;
    const acts = el("span", {}, "di-acts");
    const act = (t: string, title: string, fn: () => void) => {
      const b = el("button", { textContent: t, title });
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      acts.append(b);
    };
    act("✎", "이름 바꾸기", () => renamePartPrompt(p.id));
    act("⧉", "복제", () => store.updateDoc((d) => void duplicatePart(d, p.id), `부품 복제: ${p.name}`));
    if (doc.parts.length > 1) act("✕", "지우기", () => deletePart(p.id));
    row.append(
      el("span", { textContent: p.source ? "◈" : "◧" }, "di-ico"),
      el("span", { innerHTML: `${esc(p.name)} <span class="di-meta">${p.source ? "3D 파일" : `도형 ${shapeCount(p)}`}</span>` }, "di-name"),
      acts,
    );
    row.onclick = () => openPart(p.id);
    row.ondblclick = () => renamePartPrompt(p.id);
    box.append(row);
  }

  // 도면
  const drawHead = el("div", { textContent: `도면 ${doc.drawings.length}` }, "doc-sec");
  const addD = el("button", { textContent: "＋ 도면", title: "편집 중인 부품의 도면 추가" });
  addD.onclick = () => {
    commands.run("doc.addDrawing");
    showWorkspace("sheet");
  };
  drawHead.append(addD);
  box.append(drawHead);
  if (!doc.drawings.length) box.append(el("div", { textContent: "도면 없음" }, "doc-empty"));
  for (const d of doc.drawings) {
    const on = d.id === doc.view.drawing && app.workspace === "sheet";
    const part = doc.parts.find((p) => p.id === d.partId);
    const row = el("div", { title: "눌러서 도면 출력에서 보기" }, "doc-item" + (on ? " on" : ""));
    row.append(el("span", { textContent: "▤" }, "di-ico"), el("span", { innerHTML: `${esc(d.name)} <span class="di-meta">${esc(part?.name ?? "")}</span>` }, "di-name"));
    row.onclick = () => {
      store.openDrawing(d.id);
      showWorkspace("sheet");
    };
    box.append(row);
  }

  // 장면 (15단계)
  const sceneHead = el("div", { textContent: "장면 (메쉬·게임용)" }, "doc-sec");
  box.append(sceneHead, el("div", { textContent: "15단계에서 — 게임용 모델을 담는 곳", title: "로드맵 15~18단계" }, "doc-empty"));
}

// ---------------- 명령 ----------------
const multi = () => store.doc.parts.length > 1;
function step(dir: 1 | -1) {
  const ps = store.doc.parts;
  const i = ps.findIndex((p) => p.id === store.doc.view.part);
  openPart(ps[(i + dir + ps.length) % ps.length].id);
}

export function docCommands(): Command[] {
  return [
    {
      id: "doc.addPart",
      title: "부품 추가 (이 문서에)",
      category: "문서",
      keywords: ["add part", "new part", "부품 만들기"],
      run: () => {
        ui.sel = null;
        // 이름은 순서대로 ("부품 2" …)
        store.updateDoc((d) => void addPart(d), "부품 추가");
        showWorkspace("design");
        requestAnimationFrame(() => fitAll());
      },
    },
    { id: "doc.duplicatePart", title: "편집 중인 부품 복제", category: "문서", keywords: ["duplicate part", "copy part"], run: () => store.updateDoc((d) => void duplicatePart(d, store.project.id), `부품 복제: ${store.project.name}`) },
    { id: "doc.renamePart", title: "편집 중인 부품 이름 바꾸기", category: "문서", keywords: ["rename part"], run: () => renamePartPrompt(store.project.id) },
    { id: "doc.deletePart", title: "편집 중인 부품 지우기", category: "문서", keywords: ["delete part", "remove part"], enabled: multi, run: () => deletePart(store.project.id) },
    { id: "doc.nextPart", title: "다음 부품", category: "문서", keywords: ["next part"], keys: ["Ctrl+Alt+]"], global: true, enabled: multi, run: () => step(1) },
    { id: "doc.prevPart", title: "이전 부품", category: "문서", keywords: ["previous part"], keys: ["Ctrl+Alt+["], global: true, enabled: multi, run: () => step(-1) },
  ];
}

/** 명령 찾기에서 부품 이름으로 바로 열기: "부품 열기: 덮개" */
let partCmdsOff: (() => void) | null = null;
let partCmdsKey = "";
export function syncPartCommands() {
  const key = store.doc.parts.map((p) => `${p.id}:${p.name}`).join("|");
  if (key === partCmdsKey) return;
  partCmdsKey = key;
  partCmdsOff?.();
  partCmdsOff = commands.register(
    store.doc.parts.length > 1
      ? store.doc.parts.map((p) => ({ id: `part.open.${p.id}`, title: `부품 열기: ${p.name}`, category: "문서", keywords: ["open part", p.name], checked: () => store.doc.view.part === p.id, run: () => openPart(p.id) }))
      : [],
  );
}
