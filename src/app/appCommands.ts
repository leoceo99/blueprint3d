/** 어느 작업 공간에서나 쓰는 명령: 실행 취소, 명령 찾기, 설정, 테마, 내보내기, AI 검토 */
import type { Theme } from "../core/settings";
import { engine } from "../engine";
import { saveFile } from "../files";
import { store } from "../store";
import { aiBusy, toggleAiReview } from "../panels/findings";
import { baseName } from "../workspaces/sheet";
import type { Command } from "./commands";
import { app } from "./context";
import { openHistory } from "./historyPanel";
import { toast } from "./notify";
import { openPalette } from "./palette";
import { needExp, prefs } from "./prefs";
import { openSettings } from "./settingsDialog";

async function export3D(f: "stl" | "step") {
  if (!app.lastBuild) return toast("먼저 3D 모델을 만들어 주세요.");
  try {
    const data = await engine.export(f);
    await saveFile(`${baseName()}.${f}`, data, f === "stl" ? "model/stl" : "model/step", f);
  } catch (e: any) {
    toast(e.message);
  }
}

const THEMES: [Theme, string][] = [
  ["system", "시스템 설정 따르기"],
  ["light", "밝게"],
  ["dark", "어둡게"],
];

export function appCommands(): Command[] {
  return [
    { id: "edit.undo", title: "실행 취소", category: "편집", keywords: ["undo", "되돌리기"], keys: ["Ctrl+Z"], enabled: () => store.canUndo, run: () => store.undo() },
    { id: "edit.redo", title: "다시 실행", category: "편집", keywords: ["redo"], keys: ["Ctrl+Shift+Z", "Ctrl+Y"], enabled: () => store.canRedo, run: () => store.redo() },
    { id: "edit.history", title: "실행 취소 기록 보기", category: "편집", keywords: ["history", "undo list", "기록"], keys: ["Ctrl+Alt+Z"], run: openHistory },
    { id: "app.palette", title: "명령 찾기", category: "앱", keywords: ["command", "palette", "search", "찾기"], keys: ["Ctrl+K", "F1"], global: true, run: () => openPalette() },
    { id: "app.settings", title: "설정", category: "앱", keywords: ["settings", "preferences", "환경 설정"], keys: ["Ctrl+,"], global: true, run: () => openSettings() },
    { id: "app.shortcuts", title: "단축키 보기 · 바꾸기", category: "앱", keywords: ["shortcuts", "keys", "keyboard", "키"], run: () => openSettings("keys") },
    ...THEMES.map(([t, label]) => ({
      id: `theme.${t}`,
      title: `테마: ${label}`,
      category: "앱",
      keywords: ["theme", "dark", "light", "다크 모드", "색"],
      checked: () => prefs.get().theme === t,
      run: () => prefs.set({ theme: t }),
    })),
    {
      id: "app.experimental",
      title: "실험 기능 보이기",
      category: "앱",
      keywords: ["experimental", "beta", "ai"],
      checked: () => prefs.get().showExperimental,
      run: () => prefs.set({ showExperimental: !prefs.get().showExperimental }),
    },
    { id: "export.stl", title: "3D를 STL로 저장 (3D 프린팅)", category: "내보내기", keywords: ["stl", "export", "3d print"], run: () => export3D("stl") },
    { id: "export.step", title: "3D를 STEP으로 저장 (CAD)", category: "내보내기", keywords: ["step", "stp", "export", "cad"], run: () => export3D("step") },
    {
      id: "ai.review",
      title: "AI 설계 검토 (실험)",
      category: "검사",
      keywords: ["ai", "claude", "review", "검토"],
      checked: aiBusy,
      run: () => needExp() && toggleAiReview(),
    },
  ];
}
