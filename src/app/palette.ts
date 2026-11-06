/**
 * 명령 찾기 (Ctrl+K): 이름으로 아무 기능이나 찾아 실행한다.
 * 한글 초성(ㅅㄱㅎ → 사각형), 영어(undo), 띄어쓰기 없이도 찾는다. 최근 쓴 명령이 위로.
 */
import { formatCombo } from "../core/keys";
import { h, Modal } from "../ui/modal";
import type { Command } from "./commands";
import { commands } from "./context";
import { prefs } from "./prefs";

let m: Modal | null = null;
let input: HTMLInputElement;
let listEl: HTMLDivElement;
let results: Command[] = [];
let index = 0;

export function openPalette(initial = "") {
  if (!m) build();
  m!.show();
  input.value = initial;
  update();
  input.focus();
  input.select();
}

function build() {
  m = new Modal("명령 찾기");
  (m.root.firstElementChild as HTMLElement).classList.add("palette");
  input = h("input", { type: "text", placeholder: "무엇을 할까요? (예: 사각형, ㄷㅁ, undo, 인쇄)", spellcheck: false, autocomplete: "off" }, "pal-input");
  input.setAttribute("aria-label", "명령 찾기");
  listEl = h("div", { role: "listbox" }, "pal-list");
  m.body.append(input, listEl, h("div", { innerHTML: "<kbd>↑</kbd><kbd>↓</kbd> 고르기 · <kbd>Enter</kbd> 실행 · <kbd>Esc</kbd> 닫기" }, "pal-foot muted small"));
  input.oninput = () => {
    index = 0;
    update();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!e.isComposing) runAt(index);
    }
  };
}

function update() {
  results = commands.search(input.value, prefs.get().recent).slice(0, 60);
  index = Math.min(index, Math.max(0, results.length - 1));
  paint();
}

function paint() {
  listEl.innerHTML = "";
  if (!results.length) {
    listEl.append(h("p", { textContent: "찾는 명령이 없어요." }, "muted pal-empty"));
    return;
  }
  const recent = prefs.get().recent;
  const empty = !input.value.trim();
  results.forEach((c, i) => {
    const ok = commands.enabled(c);
    const keys = commands.keysOf(c.id);
    const row = h("div", { role: "option" }, "pal-row" + (i === index ? " on" : "") + (ok ? "" : " off"), [
      h("span", { textContent: c.checked?.() ? "✓" : "" }, "pal-check"),
      h("span", { textContent: c.title }, "pal-title"),
      h("span", { textContent: empty && recent.includes(c.id) ? "최근" : c.category }, "pal-cat"),
      ...(keys[0] ? [h("kbd", { textContent: formatCombo(keys[0]) })] : []),
    ]);
    if (!ok) row.title = commands.available(c) ? "지금은 쓸 수 없어요 (예: 선택한 도형이 없음)" : "다른 화면에서 쓰는 명령이에요";
    row.onmousemove = () => {
      if (index !== i) {
        index = i;
        for (const [k, el] of [...listEl.children].entries()) el.classList.toggle("on", k === i);
      }
    };
    row.onclick = () => runAt(i);
    listEl.append(row);
  });
  listEl.children[index]?.scrollIntoView({ block: "nearest" });
}

function runAt(i: number) {
  const c = results[i];
  if (!c) return;
  if (!commands.enabled(c)) {
    input.classList.add("shake");
    setTimeout(() => input.classList.remove("shake"), 300);
    return;
  }
  m!.close();
  // 창이 닫힌 뒤 실행 (초점·단축키가 앱으로 돌아오게)
  setTimeout(() => commands.run(c.id));
}
