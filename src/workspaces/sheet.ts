/**
 * 작업 공간 ③ 도면 출력: 문서의 도면(여러 장)을 고르고, 도면마다 참조하는 부품을 3면도로 그린다.
 * 도면 설정(부품·용지·척도·표제란)은 도면에 저장. 편집 중이 아닌 부품의 도면도 그 부품을 따로 3D로 만들어 그린다.
 */
import { activeDrawing, addDrawing, drawingsOf, geometryKey, partOf, removeDrawing, type Drawing } from "../core/document";
import type { DimEdits, Sheet } from "../core/sheet";
import { sheetEdit, type DimKind, type DimTool, type EditorHost } from "./sheetState";
import { sizeSvg, wireZoom, zoomBy, zoomFit } from "./sheetZoom";
import type { SheetInfo, ViewId } from "../core/types";
import { safeName, saveFile } from "../files";
import { store } from "../store";
import { buildPart } from "../app/build";
import { engine } from "../engine";
import type { Command } from "../app/commands";
import { app, commands, on, requestRender } from "../app/context";
import { $, $$, esc } from "../app/dom";
import { closeNotice, notice, toast } from "../app/notify";
import { prefs } from "../app/prefs";
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
  if (!build) return null;
  // 도면 코드(자동 치수·치수 편집)는 도면을 처음 그릴 때 내려받는다
  const [{ buildSheet }, { viewRequest }] = await Promise.all([import("../core/sheet"), import("../core/sheetViews")]);
  // 추가 뷰(단면·보조·등각)는 워커가 3D에서 따로 비춘다 (14단계)
  const reqs = (d.views ?? []).map(viewRequest).filter((r): r is NonNullable<typeof r> => !!r);
  const data = reqs.length ? await viewData(part, reqs) : {};
  // 장 번호: 문서의 도면 차례 (14.6)
  const doc = store.doc;
  const sheetNo = { n: Math.max(0, doc.drawings.findIndex((x) => x.id === d.id)) + 1, of: Math.max(1, doc.drawings.length) };
  const bom = d.sheet?.bom === "on" ? await bomOf(doc, part.id, build.volume) : undefined;
  return buildSheet(build, { ...part, sheet: d.sheet }, d.edits ?? {}, { views: d.views, data, hide: d.hide, sheetNo, bom });
}

/** 부품표: 부품마다 부피가 필요 — 이 도면의 부품은 방금 만든 것, 나머지는 따로 만든다 (만들어 둔 것은 다시 씀) */
async function bomOf(doc: import("../core/document").Doc, partId: string, volume: number) {
  const { bomRows } = await import("../core/sheet");
  const vols = new Map<string, number>([[partId, volume]]);
  for (const p of doc.parts) {
    if (vols.has(p.id)) continue;
    const r = await buildPart(p).catch(() => null);
    if (r) vols.set(p.id, r.volume);
  }
  return bomRows(doc, (id) => vols.get(id));
}

/** 추가 뷰 계산 결과 기억 (같은 부품 모양·같은 뷰면 다시 계산하지 않음) */
const viewCache = new Map<string, Promise<Record<string, { view: import("../core/types").ProjectedView; hatch?: [number, number][][] }>>>();
function viewData(part: import("../core/document").Part, reqs: import("../core/sheetViews").ViewRequest[]) {
  const active = part.id === store.project.id && !!app.lastBuild;
  const key = JSON.stringify([part.id, geometryKey(part), active ? app.buildStamp : 0, reqs]);
  let hit = viewCache.get(key);
  if (!hit) {
    if (viewCache.size > 8) viewCache.clear();
    hit = engine.views(structuredClone(part), active, reqs);
    viewCache.set(key, hit);
  }
  return hit;
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
  // 다시 그려도 확대·스크롤 그대로. 크기는 읽지 않고 입히기만 (레이아웃 강제 계산 없음 — 14.8)
  const [sl, st] = [host.scrollLeft, host.scrollTop];
  host.innerHTML = sh.svg;
  $("#sheetInfo").textContent = `${sh.paper} · ${sh.scaleLabel}`;
  const svg = host.querySelector("svg");
  if (svg) {
    sizeSvg(host, svg);
    if (sl || st) {
      host.scrollLeft = sl;
      host.scrollTop = st;
    }
  }
  if (svg) (await import("./sheetEdit")).attachEditor(svg, sh, d.edits ?? {}, editorHost);
  renderCheck(sh, d);
  void renderProps();
}

