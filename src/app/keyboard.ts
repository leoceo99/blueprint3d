/**
 * 단축키: 모든 키 입력을 명령으로 바꾼다.
 * 순서: 창이 떠 있으면 무시 → 글 입력 중이면 Ctrl 조합(global)만 → 그리던 도형의 숫자 입력 → 명령
 */
import { Modal } from "../ui/modal";
import { ui } from "../ui/state";
import { app, commands } from "./context";
import { isTyping } from "./dom";

/** 다른 대화창(설정, 가져오기 등)이 열려 있는지 — main에서 알려 준다 */
let blocked: () => boolean = () => false;
export function setKeyboardBlocker(fn: () => boolean) {
  blocked = fn;
}

/** 단축키 바꾸기 창이 키를 받는 중이면 여기로 */
let capture: ((e: KeyboardEvent) => void) | null = null;
export function captureNextKey(fn: ((e: KeyboardEvent) => void) | null) {
  capture = fn;
}

export function initKeyboard() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!capture) return;
      e.preventDefault();
      e.stopPropagation();
      capture(e);
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || blocked() || Modal.anyOpen()) return;
    const typing = isTyping();
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    // 그리는 중의 숫자 입력·Enter·Backspace (2D 설계)
    if (!typing && !mod && app.workspace === "design" && app.board.panes[ui.activeView].handleKey(e)) {
      e.preventDefault();
      return;
    }
    const c = commands.match(e, typing);
    if (!c) return;
    e.preventDefault();
    commands.run(c.id);
  });
}
