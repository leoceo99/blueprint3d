/** 실행 취소 기록 창: 지금까지 한 일을 순서대로 보고, 누르면 그 시점으로 건너뛴다 */
import { relativeTime } from "../core/versions";
import { store } from "../store";
import { h, Modal } from "../ui/modal";

let m: Modal | null = null;

export function openHistory() {
  m ??= new Modal("실행 취소 기록");
  m.show();
  render();
  const unsub = store.subscribe(() => m?.isOpen && render());
  m.onClose = () => unsub();
}

function render() {
  if (!m) return;
  const b = m.body;
  b.innerHTML = "";
  const hist = store.history;
  const list = hist.entries;
  const pos = hist.position;
  const now = Date.now();
  const kb = Math.max(1, Math.round(hist.bytes / 1024));
  b.append(
    h("p", { textContent: `누르면 그 단계로 돌아가요 (뒤의 단계는 ‘다시 실행’으로 남아요). 기록 ${list.length}개 · 약 ${kb} KB — 바뀐 곳만 저장해서 큰 부품도 가벼워요.` }, "muted small"),
  );
  const ol = h("div", {}, "hist-list");
  const row = (i: number, label: string, time: string, state: "done" | "cur" | "undone") => {
    const r = h("button", {}, `hist-row ${state}`, [h("span", { textContent: i === 0 ? "◎" : String(i) }, "hist-n"), h("span", { textContent: label }, "hist-label"), h("span", { textContent: time }, "muted small")]);
    r.onclick = () => {
      store.goto(i);
    };
    return r;
  };
  ol.append(row(0, "처음 (이 프로젝트를 연 때)", "", pos === 0 ? "cur" : "done"));
  list.forEach((e, k) => {
    const i = k + 1;
    ol.append(row(i, e.label, relativeTime(e.time, now), i === pos ? "cur" : i < pos ? "done" : "undone"));
  });
  b.append(ol);
  // 지금 위치가 보이게
  requestAnimationFrame(() => ol.querySelector(".cur")?.scrollIntoView({ block: "nearest" }));
}
