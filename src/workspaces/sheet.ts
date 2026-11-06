/** 작업 공간 ③ 도면 출력: 3D에서 자동으로 만든 3면도, 도면 설정(용지·척도·표제란), SVG·DXF·인쇄 */
import { buildSheet, sheetToDXF } from "../core/sheet";
import type { Project } from "../core/types";
import { safeName, saveFile } from "../files";
import { store } from "../store";
import type { Command } from "../app/commands";
import { app, on } from "../app/context";
import { $, $$ } from "../app/dom";
import { toast } from "../app/notify";
import type { Workspace } from "./registry";

export const baseName = () => safeName(store.project.name);

function renderSheet() {
  const host = $("#sheetHost");
  if (!app.lastBuild) {
    app.lastSheet = null;
    host.innerHTML = `<p class="empty">3D 모델이 만들어지면 정면도·평면도·우측면도가 자동으로 그려집니다.</p>`;
    return;
  }
  app.lastSheet = buildSheet(app.lastBuild, store.project);
  host.innerHTML = app.lastSheet.svg;
  $("#sheetInfo").textContent = `${app.lastSheet.paper} · ${app.lastSheet.scaleLabel}`;
  syncSheetForm();
}

/** 도면 화면을 안 거쳐도 저장할 수 있게 */
function sheetNow() {
  if (!app.lastBuild) {
    toast("먼저 3D 모델을 만들어 주세요.");
    return null;
  }
  if (!app.lastSheet || app.workspace !== "sheet") app.lastSheet = buildSheet(app.lastBuild, store.project);
  return app.lastSheet;
}

const sheetFields = () => $$<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-sheet]");
function syncSheetForm() {
  const info = store.project.sheet ?? {};
  for (const f of sheetFields()) {
    if (document.activeElement === f) continue;
    const key = f.dataset.sheet as keyof NonNullable<Project["sheet"]>;
    f.value = (info[key] as string | undefined) ?? (f.tagName === "SELECT" ? "auto" : "");
  }
}

function printSheet() {
  const sh = sheetNow();
  if (!sh) return;
  // 용지 크기를 인쇄 설정에 알려 주면 브라우저가 그 용지로, 여백 없이, 실제 척도로 찍는다
  let st = document.getElementById("printPage") as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement("style");
    st.id = "printPage";
    document.head.appendChild(st);
  }
  st.textContent = `@page { size: ${sh.width}mm ${sh.height}mm; margin: 0; }`;
  // 인쇄는 도면 화면이 보여야 한다
  if (app.workspace !== "sheet") {
    $("#ws-sheet").hidden = false;
    renderSheet();
    window.print();
    $("#ws-sheet").hidden = true;
  } else window.print();
}

const any = () => true;
const cmds: Command[] = [
  {
    id: "sheet.svg",
    title: "도면을 SVG로 저장",
    category: "내보내기",
    keywords: ["svg", "drawing", "export"],
    when: any,
    run: () => {
      const sh = sheetNow();
      if (sh) void saveFile(`${baseName()}_도면.svg`, sh.svg, "image/svg+xml", "svg");
    },
  },
  {
    id: "sheet.dxf",
    title: "도면을 DXF로 저장 (AutoCAD)",
    category: "내보내기",
    keywords: ["dxf", "autocad", "cad", "export", "캐드"],
    when: any,
    run: () => {
      const sh = sheetNow();
      if (sh) void saveFile(`${baseName()}_도면.dxf`, sheetToDXF(sh), "application/dxf", "dxf");
    },
  },
  { id: "sheet.print", title: "도면 인쇄 / PDF", category: "내보내기", keywords: ["print", "pdf", "인쇄"], keys: ["Ctrl+P"], when: any, global: true, run: printSheet },
];

export const sheetWorkspace: Workspace = {
  id: "sheet",
  title: "도면 출력",
  icon: "▤",
  order: 30,
  hint: "3D에서 자동으로 만든 3각법 3면도 — 용지·척도·표제란, SVG·DXF·인쇄",
  show() {
    $("#ws-sheet").hidden = false;
    renderSheet();
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
  on("built", () => {
    app.lastSheet = null;
    if (app.workspace === "sheet") renderSheet();
  });
  for (const f of sheetFields())
    f.onchange = () => {
      const key = f.dataset.sheet as keyof NonNullable<Project["sheet"]>;
      const value = f.value.trim();
      store.update((p) => {
        const next = { ...(p.sheet ?? {}) } as Record<string, string | undefined>;
        if (!value || value === "auto") delete next[key];
        else next[key] = f.tagName === "TEXTAREA" ? f.value : value;
        p.sheet = Object.keys(next).length ? (next as Project["sheet"]) : undefined;
      }, "도면 설정");
      renderSheet();
    };
}
