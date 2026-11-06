/** 화면 요소를 다루는 작은 도우미들 */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (cls) e.className = cls;
  return e;
}

/** 속성 패널 왼쪽 칸 (이름) */
export const keyCell = (text: string) => el("span", { textContent: text }, "k");

/** 입력 칸에 글을 쓰는 중인지 */
export function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}

/** 입력 중인 칸이 있으면 먼저 반영 (프로젝트를 바꾸기 전에) */
export function commitTyping() {
  if (isTyping()) (document.activeElement as HTMLElement).blur();
}
