/**
 * 작업 공간 ③ 도면 출력: 문서의 도면(여러 장)을 고르고, 도면마다 참조하는 부품을 3면도로 그린다.
 * 도면 설정(부품·용지·척도·표제란)은 도면에 저장. 편집 중이 아닌 부품의 도면도 그 부품을 따로 3D로 만들어 그린다.
 */
import { activeDrawing, addDrawing, drawingsOf, geometryKey, partOf, removeDrawing, type Drawing } from "../core/document";
import { buildSheet, sheetToDXF, type Sheet } from "../core/sheet";
import type { SheetInfo } from "../core/types";
import { safeName, saveFile } from "../files";
import { store } from "../store";
import { buildPart } from "../app/build";
import type { Command } from "../app/commands";
import { app, commands, on } from "../app/context";
import { $, $$, esc } from "../app/dom";
import { toast } from "../app/notify";
import type { Workspace } from "./registry";

/** 파일 이름 바탕: 문서 이름 (부품이 여럿이면 부품 이름도) */
export const baseName = () => safeName(store.doc.parts.length > 1 ? `${store.doc.name}_${store.project.name}` : store.doc.name);
const drawingBase = (d: Drawing) => safeName(store.doc.drawings.length > 1 ? `${store.doc.name}_${d.name}` : `${store.doc.name}_도면`);

let renderSeq = 0;
let shownKey = "";

/** 도면 하나의 시트 (부품 3D가 없으면 null) */
export async function sheetOf(d: Drawing): Promise<Sheet | null> {
  const part = partOf(store.doc, d.partId);
  if (!part) return null;
  const build = await buildPart(part);
  return build ? buildSheet(build, { ...part, sheet: d.sheet }) : null;
}

/** 지금 편집 중인 부품의 도면 설정 (AI 검토 등에서 쓰는 도면) */
export const activeSheetInfo = (): SheetInfo | undefined =>
  (activeDrawing(store.doc)?.partId === store.project.id ? activeDrawing(store.doc) : drawingsOf(store.doc, store.project.id)[0])?.sheet;

function keyNow() {
  const d = activeDrawing(store.doc);
  const part = d && partOf(store.doc, d.partId);
  return JSON.stringify([d, part?.name, part && geometryKey(part), part?.id === store.project.id ? app.buildStamp : 0]);
}

async function renderSheet(force = false) {
  const key = keyNow();
  if (!force && key === shownKey) return;
  shownKey = key;
  renderControls();
  const host = $("#sheetHost");
  const d = activeDrawing(store.doc);
  if (!d) {
    app.lastSheet = null;
    host.innerHTML = `<div class="empty"><p>이 문서에 도면이 없어요.</p><button class="primary" data-sheet-add>지금 부품의 도면 만들기</button></div>`;
    host.querySelector<HTMLButtonElement>("[data-sheet-add]")!.onclick = () => commands.run("doc.addDrawing");
    $("#sheetInfo").textContent = "";
    return;
  }
  const part = partOf(store.doc, d.partId)!;
  const seq = ++renderSeq;
  if (part.id !== store.project.id) host.innerHTML = `<p class="empty">‘${esc(part.name)}’ 부품의 3D를 만드는 중…</p>`;
  const sh = await sheetOf(d);
  if (seq !== renderSeq) return;
  app.lastSheet = sh;
  if (!sh) {
    host.innerHTML = `<p class="empty">‘${esc(part.name)}’ 부품의 3D 모델이 만들어지면 정면도·평면도·우측면도가 자동으로 그려집니다.</p>`;
    $("#sheetInfo").textContent = "";
    return;
  }
  host.innerHTML = sh.svg;
  $("#sheetInfo").textContent = `${sh.paper} · ${sh.scaleLabel}`;
}

/** 도면 고르기·부품 고르기·이름·설정 칸을 지금 도면에 맞춘다 */
function renderControls() {
  const doc = store.doc;
  const d = activeDrawing(doc);
  const sel = $<HTMLSelectElement>("#drawingSel");
  sel.innerHTML = doc.drawings.map((x) => `<option value="${x.id}">${esc(x.name)} — ${esc(partOf(doc, x.partId)?.name ?? "?")}</option>`).join("");
  sel.value = d?.id ?? "";
  sel.disabled = !doc.drawings.length;
  const partSel = $<HTMLSelectElement>("#drawingPart");
  partSel.innerHTML = doc.parts.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  partSel.value = d?.partId ?? "";
  const nameIn = $<HTMLInputElement>("#drawingName");
  if (document.activeElement !== nameIn) nameIn.value = d?.name ?? "";
  for (const el of [partSel, nameIn]) el.disabled = !d;
  $("#sheetForm").classList.toggle("off", !d);
  const info = d?.sheet ?? {};
  for (const f of sheetFields()) {
    if (document.activeElement === f) continue;
    const key = f.dataset.sheet as keyof SheetInfo;
    f.value = (info[key] as string | undefined) ?? (f.tagName === "SELECT" ? "auto" : "");
    f.disabled = !d;
  }
}

/** 지금 도면을 고치기 (실행 취소 가능) */
function editDrawing(fn: (d: Drawing) => void, label: string) {
  const id = store.doc.view.drawing;
  if (!id) return;
  store.updateDoc((doc) => {
    const d = doc.drawings.find((x) => x.id === id);
    if (d) fn(d);
  }, label);
}

