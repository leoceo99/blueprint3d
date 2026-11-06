/**
 * 여러 탭에서 같은 프로젝트를 열었는지 알아채기 (BroadcastChannel).
 * 같은 프로젝트를 두 탭에서 고치면 나중에 저장한 쪽이 앞의 것을 덮으므로 경고한다.
 */
type Msg = { t: "hello" | "here" | "saved" | "bye"; tab: string; id: string };

const tab = Math.random().toString(36).slice(2, 10);
const ch: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("blueprint3d") : null;

export function initTabs(opts: { currentId: () => string; onDuplicate: () => void; onRemoteSaved: () => void }) {
  if (!ch) return { announce() {}, saved() {} };
  ch.onmessage = (ev: MessageEvent<Msg>) => {
    const m = ev.data;
    if (!m || m.tab === tab || m.id !== opts.currentId()) return;
    if (m.t === "hello") {
      ch.postMessage({ t: "here", tab, id: m.id } satisfies Msg);
      opts.onDuplicate();
    } else if (m.t === "here") opts.onDuplicate();
    else if (m.t === "saved") opts.onRemoteSaved();
  };
  window.addEventListener("pagehide", () => ch.postMessage({ t: "bye", tab, id: opts.currentId() } satisfies Msg));
  return {
    /** 이 탭에서 이 프로젝트를 열었다고 알림 */
    announce() {
      ch.postMessage({ t: "hello", tab, id: opts.currentId() } satisfies Msg);
    },
    /** 이 탭에서 저장했다고 알림 */
    saved() {
      ch.postMessage({ t: "saved", tab, id: opts.currentId() } satisfies Msg);
    },
  };
}
