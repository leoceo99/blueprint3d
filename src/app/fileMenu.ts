/**
 * 파일: 메뉴, 예제, 문서 파일(.b3d) 열기·저장(예전 .json도 열기), 3D 파일(STEP·STL)·도면 이미지 가져오기,
 * 끌어다 놓기·붙여넣기, 설치한 앱으로 파일 열기, 가져온 3D 파일 표시줄.
 */
import { B3D_MIME, readDocFile, writeB3d, type FileData } from "../core/b3d";
import { parseDataUrl } from "../core/bytes";
import { addPart, docFileKeys, docFromProject } from "../core/document";
import { SAMPLES } from "../core/samples";
import { emptyProject, VIEW_IDS, type Project } from "../core/types";
import { pickFiles, safeName, saveFile } from "../files";
import { getFile, getText, putFile } from "../fileStore";
import { store } from "../store";
import type { ImportDialog } from "../ui/importDialog";
import { Modal } from "../ui/modal";
import type { ReviewDialog } from "../ui/reviewDialog";
import { loadUnderlay, putUnderlay } from "../underlay";
import { showWorkspace } from "../workspaces/registry";
import type { Command } from "./commands";
import { commands, on, onPanels } from "./context";
import { $, $$, isTyping } from "./dom";
import { toast } from "./notify";
import { needExp, prefs } from "./prefs";
import { blankProject, openNew, session } from "./projects";
import { docPath, initNative, isApp, nativeSave, pathOf, readAsFile, setDocPath } from "./native";

let importDlg: ImportDialog | null = null;
let reviewDlg: ReviewDialog | null = null;
export const importDialogsOpen = () => !!(importDlg?.isOpen || reviewDlg?.isOpen);

/** 실험 기능 창(도면 이미지 가져오기·AI 도면 검토)은 처음 쓸 때 내려받는다 — 처음 여는 속도를 위해 */
let loading: Promise<{ importDlg: ImportDialog; reviewDlg: ReviewDialog }> | null = null;
function expDialogs() {
  loading ??= Promise.all([import("../ui/importDialog"), import("../ui/reviewDialog")]).then(([im, rv]) => {
    const review = new rv.ReviewDialog({
      onDraft: (p) => {
        openNew(p);
        showWorkspace("3d");
        toast("AI가 읽은 치수로 3D 초안을 새 문서로 만들었어요. 틀린 곳은 2D 설계(1)에서 고치세요. 앞의 문서는 ‘내 프로젝트’에 그대로 있어요.");
      },
      openSettings: () => commands.run("app.settings"),
    });
    const imp = new im.ImportDialog(
      ({ project, underlay }) => {
        if (underlay) putUnderlay(underlay.meta.key, underlay.dataUrl);
        openNew(project);
        showWorkspace("design");
        const n = VIEW_IDS.filter((v) => project.views[v].length).length;
        toast(`도면을 새 문서로 가져왔어요 (뷰 ${n}개). 3D 보기(2)로 확인하고, 다른 곳은 속성 패널에서 고치세요.`);
      },
      (file) => {
        imp.close();
        review.open([file]);
      },
    );
    importDlg = imp;
    reviewDlg = review;
    return { importDlg: imp, reviewDlg: review };
  });
  return loading;
}

export function initFileMenu() {
  SAMPLES.forEach((s, i) => {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.dataset.cmd = `sample.${i}`;
    $("#samples").appendChild(b);
  });
  const sd = document.createElement("button");
  sd.textContent = "문서 예제: 부품 2개 + 도면 2장";
  sd.dataset.cmd = "sample.doc";
  $("#samples").appendChild(sd);

  // 끌어다 놓기 · 붙여넣기
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    const all = [...(e.dataTransfer?.files ?? [])];
    const f = all[0];
    if (!f) return;
    e.preventDefault();
    if (importDialogsOpen() || Modal.anyOpen()) return;
    // 그림 여러 장 → 도면 검토
    if (all.length > 1 && all.every(isImage)) return void (needExp() && expDialogs().then((d) => d.reviewDlg.open(all)));
    openFile(f);
  });
  // 설치형 앱(12단계): 탐색기에서 두 번 누른 파일, 이미 켜진 앱으로 연 파일, 최근 파일
  void initNative(openFile);
  renderRecent();
  on("settings", renderRecent);
  // 설치한 앱으로 파일을 열면 (파일 탐색기 → 연결 프로그램) 여기로 들어온다
  const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: { getFile(): Promise<File> }[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    for (const h of params.files ?? []) openFile(await h.getFile());
  });
  window.addEventListener("paste", (e) => {
    if (isTyping() || importDialogsOpen() || Modal.anyOpen()) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const f = item?.getAsFile();
    if (f) {
      e.preventDefault();
      if (needExp()) void expDialogs().then((d) => d.importDlg.open(new File([f], "붙여넣은 이미지.png", { type: f.type })));
    }
  });

  // 가져온 3D 파일 표시줄
  $$<HTMLButtonElement>("[data-turn]").forEach((b) => (b.dataset.cmd = `source.turn${"XYZ"[Number(b.dataset.turn)]}`));
  $("#sourceClose").dataset.cmd = "source.close";
  onPanels(renderSourceBar);
}