/** 도면 화면을 안 거쳐도 저장할 수 있게 */
async function sheetNow(): Promise<{ d: Drawing; sh: Sheet } | null> {
  const d = activeDrawing(store.doc) ?? drawingsOf(store.doc, store.project.id)[0];
  const sh = d ? await sheetOf(d) : null;
  if (!d || !sh) {
    toast(d ? "먼저 3D 모델을 만들어 주세요." : "도면이 없어요. 도면 출력(3)에서 ‘도면 추가’를 누르세요.");
    return null;
  }
  return { d, sh };
}

const sheetFields = () => $$<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-sheet]");

async function printSheet() {
  const r = await sheetNow();
  if (!r) return;
  // 용지 크기를 인쇄 설정에 알려 주면 브라우저가 그 용지로, 여백 없이, 실제 척도로 찍는다
  let st = document.getElementById("printPage") as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement("style");
    st.id = "printPage";
    document.head.appendChild(st);
  }
  st.textContent = `@page { size: ${r.sh.width}mm ${r.sh.height}mm; margin: 0; }`;
  // 인쇄 화면은 도면만 보여 준다 (print CSS) — 지금 도면을 그려 둔다
  $("#sheetHost").innerHTML = r.sh.svg;
  window.print();
  if (app.workspace === "sheet") void renderSheet(true);
}

const any = () => true;
const cmds: Command[] = [
  {
    id: "sheet.svg",
    title: "도면을 SVG로 저장",
    category: "내보내기",
    keywords: ["svg", "drawing", "export"],
    when: any,
    run: async () => {
      const r = await sheetNow();
      if (r) await saveFile(`${drawingBase(r.d)}.svg`, r.sh.svg, "image/svg+xml", "svg");
    },
  },
  {
    id: "sheet.dxf",
    title: "도면을 DXF로 저장 (AutoCAD)",
    category: "내보내기",
    keywords: ["dxf", "autocad", "cad", "export", "캐드"],
    when: any,
    run: async () => {
      const r = await sheetNow();
      if (r) await saveFile(`${drawingBase(r.d)}.dxf`, sheetToDXF(r.sh), "application/dxf", "dxf");
    },
  },
  { id: "sheet.print", title: "도면 인쇄 / PDF", category: "내보내기", keywords: ["print", "pdf", "인쇄"], keys: ["Ctrl+P"], when: any, global: true, run: printSheet },
  {
    id: "doc.addDrawing",
    title: "도면 추가 (편집 중인 부품)",
    category: "문서",
    keywords: ["drawing", "sheet", "new drawing", "도면 만들기"],
    when: any,
    run: () => store.updateDoc((doc) => void addDrawing(doc, store.project.id, drawingsOf(doc, store.project.id)[0]?.sheet), "도면 추가"),
  },
  {
    id: "doc.deleteDrawing",
    title: "보고 있는 도면 지우기",
    category: "문서",
    keywords: ["delete drawing"],
    when: any,
    enabled: () => !!activeDrawing(store.doc),
    run: () => {
      const d = activeDrawing(store.doc);
      if (d) store.updateDoc((doc) => void removeDrawing(doc, d.id), `도면 지우기: ${d.name}`);
    },
  },
];

export const sheetWorkspace: Workspace = {
  id: "sheet",
  title: "도면 출력",
  icon: "▤",
  order: 30,
  hint: "문서의 도면 — 부품마다 3각법 3면도, 용지·척도·표제란, SVG·DXF·인쇄",
  show() {
    $("#ws-sheet").hidden = false;
    void renderSheet(true);
  },
  hide() {
    $("#ws-sheet").hidden = true;
  },
  commands: cmds,
};

export function initSheet() {
  $("#expSvg").dataset.cmd = "sheet.svg";
  $("#expDxf").dataset.cmd = "sheet.dxf";
  $("#printBtn").dataset.cmd = "sheet.print";
  $("#addDrawing").dataset.cmd = "doc.addDrawing";
  $("#delDrawing").dataset.cmd = "doc.deleteDrawing";
  on("built", () => {
    if (app.workspace === "sheet") void renderSheet();
  });
  // 도면 설정·부품 이름·다른 부품 모양이 바뀌면 다시 그림 (보고 있을 때만)
  store.subscribe(() => {
    if (app.workspace === "sheet") void renderSheet();
  });
  $<HTMLSelectElement>("#drawingSel").onchange = (e) => store.openDrawing((e.target as HTMLSelectElement).value);
  $<HTMLSelectElement>("#drawingPart").onchange = (e) => {
    const pid = (e.target as HTMLSelectElement).value;
    editDrawing((d) => (d.partId = pid), `도면 부품: ${partOf(store.doc, pid)?.name ?? ""}`);
  };
  const nameIn = $<HTMLInputElement>("#drawingName");
  nameIn.onchange = () => {
    const v = nameIn.value.trim();
    if (v) editDrawing((d) => (d.name = v), "도면 이름 바꾸기");
  };
  nameIn.onkeydown = (e) => e.key === "Enter" && nameIn.blur();
  for (const f of sheetFields())
    f.onchange = () => {
      const key = f.dataset.sheet as keyof SheetInfo;
      const value = f.value.trim();
      editDrawing((d) => {
        const next = { ...(d.sheet ?? {}) } as Record<string, string | undefined>;
        if (!value || value === "auto") delete next[key];
        else next[key] = f.tagName === "TEXTAREA" ? f.value : value;
        if (Object.keys(next).length) d.sheet = next as SheetInfo;
        else delete d.sheet;
      }, "도면 설정");
    };
}
