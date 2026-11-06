/**
 * 화면의 버튼·메뉴를 명령에 잇는다: data-cmd="명령 id"인 요소는
 *  - 누르면 그 명령을 실행하고
 *  - 안의 <kbd>와 마우스를 올렸을 때 설명에 지금 단축키를 보여 주고 (단축키를 바꾸면 같이 바뀜)
 *  - 쓸 수 없으면 흐리게, 켜진 상태면 강조한다
 */
import { formatCombo } from "../core/keys";
import { commands } from "./context";

/** 요소 하나 잇기 (다시 불러도 한 번만) */
export function bindCommandEl(el: HTMLElement) {
  if (el.dataset.cmdBound) return;
  el.dataset.cmdBound = "1";
  el.addEventListener("click", (e) => {
    const id = el.dataset.cmd!;
    // 메뉴 안이면 메뉴를 닫고
    const dd = el.closest(".dropdown") as HTMLElement | null;
    if (dd) dd.hidden = true;
    void e;
    commands.run(id);
  });
  labelEl(el);
}

export function bindCommands(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-cmd]").forEach(bindCommandEl);
}

function labelEl(el: HTMLElement) {
  const id = el.dataset.cmd!;
  const c = commands.get(id);
  if (!c) return;
  const keys = commands.keysOf(id);
  const kbd = el.querySelector("kbd");
  if (kbd) {
    const inMenu = !!el.closest(".dropdown");
    kbd.textContent = keys[0] ? formatCombo(keys[0], inMenu ? "long" : "short") : "";
    kbd.hidden = !keys[0];
  }
  const base = (el.dataset.titleBase ??= el.title || c.title);
  el.title = keys.length ? `${base} (${keys.map((k) => formatCombo(k)).join(", ")})` : base;
}

/** 단축키 표시 다시 (단축키를 바꿨을 때) */
export function relabelCommands(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-cmd]").forEach(labelEl);
}

/** 쓸 수 있는지·켜졌는지 다시 표시 (화면을 다시 그릴 때마다) */
export function refreshCommandStates(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-cmd]").forEach((el) => {
    const c = commands.get(el.dataset.cmd!);
    if (!c) return;
    if (el instanceof HTMLButtonElement && !el.dataset.noDisable) el.disabled = !commands.enabled(c);
    if (c.checked) el.classList.toggle(el.dataset.activeClass ?? "active", !!c.checked());
  });
}

commands.onChange(() => {
  if (typeof document !== "undefined") relabelCommands();
});