/** 고른 치수·기호 칸 (14.4·14.5) */
async function renderProps() {
  if (app.workspace !== "sheet") return;
  const { renderDimProps } = await import("./sheetProps");
  renderDimProps($("#dimProps"), $("#dimPropsHead"), $("#dimPropsWrap"), app.lastSheet, activeDrawing(store.doc)?.edits ?? {}, {
    patch: (id, patch, label) =>
      editorHost.edit((e) => {
        const apply = (o: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(patch)) if (v === undefined) delete o[k];
          else o[k] = v;
        };
        const m = (e.dims ?? []).find((x) => x.id === id);
        if (m) return apply(m as unknown as Record<string, unknown>);
        const mv = { ...(e.moved?.[id] ?? {}) } as Record<string, unknown>;
        apply(mv);
        e.moved = { ...(e.moved ?? {}) };
        if (Object.keys(mv).length) e.moved[id] = mv;
        else delete e.moved[id];
      }, label),
  });
}

/** 치수 편집기가 도면을 고칠 때 */
const editorHost: EditorHost = {
  edit: (fn, label) =>
    editDrawing((d) => {
      const e: DimEdits = structuredClone(d.edits ?? {});
      fn(e);
      if (!e.dims?.length) delete e.dims;
      if (!e.hide?.length) delete e.hide;
      if (!e.moved || !Object.keys(e.moved).length) delete e.moved;
      if (Object.keys(e).length) d.edits = e;
      else delete d.edits;
    }, label),
  toast,
  changed: () => {
    syncTools();
    requestRender();
  },
  views: () => activeDrawing(store.doc)?.views ?? [],
  editViews: (fn, label) =>
    editDrawing((d) => {
      const next = fn(structuredClone(d.views ?? []));
      if (next.length) d.views = next;
      else delete d.views;
    }, label),
};

/** 치수 검사: 빠진 치수, 숨긴 자동 치수 */
function renderCheck(sh: Sheet | null, d: Drawing | null) {
  const box = $("#dimCheck");
  if (!sh || !d) {
    box.innerHTML = "";
    return;
  }
  const hidden = d.edits?.hide?.length ?? 0;
  const moved = Object.keys(d.edits?.moved ?? {}).length;
  const manual = d.edits?.dims?.length ?? 0;
  const head = sh.missing.length
    ? `<div class="dim-check-head bad">⚠ 빠진 치수 ${sh.missing.length}개</div><ul>${sh.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`
    : `<div class="dim-check-head ok">✓ 모든 형상에 크기·위치 치수가 있어요</div>`;
  const stats = `<div class="muted small">자동 치수 ${sh.dims.length - manual}개${manual ? ` · 직접 놓은 치수 ${manual}개` : ""}${hidden ? ` · 숨긴 것 ${hidden}개` : ""}${moved ? ` · 옮긴 것 ${moved}개` : ""}</div>`;
  box.innerHTML = head + stats + (hidden || moved ? `<button class="small" id="dimRestore">자동 치수 처음대로</button>` : "");
  box.querySelector<HTMLButtonElement>("#dimRestore")?.addEventListener("click", () => commands.run("sheet.dimRestore"));
}

