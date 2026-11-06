/**
 * 파일: 메뉴, 예제, 프로젝트 파일(.json) 열기·저장, 3D 파일(STEP·STL)·도면 이미지 가져오기,
 * 끌어다 놓기·붙여넣기, 가져온 3D 파일 표시줄.
 */
import { normalizeProject } from "../core/project";
import { SAMPLES } from "../core/samples";
import { emptyProject, VIEW_IDS } from "../core/types";
import { pickTextFile, saveFile } from "../files";
import { getFile, putFile } from "../fileStore";
import { fromBase64, toBase64 } from "../library";
import { store } from "../store";
import { ImportDialog } from "../ui/importDialog";
import { Modal } from "../ui/modal";
import { ReviewDialog } from "../ui/reviewDialog";
import { loadUnderlay, putUnderlay } from "../underlay";
import { showWorkspace } from "../workspaces/registry";
import { baseName } from "../workspaces/sheet";
import type { Command } from "./commands";
import { commands, onPanels } from "./context";
import { $, $$, isTyping } from "./dom";
import { toast } from "./notify";
import { needExp } from "./prefs";
import { openNew, session } from "./projects";

let importDlg: ImportDialog;
let reviewDlg: ReviewDialog;
export const importDialogsOpen = () => importDlg?.isOpen || reviewDlg?.isOpen;

export function initFileMenu() {
  SAMPLES.forEach((s, i) => {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.dataset.cmd = `sample.${i}`;
    $("#samples").appendChild(b);
  });

  reviewDlg = new ReviewDialog({
    onDraft: (p) => {
      openNew(p);
      showWorkspace("3d");
      toast("AI가 읽은 치수로 3D 초안을 새 프로젝트로 만들었어요. 틀린 곳은 2D 설계(1)에서 고치세요. 앞의 프로젝트는 ‘내 프로젝트’에 그대로 있어요.");
    },
    openSettings: () => commands.run("app.settings"),
  });
  importDlg = new ImportDialog(
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
    if (all.length > 1 && all.every(isImage)) return void (needExp() && reviewDlg.open(all));
    if (isImage(f)) needExp() && importDlg.open(f);
    else if (is3D(f)) void import3D(f);
    else if (/\.json$/i.test(f.name)) void f.text().then(openProjectText);
    else toast("이미지(PNG·JPG)·PDF, 3D 파일(STEP·STL), 프로젝트 파일(.json)을 놓아 주세요.");
  });
  window.addEventListener("paste", (e) => {
    if (isTyping() || importDialogsOpen() || Modal.anyOpen()) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const f = item?.getAsFile();
    if (f) {
      e.preventDefault();
      if (needExp()) importDlg.open(new File([f], "붙여넣은 이미지.png", { type: f.type }));
    }
  });

  // 가져온 3D 파일 표시줄
  $$<HTMLButtonElement>("[data-turn]").forEach((b) => (b.dataset.cmd = `source.turn${"XYZ"[Number(b.dataset.turn)]}`));
  $("#sourceClose").dataset.cmd = "source.close";
  onPanels(renderSourceBar);
}

const isImage = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif|pdf)$/i.test(f.name) || f.type === "application/pdf";
const is3D = (f: File) => /\.(step|stp|stl)$/i.test(f.name);

function pick3D() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp,.stl,model/step,model/stl";
  input.onchange = () => input.files?.[0] && void import3D(input.files[0]);
  input.click();
}

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

function turn(i: number) {
  store.update((p) => {
    if (!p.source) return;
    const t = [...p.source.turns] as [number, number, number];
    t[i] = (t[i] + 1) % 4;
    p.source.turns = t;
  }, `3D 파일 ${"XYZ"[i]}축으로 돌리기`);
}

async function openProjectFile() {
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
    if (p.source && typeof model === "string") void putFile(p.source.key, fromBase64(model)).then(() => openNew(p));
    else openNew(p);
  } catch {
    toast("프로젝트 파일을 읽을 수 없습니다.");
  }
}

/** 프로젝트를 파일(.json)로 — 밑그림 이미지와 가져온 3D 파일도 넣어 다른 컴퓨터에서도 열리게 */
export async function saveProjectFile() {
  const p = store.project;
  const data = p.underlay ? await loadUnderlay(p.underlay.key) : null;
  let out: Record<string, unknown> = data && p.underlay ? { ...p, underlay: { ...p.underlay, data } } : { ...p };
  if (p.source) {
    const bytes = await getFile(p.source.key);
    if (bytes) out = { ...out, source: { ...p.source, data: toBase64(bytes) } };
  }
  await saveFile(`${baseName()}.blueprint3d.json`, JSON.stringify(out, null, 2), "application/json", "json");
}

const hasSource = () => !!store.project.source;

export function fileCommands(): Command[] {
  return [
    { id: "file.new", title: "새 부품", category: "파일", keywords: ["new", "새로 만들기", "새 프로젝트"], keys: ["Ctrl+Alt+N"], global: true, run: () => openNew(emptyProject()) },
    { id: "file.open", title: "파일 열기 (.json)", category: "파일", keywords: ["open", "load", "불러오기"], keys: ["Ctrl+O"], global: true, run: openProjectFile },
    { id: "file.save", title: "파일로 저장 (.json)", category: "파일", keywords: ["save", "export", "내보내기"], keys: ["Ctrl+S"], global: true, run: saveProjectFile },
    { id: "file.import3d", title: "3D 파일 가져오기 (STEP·STL)", category: "파일", keywords: ["import", "step", "stl", "stp", "불러오기"], run: pick3D },
    {
      id: "file.importImage",
      title: "도면 이미지 가져오기 (실험)",
      category: "파일",
      keywords: ["image", "photo", "scan", "pdf", "사진", "스캔"],
      keys: ["Ctrl+I"],
      global: true,
      run: () => needExp() && importDlg.pickFile(),
    },
    { id: "file.review", title: "도면 검토 (AI, 실험)", category: "파일", keywords: ["review", "ai", "sketch", "스케치"], run: () => needExp() && reviewDlg.open() },
    ...SAMPLES.map((s, i) => ({ id: `sample.${i}`, title: `예제: ${s.name}`, category: "예제", keywords: ["sample", "example"], run: () => openNew(structuredClone(s)) })),
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
