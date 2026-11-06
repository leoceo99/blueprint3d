/**
 * 앱으로 설치(PWA)와 오프라인: 서비스 워커 등록, 새 버전 알림, 설치 버튼.
 * 개발 서버(npm run dev)에서는 켜지 않는다 (파일이 계속 바뀌므로).
 */
export interface PwaHooks {
  /** 새 버전이 준비됨: apply()를 부르면 바꾸고 새로 고침 */
  onUpdate: (apply: () => void) => void;
  /** 처음으로 오프라인 준비가 끝남 */
  onOfflineReady: () => void;
  /** 설치할 수 있음: install()을 부르면 설치 창 */
  onInstallable: (install: () => Promise<boolean>) => void;
  onInstalled: () => void;
}

export function setupPWA(h: PwaHooks) {
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();
    const ev = e as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    h.onInstallable(async () => {
      await ev.prompt();
      return (await ev.userChoice).outcome === "accepted";
    });
  });
  window.addEventListener("appinstalled", () => h.onInstalled());
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // 처음 설치할 때가 아니라, 새 버전으로 바꿀 때만 새로 고침
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      const check = () => {
        if (reg.waiting && navigator.serviceWorker.controller) h.onUpdate(() => reg.waiting?.postMessage("skipWaiting"));
      };
      check();
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") check();
          if (w.state === "activated" && !hadController) h.onOfflineReady();
        });
      });
      // 켜 둔 채로 오래 쓰면 한 시간마다 새 버전 확인
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    })
    .catch(() => {
      /* 서비스 워커를 쓸 수 없는 환경 */
    });
}