function syncTools() {
  $<HTMLSelectElement>("#dimKind").value = sheetEdit.kind;
  void renderProps();
  $("#sheetHost").classList.toggle("tool-dim", sheetEdit.tool !== "select");
  app.sheetHint =
    sheetEdit.tool === "section" || sheetEdit.tool === "aux"
      ? `${sheetEdit.tool === "section" ? "절단선" : "경사 모서리"}의 두 점을 누르세요 (점에 붙음, Shift·5° 안쪽은 수평·수직) · Esc 취소`
      : sheetEdit.tool === "detail"
        ? "자세히 볼 곳의 가운데를 누르고, 원 크기만큼 떨어진 곳을 누르세요 · Esc 취소"
        : sheetEdit.tool === "rough" || sheetEdit.tool === "gdt" || sheetEdit.tool === "datum"
          ? `${{ rough: "표면 거칠기를 붙일 면", gdt: "기하공차를 줄 면·구멍", datum: "기준(데이텀)이 될 면" }[sheetEdit.tool]}의 선을 누르고, 기호 자리를 누르세요 · 값은 오른쪽 칸 · Esc 끝`
        : sheetEdit.tool === "dim"
      ? sheetEdit.kind === "angle"
        ? "선 두 개를 누르고, 각도 글자 자리를 누르세요 · Esc 취소"
        : "점 두 개(선 끝·원 중심) 또는 원·원호를 누르고, 치수선 자리를 누르세요 · Esc 취소"
      : "치수를 눌러 고르고 끌어서 옮기기 · 공차는 오른쪽 ‘고른 치수’ 칸 · 두 번 누르면 글자 · Delete 지우기";
}

function setTool(t: DimTool) {
  sheetEdit.tool = t;
  if (t !== "select") {
    sheetEdit.selected = null;
    sheetEdit.selectedView = null;
  }
  void renderSheet(true);
  syncTools();
  requestRender();
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
  // 기본 뷰 보이기 · 추가 뷰 목록 (14단계)
  for (const cb of $$<HTMLInputElement>("#viewStd input[data-std]")) {
    cb.checked = !(d?.hide ?? []).includes(cb.dataset.std as ViewId);
    cb.disabled = !d;
  }
  renderViewList(d);
  // 상세 양식일 때만 회사·개정·검도·승인 칸
  $(".tb-full").hidden = info.template !== "full";
  for (const f of sheetFields()) {
    if (document.activeElement === f) continue;
    const key = f.dataset.sheet as keyof SheetInfo;
    f.value = (info[key] as string | undefined) ?? (f.tagName === "SELECT" ? "auto" : "");
    f.disabled = !d;
  }
}

const KIND_NAME: Record<string, string> = { section: "단면", aux: "보조", detail: "상세", iso: "등각" };
const DETAIL_K = [2, 2.5, 4, 5, 10];

/** 추가 뷰 목록: 이름, 상세 배율, 단면 방향 뒤집기, 지우기 */
function renderViewList(d: Drawing | null | undefined) {
  const box = $("#viewList");
  const list = d?.views ?? [];
  if (!list.length) {
    box.innerHTML = `<p class="muted small">단면·상세·보조·등각은 위 도구 줄에서 (S · C · B · I)</p>`;
    return;
  }
  box.innerHTML = list
    .map((v) => {
      const title = v.kind === "section" ? `단면 ${v.label}-${v.label}` : v.kind === "detail" ? `상세 ${v.label}` : v.kind === "aux" ? `보조 ${v.label}` : "등각 그림";
      const extra =
        v.kind === "detail"
          ? `<select data-vk="${v.id}" title="배율">${DETAIL_K.map((k) => `<option value="${k}"${k === v.k ? " selected" : ""}>${k}:1</option>`).join("")}</select>`
          : v.kind === "section" || v.kind === "aux"
            ? `<button class="small ghost" data-vflip="${v.id}" title="보는 방향 뒤집기">⇄</button>`
            : "";
      const moved = v.at ? `<button class="small ghost" data-vhome="${v.id}" title="자동 자리로">↺</button>` : "";
      return `<div class="view-row${sheetEdit.selectedView === v.id ? " sel" : ""}"><span class="vk">${KIND_NAME[v.kind]}</span><span class="vn">${esc(title)}</span>${extra}${moved}<button class="small ghost" data-vdel="${v.id}" title="지우기">✕</button></div>`;
    })
    .join("");
}