/** 최근 파일 (설치형 앱) */
function renderRecent() {
  const list = isApp() ? prefs.get().recentFiles : [];
  $("#recentFiles").hidden = !list.length;
  const box = $("#recentList");
  box.innerHTML = "";
  for (const p of list) {
    const b = document.createElement("button");
    b.textContent = p.split(/[\\/]/).pop() ?? p;
    b.title = p;
    b.onclick = async () => {
      try {
        openFile(await readAsFile(p));
      } catch {
        toast(`파일을 찾을 수 없어요: ${p}`);
        prefs.set({ recentFiles: prefs.get().recentFiles.filter((x) => x !== p) });
      }
    };
    box.appendChild(b);
  }
}

/** 파일 하나를 종류에 맞게 열기 (끌어다 놓기·설치한 앱으로 열기) */
function openFile(f: File) {
  if (isImage(f)) needExp() && void expDialogs().then((d) => d.importDlg.open(f));
  else if (is3D(f)) void import3D(f);
  else if (isDocFile(f)) void openDocFile(f);
  else toast("문서(.b3d)·예전 프로젝트(.json), 3D 파일(STEP·STL), 이미지(PNG·JPG)·PDF를 놓아 주세요.");
}

const isDocFile = (f: File) => /\.(b3d|json)$/i.test(f.name);
const isImage = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif|pdf)$/i.test(f.name) || f.type === "application/pdf";
const is3D = (f: File) => /\.(step|stp|stl)$/i.test(f.name);

async function pick3D(asPart = false) {
  const [f] = await pickFiles(".step,.stp,.stl,model/step,model/stl");
  if (f) await import3D(f, asPart);
}

