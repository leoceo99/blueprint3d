/**
 * 내 프로젝트 · 버전 기록 · 자동 저장 · 여러 탭 · 썸네일 · 저장 공간 (7단계)
 */
import { emptyProject, VIEW_IDS, type Project } from "../core/types";
import type { Doc } from "../core/document";
import { pickFiles, saveFile } from "../files";
import { listProjects } from "../library";
import { Session } from "../session";
import { setSaveErrorHandler, store } from "../store";
import { initTabs } from "../tabs";
import { ProjectsDialog, VersionsDialog } from "../ui/libraryDialogs";
import { ui } from "../ui/state";
import type { Command } from "./commands";
import { app, commands, emit, on, requestRender } from "./context";
import { $, commitTyping } from "./dom";
import { fitAll } from "./edit";
import { closeNotice, errText, isQuota, notice, toast } from "./notify";
import { prefs } from "./prefs";


export let session: Session;
let projectsDlg: ProjectsDialog;
let versionsDlg: VersionsDialog;

/** 새 문서로 열기 — 지금 문서는 ‘내 프로젝트’에 그대로 남는다 */
/** 새 빈 부품 (설정의 “새 문서 길이 단위”를 따른다) */
export function blankProject(): Project {
  const p = emptyProject();
  if (prefs.get().units === "inch") p.units = "inch";
  return p;
}

export function openNew(p: Doc | Project) {
  commitTyping();
  session.openAsNew(p).catch(warnStorage);
}

export async function openFromLibrary(id: string) {
  commitTyping();
  try {
    await session.open(id);
  } catch (e) {
    toast(errText(e) || "프로젝트를 열 수 없습니다.");
  }
}

function setSaveState(st: "saving" | "saved" | "error") {
  const b = $("#saveState");
  b.classList.toggle("err", st === "error");
  b.textContent = st === "saving" ? "저장 중…" : st === "saved" ? "✓ 저장됨" : "⚠ 저장 실패";
}

let storageWarned = false;
function warnStorage(e: unknown) {
  console.error(e);
  if (storageWarned) return;
  storageWarned = true;
  notice(
    isQuota(e)
      ? "브라우저 저장 공간이 가득 찼어요. 휴지통을 비우거나, 전체 백업을 내보낸 뒤 안 쓰는 프로젝트를 지워 주세요."
      : `저장하다 문제가 생겼어요${errText(e) ? ` (${errText(e)})` : ""}. ‘파일로 저장’이나 전체 백업으로 작업을 지켜 두세요.`,
    [
      { label: "내 프로젝트", run: () => projectsDlg.open() },
      { label: "파일로 저장", run: () => commands.run("file.save") },
    ],
    "err",
    "storage",
  );
}

// 3D가 새로 만들어지면 썸네일 (보관함 카드·버전 기록에 쓰임)
let thumbTimer = 0;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  if (!app.lastBuild) return;
  const id = store.projectId;
  const stamp = app.buildStamp;
  const fresh = () => !!app.lastBuild && store.projectId === id && app.buildStamp === stamp && document.visibilityState === "visible";
  thumbTimer = window.setTimeout(async () => {
    if (!fresh()) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "#fbfcfd";
    // 3D 보기를 아직 안 열었으면 이때 three.js를 불러온다 (첫 화면 뒤라 느려지지 않음)
    const url = await app.viewer.snapshot(320, 240, "image/jpeg", 0.82, bg);
    if (url && fresh()) session.setThumbnail(url);
  }, 1500);
}