function wireViewList() {
  const box = $("#viewList");
  box.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const flip = t.dataset.vflip;
    const del = t.dataset.vdel;
    const home = t.dataset.vhome;
    if (flip) editorHost.editViews((l) => l.map((v) => (v.id === flip && (v.kind === "section" || v.kind === "aux") ? { ...v, flip: !v.flip } : v)), "보는 방향 뒤집기");
    if (home) editorHost.editViews((l) => l.map((v) => (v.id === home ? (({ at: _at, ...rest }) => rest)(v) as typeof v : v)), "뷰 자동 자리로");
    if (del) {
      sheetEdit.selectedView = del;
      void commands.run("sheet.dimDelete");
    }
  });
  box.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    const id = t.dataset.vk;
    if (id) editorHost.editViews((l) => l.map((v) => (v.id === id && v.kind === "detail" ? { ...v, k: Number(t.value) } : v)), "상세도 배율");
  });
  for (const cb of $$<HTMLInputElement>("#viewStd input[data-std]"))
    cb.onchange = () =>
      editDrawing((d) => {
        const v = cb.dataset.std as ViewId;
        const hide = new Set(d.hide ?? []);
        if (cb.checked) hide.delete(v);
        else hide.add(v);
        if (hide.size >= 3) {
          toast("기본 뷰 하나는 남겨 두세요.");
          hide.delete(v);
        }
        if (hide.size) d.hide = [...hide];
        else delete d.hide;
      }, cb.checked ? "뷰 보이기" : "뷰 숨기기");
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

/**
 * DWG 저장 (12.3): 설치형 앱에서 ODA File Converter로 DXF → DWG.
 * 웹판이나 변환기가 없으면 방법을 알려 주고 DXF로 저장할 수 있게.
 */