/** STEP·STL 가져오기: 새 문서로, 또는 지금 문서의 부품으로 */
async function import3D(file: File, asPart = false) {
  const kind = /\.stl$/i.test(file.name) ? "stl" : "step";
  const data = await file.arrayBuffer();
  const key = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await putFile(key, data);
  const p: Project = emptyProject();
  p.name = file.name.replace(/\.[^.]+$/, "") || "가져온 부품";
  p.source = { kind, name: file.name, key, turns: [0, 0, 0] };
  if (asPart) store.updateDoc((d) => void addPart(d, p), `부품으로 가져오기: ${p.name}`);
  else openNew(p);
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

function turn(i: number) {
  store.update((p) => {
    if (!p.source) return;
    const t = [...p.source.turns] as [number, number, number];
    t[i] = (t[i] + 1) % 4;
    p.source.turns = t;
  }, `3D 파일 ${"XYZ"[i]}축으로 돌리기`);
}

async function pickDocFile() {
  const [f] = await pickFiles(".b3d,.json,application/json");
  if (f) await openDocFile(f);
}

/** 문서 파일 열기: .b3d(zip) 또는 예전 .json — 새 문서로 연다 */
async function openDocFile(f: File | Blob) {
  try {
    const { doc, files } = readDocFile(new Uint8Array(await f.arrayBuffer()));
    for (const [key, data] of Object.entries(files)) {
      if (typeof data === "string") putUnderlay(key, data);
      else await putFile(key, data);
    }
    openNew(doc);
    // 앱에서 연 .b3d는 그 파일에 바로 저장 (Ctrl+S)
    const p = pathOf(f);
    if (p) setDocPath(store.projectId, p);
  } catch (e) {
    toast((e as Error).message || "문서 파일을 읽을 수 없습니다.");
  }
}

/**
 * 문서를 파일(.b3d)로 — 3D 파일·밑그림 이미지·썸네일까지 한 파일에.
 * 설치형 앱은 연결된 파일이 있으면 묻지 않고 그 파일에 저장 (saveAs면 늘 저장 창)
 */
export async function saveProjectFile(saveAs = false) {
  await session.flush();
  const doc = store.doc;
  const files: Record<string, FileData> = {};
  for (const key of docFileKeys(doc)) {
    const t = (await getText(key)) ?? (await loadUnderlay(key));
    if (t) files[key] = t;
    else {
      const b = await getFile(key);
      if (b) files[key] = b;
    }
  }
  const thumb = session.thumb ? parseDataUrl(session.thumb)?.bytes : undefined;
  const bytes = writeB3d({ doc, files, thumbnail: thumb });
  const id = store.projectId;
  if (isApp()) {
    const known = saveAs ? undefined : docPath(id);
    try {
      const path = await nativeSave(`${safeName(doc.name)}.b3d`, bytes, "b3d", known);
      if (!path) return;
      setDocPath(id, path);
      toast(`저장했어요: ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      toast(`저장하지 못했어요: ${(e as Error).message ?? e}`);
    }
    return;
  }
  await saveFile(`${safeName(doc.name)}.b3d`, bytes.slice().buffer, B3D_MIME, "b3d");
}

const hasSource = () => !!store.project.source;

/** 여러 부품 문서 예제: L 브래킷 + 플랜지, 도면도 각자 */
function sampleDoc() {
  const doc = docFromProject(structuredClone(SAMPLES[0]));
  doc.name = "예제 문서 (브래킷 + 플랜지)";
  doc.drawings[0].name = "브래킷 도면";
  doc.drawings[0].sheet = { material: "SS400", qty: "2" };
  const f = addPart(doc, structuredClone(SAMPLES[1]));
  const d = doc.drawings.find((x) => x.partId === f.id)!;
  d.name = "플랜지 도면";
  d.sheet = { material: "AL6061", scale: "1:2" };
  doc.view = { part: doc.parts[0].id, drawing: doc.drawings[0].id };
  return doc;
}

export function fileCommands(): Command[] {
  return [
    { id: "file.new", title: "새 문서", category: "파일", keywords: ["new", "새 부품", "새로 만들기", "새 프로젝트"], keys: ["Ctrl+Alt+N"], global: true, run: () => openNew(blankProject()) },
    { id: "file.open", title: "파일 열기 (.b3d · 예전 .json)", category: "파일", keywords: ["open", "load", "불러오기", "b3d"], keys: ["Ctrl+O"], global: true, run: pickDocFile },
    { id: "file.save", title: "파일로 저장 (.b3d)", category: "파일", keywords: ["save", "export", "내보내기", "b3d"], keys: ["Ctrl+S"], global: true, run: () => saveProjectFile() },
    { id: "file.saveAs", title: "다른 이름으로 저장 (.b3d)", category: "파일", keywords: ["save as", "다른 이름", "b3d"], keys: ["Ctrl+Alt+S"], global: true, run: () => saveProjectFile(true) },
    { id: "file.import3d", title: "3D 파일 가져오기 (STEP·STL) — 새 문서로", category: "파일", keywords: ["import", "step", "stl", "stp", "불러오기"], run: () => pick3D(false) },
    { id: "file.import3dAsPart", title: "3D 파일을 이 문서의 부품으로 가져오기", category: "문서", keywords: ["import part", "step", "stl", "부품"], run: () => pick3D(true) },
    {
      id: "file.importImage",
      title: "도면 이미지 가져오기 (실험)",
      category: "파일",
      keywords: ["image", "photo", "scan", "pdf", "사진", "스캔"],
      keys: ["Ctrl+I"],
      global: true,
      run: () => needExp() && expDialogs().then((d) => d.importDlg.pickFile()),
    },
    { id: "file.review", title: "도면 검토 (AI, 실험)", category: "파일", keywords: ["review", "ai", "sketch", "스케치"], run: () => needExp() && expDialogs().then((d) => d.reviewDlg.open()) },
    ...SAMPLES.map((s, i) => ({ id: `sample.${i}`, title: `예제: ${s.name}`, category: "예제", keywords: ["sample", "example"], run: () => openNew(structuredClone(s)) })),
    { id: "sample.doc", title: "예제 문서: 부품 2개 + 도면 2장", category: "예제", keywords: ["sample", "multi part", "여러 부품"], run: () => openNew(sampleDoc()) },
    { id: "source.turnX", title: "3D 파일 X축으로 90° 돌리기", category: "가져온 3D 파일", keywords: ["rotate"], enabled: hasSource, run: () => turn(0) },
    { id: "source.turnY", title: "3D 파일 Y축으로 90° 돌리기", category: "가져온 3D 파일", keywords: ["rotate"], enabled: hasSource, run: () => turn(1) },
    { id: "source.turnZ", title: "3D 파일 Z축으로 90° 돌리기", category: "가져온 3D 파일", keywords: ["rotate"], enabled: hasSource, run: () => turn(2) },
    {
      id: "source.close",
      title: "가져온 3D 파일 닫기",
      category: "가져온 3D 파일",
      keywords: ["close"],
      enabled: hasSource,
      run: async () => {
        await session.snapshot("3D 파일 닫기 전");
        store.update((p) => delete p.source, "3D 파일 닫기");
      },
    },
  ];
}
