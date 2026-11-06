/** 앱 껍데기: 앱으로 설치·새 버전 알림(PWA), 오프라인 표시, 예상하지 못한 오류 알림 */
import { setupPWA } from "../pwa";
import type { Command } from "./commands";
import { $ } from "./dom";
import { errText, notice, toast } from "./notify";
import { session } from "./projects";

let installApp: (() => Promise<boolean>) | null = null;

export function initShell() {
  setupPWA({
    onUpdate: (apply) =>
      notice(
        "새 버전이 준비됐어요.",
        [
          {
            label: "지금 업데이트",
            run: async () => {
              await session.flush();
              apply();
            },
          },
        ],
        "info",
        "update",
      ),
    onOfflineReady: () => toast("이제 인터넷 없이도 쓸 수 있어요 (3D 엔진까지 이 컴퓨터에 저장됨)."),
    onInstallable: (install) => {
      installApp = install;
      $("#installItem").hidden = false;
    },
    onInstalled: () => {
      installApp = null;
      $("#installItem").hidden = true;
      toast("앱으로 설치했어요. 바탕화면이나 시작 메뉴에서 열 수 있어요.");
    },
  });

  const netState = $("#netState");
  const updateNet = () => (netState.hidden = navigator.onLine);
  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);
  updateNet();

  window.addEventListener("error", (e) => reportCrash(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => reportCrash(e.reason));
}

let lastCrash = 0;
function reportCrash(e: unknown) {
  const m = errText(e) || String(e ?? "");
  if (!m || /ResizeObserver loop|AbortError|aborted/i.test(m)) return;
  console.error(e);
  const now = Date.now();
  if (now - lastCrash < 8000) return;
  lastCrash = now;
  notice(
    `예상하지 못한 문제가 생겼어요: ${m.slice(0, 140)}. 작업은 자동 저장돼 있으니, 이상하면 새로 고침 하세요.`,
    [{ label: "새로 고침", run: () => session.flush().then(() => location.reload()) }],
    "err",
    "crash",
  );
}

export const shellCommands = (): Command[] => [
  {
    id: "app.install",
    title: "앱으로 설치",
    category: "앱",
    keywords: ["install", "pwa", "offline", "오프라인"],
    enabled: () => !!installApp,
    run: async () => {
      if (installApp && (await installApp())) $("#installItem").hidden = true;
    },
  },
];