async function saveDwg() {
  const r = await sheetNow();
  if (!r) return;
  const native = await import("../app/native");
  if (!native.isApp()) {
    notice(
      "DWG 저장은 설치형 앱(윈도우·맥)에서 돼요. 지금은 DXF로 저장해 AutoCAD에서 ‘다른 이름으로 저장 → DWG’ 하면 치수까지 그대로 남아요.",
      [{ label: "DXF로 저장", run: () => commands.run("sheet.dxf") }],
      "info",
      "dwg",
    );
    return;
  }
  const s = prefs.get();
  const exe = await native.findOda(s.odaPath);
  if (!exe) {
    notice(
      "DWG로 저장하려면 무료 ‘ODA File Converter’가 필요해요 (한 번만 설치). 설치했는데 못 찾으면 실행 파일 위치를 골라 주세요.",
      [
        { label: "받는 곳 열기", run: () => void native.openUrl(native.ODA_URL) },
        {
          label: "위치 고르기",
          run: async () => {
            const p = await native.pickOda();
            if (!p) return;
            prefs.set({ odaPath: p });
            closeNotice("dwg");
            void saveDwg();
          },
        },
        { label: "DXF로 저장", run: () => commands.run("sheet.dxf") },
      ],
      "warn",
      "dwg",
    );
    return;
  }
  const { sheetToDXF } = await import("../core/sheet");
  const label = native.DWG_VERSIONS.find(([v]) => v === s.dwgVersion)?.[1] ?? s.dwgVersion;
  try {
    toast("DWG로 바꾸는 중…");
    const path = await native.saveDwg(sheetToDXF(r.sh), `${drawingBase(r.d)}.dwg`, s.dwgVersion, exe);
    if (path) toast(`DWG로 저장했어요 (${label}): ${native.baseOf(path)}`);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    toast(msg === "ODA_NOT_FOUND" ? "ODA File Converter를 찾지 못했어요. 설정 ▸ 일반 ▸ DWG 저장에서 위치를 골라 주세요." : `DWG로 저장하지 못했어요: ${msg}`);
  }
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
      if (r) await saveFile(`${drawingBase(r.d)}.dxf`, (await import("../core/sheet")).sheetToDXF(r.sh), "application/dxf", "dxf");
    },
  },
  {
    id: "sheet.dwg",
    title: "도면을 DWG로 저장 (AutoCAD, 설치형 앱)",
    category: "내보내기",
    keywords: ["dwg", "autocad", "cad", "캐드", "export", "오토캐드"],
    when: any,
    run: saveDwg,
  },
  {
    id: "sheet.pdf",
    title: "도면을 PDF로 저장 (벡터, 실제 용지 크기)",
    category: "내보내기",
    keywords: ["pdf", "export", "인쇄", "피디에프"],
    when: any,
    run: async () => {
      const r = await sheetNow();
      if (!r) return;
      const { sheetsToPDF } = await import("../core/sheet");
      const bytes = await sheetsToPDF([r.sh], `${store.doc.name} — ${r.d.name}`);
      const ok = await saveFile(`${drawingBase(r.d)}.pdf`, bytes.slice().buffer as ArrayBuffer, "application/pdf", "pdf");
      if (ok) toast("PDF로 저장했어요");
    },
  },
  {
    id: "sheet.pdfAll",
    title: "모든 도면을 PDF 한 파일로 (여러 쪽)",
    category: "내보내기",
    keywords: ["pdf", "all drawings", "모든 도면", "묶음"],
    when: any,
    enabled: () => store.doc.drawings.length > 0,
    run: async () => {
      const list = store.doc.drawings;
      if (!list.length) return toast("도면이 없어요.");
      toast(`도면 ${list.length}장을 그리는 중…`);
      const sheets: Sheet[] = [];
      const skipped: string[] = [];
      for (const d of list) {
        const sh = await sheetOf(d);
        if (sh) sheets.push(sh);
        else skipped.push(d.name);
      }
      if (!sheets.length) return toast("그릴 수 있는 도면이 없어요 (부품의 3D가 아직 없음).");
      const { sheetsToPDF } = await import("../core/sheet");
      const bytes = await sheetsToPDF(sheets, store.doc.name);
      const ok = await saveFile(`${safeName(store.doc.name)}_도면.pdf`, bytes.slice().buffer as ArrayBuffer, "application/pdf", "pdf");
      if (ok) toast(`PDF로 저장했어요 (${sheets.length}쪽${skipped.length ? ` · 빠진 도면: ${skipped.join(", ")}` : ""})`);
    },
  },
  { id: "sheet.zoomIn", title: "도면 확대", category: "도면", keywords: ["zoom in", "확대"], keys: ["="], run: () => zoomBy($("#sheetHost"), 1.25) },
  { id: "sheet.zoomOut", title: "도면 축소", category: "도면", keywords: ["zoom out", "축소"], keys: ["-"], run: () => zoomBy($("#sheetHost"), 0.8) },
  { id: "sheet.zoomFit", title: "도면 전체 보기 (맞춤)", category: "도면", keywords: ["fit", "맞춤", "전체"], keys: ["F"], run: () => zoomFit($("#sheetHost")) },
  { id: "sheet.select", title: "도면: 선택 (치수 고르기·옮기기)", category: "도면", keywords: ["select", "선택"], keys: ["V"], checked: () => sheetEdit.tool === "select", run: () => setTool("select") },
  { id: "sheet.dim", title: "도면: 치수 놓기 (재기)", category: "도면", keywords: ["dimension", "measure", "치수", "재기"], keys: ["D"], checked: () => sheetEdit.tool === "dim", run: () => setTool("dim") },
  ...(["auto", "h", "v", "aligned", "angle"] as DimKind[]).map((k) => ({
    id: `sheet.dim.${k}`,
    title: `도면 치수: ${{ auto: "자동 (가로·세로)", h: "가로", v: "세로", aligned: "평행", angle: "각도" }[k]}`,
    category: "도면",
    keywords: ["dimension", "치수"],
    checked: () => sheetEdit.tool === "dim" && sheetEdit.kind === k,
    run: () => {
      sheetEdit.kind = k;
      setTool("dim");
    },
  })),
  {
    id: "sheet.dimDelete",
    title: "고른 치수 지우기 (자동 치수는 숨기기)",
    category: "도면",
    keywords: ["delete dimension", "치수 지우기"],
    keys: ["Delete", "Backspace"],
    enabled: () => !!sheetEdit.selected || !!sheetEdit.selectedView,
    run: async () => (await import("./sheetEdit")).deleteSelected(app.lastSheet, activeDrawing(store.doc)?.edits ?? {}, editorHost),
  },
  {
    id: "sheet.dimRestore",
    title: "자동 치수 처음대로 (숨긴·옮긴 것 되돌리기)",
    category: "도면",
    keywords: ["restore dimensions", "치수 되살리기"],
    enabled: () => !!(activeDrawing(store.doc)?.edits?.hide?.length || Object.keys(activeDrawing(store.doc)?.edits?.moved ?? {}).length),
    run: () =>
      editorHost.edit((e) => {
        delete e.hide;
        delete e.moved;
      }, "자동 치수 처음대로"),
  },
  // ---- 추가 뷰 (14단계) ----
  { id: "sheet.section", title: "도면: 단면도 (절단선 두 점)", category: "도면", keywords: ["section", "cut", "단면", "절단"], keys: ["S"], checked: () => sheetEdit.tool === "section", run: () => setTool("section") },
  { id: "sheet.aux", title: "도면: 보조 투상도 (경사 모서리 두 점)", category: "도면", keywords: ["auxiliary", "보조", "경사"], keys: ["B"], checked: () => sheetEdit.tool === "aux", run: () => setTool("aux") },
  { id: "sheet.detail", title: "도면: 상세도 (원으로 확대)", category: "도면", keywords: ["detail", "상세", "확대"], keys: ["C"], checked: () => sheetEdit.tool === "detail", run: () => setTool("detail") },
  // ---- 기호 (14.5) ----
  { id: "sheet.rough", title: "도면: 표면 거칠기 기호", category: "도면", keywords: ["surface roughness", "Ra", "거칠기", "표면"], keys: ["R"], checked: () => sheetEdit.tool === "rough", run: () => setTool("rough") },
  { id: "sheet.gdt", title: "도면: 기하공차 (평면도·직각도·위치도 …)", category: "도면", keywords: ["gd&t", "geometric tolerance", "기하공차", "평면도", "직각도", "위치도"], keys: ["G"], checked: () => sheetEdit.tool === "gdt", run: () => setTool("gdt") },
  { id: "sheet.datum", title: "도면: 데이텀 (기준면)", category: "도면", keywords: ["datum", "데이텀", "기준"], keys: ["A"], checked: () => sheetEdit.tool === "datum", run: () => setTool("datum") },
  {
    id: "sheet.iso",
    title: "도면: 등각 그림 넣기",
    category: "도면",
    keywords: ["isometric", "등각", "입체"],
    keys: ["I"],
    enabled: () => !!activeDrawing(store.doc),
    run: () => {
      if ((activeDrawing(store.doc)?.views ?? []).some((v) => v.kind === "iso")) return toast("등각 그림은 이미 있어요.");
      editorHost.editViews((l) => [...l, { id: `v${Date.now().toString(36)}`, kind: "iso", label: "ISO" }], "등각 그림");
    },
  },
  { id: "sheet.print", title: "도면 인쇄", category: "내보내기", keywords: ["print", "인쇄"], keys: ["Ctrl+P"], when: any, global: true, run: printSheet },
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
    $("#toolHint").hidden = false;
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
  $("#expDwg").dataset.cmd = "sheet.dwg";
  $("#printBtn").dataset.cmd = "sheet.print";
  $("#addDrawing").dataset.cmd = "doc.addDrawing";
  $("#delDrawing").dataset.cmd = "doc.deleteDrawing";
  wireZoom($("#sheetHost"));
  const kindSel = $<HTMLSelectElement>("#dimKind");
  kindSel.onchange = () => commands.run(`sheet.dim.${kindSel.value}`);
  wireViewList();
  syncTools();
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
