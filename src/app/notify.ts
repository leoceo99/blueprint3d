/** 알림: 잠깐 뜨는 토스트, 오래 남는 알림(버튼 포함) */
import { $ } from "./dom";

let toastTimer = 0;
export function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2800);
}

export type NoticeAction = { label: string; run: () => unknown };

/** 오래 남는 알림 (새 버전, 다른 탭, 저장 문제). key가 같으면 앞의 것을 바꾼다 */
export function notice(text: string, actions: NoticeAction[] = [], kind: "info" | "warn" | "err" = "info", key?: string) {
  const host = $("#notices");
  if (key) closeNotice(key);
  const el = document.createElement("div");
  el.className = `notice ${kind}`;
  if (key) el.dataset.key = key;
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.onclick = () => {
      el.remove();
      void a.run();
    };
    el.append(b);
  }
  const x = document.createElement("button");
  x.className = "ghost";
  x.textContent = "✕";
  x.title = "닫기";
  x.onclick = () => el.remove();
  el.append(x);
  host.append(el);
}

export function closeNotice(key: string) {
  $("#notices").querySelector(`[data-key="${key}"]`)?.remove();
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "");
export const isQuota = (e: unknown) => e instanceof DOMException && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