export function initProjects() {
  setSaveErrorHandler(warnStorage);
  const tabs = initTabs({
    currentId: () => store.projectId,
    onDuplicate: () => notice("이 프로젝트가 다른 탭에서도 열려 있어요. 두 곳에서 고치면 나중에 저장한 쪽이 남아요.", [], "warn", "dup"),
    onRemoteSaved: () => notice("다른 탭에서 이 프로젝트를 고쳤어요.", [{ label: "다시 불러오기", run: () => session.reload() }], "warn", "remote"),
  });
  session = new Session({
    onSwitched: () => {
      app.ai = null;
      ui.sel = null;
      ui.activeView = VIEW_IDS.find((v) => store.project.views[v].length) ?? "front";
      closeNotice("remote");
      closeNotice("dup");
      tabs.announce();
      fitAll();
      emit("switched");
      requestRender();
    },
    onSaved: () => tabs.saved(),
    onState: setSaveState,
    onError: warnStorage,
  });
  setSaveState("saved");
  tabs.announce();
  on("built", scheduleThumb);

  projectsDlg = new ProjectsDialog({
    currentId: () => store.projectId,
    open: openFromLibrary,
    newProject: () => openNew(blankProject()),
    flush: () => session.flush(),
    toast,
    download: (name, data, mime, ext) => void saveFile(name, data, mime, ext),
    pickFile: async (accept) => (await pickFiles(accept))[0] ?? null,
    showVersions: (id) => void versionsDlg.open(id),
    renameCurrent: renameDoc,
  });
  versionsDlg = new VersionsDialog({
    currentId: () => store.projectId,
    current: () => store.doc,
    restore: (p) => {
      app.ai = null;
      ui.sel = null;
      store.replace(p, "버전 되돌리기");
      fitAll();
    },
    openAsNew: openNew,
    open: openFromLibrary,
    flush: () => session.flush(),
    thumb: () => session.thumb,
    toast,
  });
  $("#saveState").dataset.cmd = "file.versions";

  // 부품 이름 칸
  const nameInput = $<HTMLInputElement>("#name");
  nameInput.onchange = () => renameDoc(nameInput.value.trim() || "새 부품");
  nameInput.onkeydown = (e) => e.key === "Enter" && nameInput.blur();
  const syncName = () => {
    if (document.activeElement !== nameInput) nameInput.value = store.doc.name;
  };
  store.subscribe(syncName);
  syncName();

  // 저장 공간 (설정 창)
  $("#persistBtn").onclick = async () => {
    const ok = await navigator.storage.persist().catch(() => false);
    toast(ok ? "저장 공간을 보호하도록 했어요." : "브라우저가 요청을 받아 주지 않았어요. 앱으로 설치하면 보통 보호돼요.");
    void showStorage();
  };
}

/** 문서 이름 바꾸기. 부품이 하나뿐이면 부품 이름도 (표제란 부품명) */
export function renameDoc(name: string) {
  store.updateDoc((d) => {
    d.name = name;
    if (d.parts.length === 1) d.parts[0].name = name;
  }, "이름 바꾸기");
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
export async function showStorage() {
  const info = $("#storageInfo");
  const btn = $<HTMLButtonElement>("#persistBtn");
  const st = navigator.storage;
  const n = (await listProjects().catch(() => [])).filter((p) => !p.deletedAt).length;
  if (!st?.estimate) {
    info.textContent = `프로젝트 ${n}개. 이 브라우저는 저장 공간 크기를 알려 주지 않아요.`;
    return;
  }
  const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([st.estimate(), st.persisted ? st.persisted() : Promise.resolve(false)]);
  info.textContent =
    `프로젝트 ${n}개 · 쓰는 중 ${mb(usage)} / 쓸 수 있는 공간 ${mb(quota)} (3D 엔진 등 앱 파일 포함). ` +
    (persisted ? "브라우저가 자동으로 지우지 않게 보호돼 있어요." : "공간이 모자라면 브라우저가 지울 수도 있어요 — 가끔 ‘내 프로젝트 → 전체 백업 내보내기’를 해 두세요.");
  btn.hidden = persisted || !st.persist;
}

export function projectCommands(): Command[] {
  return [
    { id: "file.projects", title: "내 프로젝트", category: "파일", keywords: ["projects", "library", "보관함", "목록"], keys: ["Ctrl+Shift+O"], global: true, run: () => projectsDlg.open() },
    { id: "file.versions", title: "버전 기록", category: "파일", keywords: ["versions", "history", "되돌리기"], run: () => versionsDlg.open() },
    { id: "file.snapshot", title: "지금 버전 저장", category: "파일", keywords: ["snapshot", "save version", "버전"], keys: ["Ctrl+Shift+S"], global: true, run: () => versionsDlg.saveNow() },
  ];
}
