/**
 * 위쪽 메뉴 (파일 · 편집 · 보기): 누르면 열리고, 하나가 열린 채로 다른 메뉴에 마우스를 올리면 그쪽으로.
 * 편집·보기 메뉴는 명령 목록으로 만든다 (단축키 표시도 명령에서).
 */
import { workspaces } from "../workspaces/registry";
import { bindCommandEl, refreshCommandStates } from "./commandUI";
import { commands, on } from "./context";
import { $, $$ } from "./dom";

const EDIT = [
  "edit.undo", "edit.redo", "edit.history", "-",
  "edit.delete", "edit.duplicate", "edit.toggleHole", "-",
  "edit.centerH", "edit.centerV", "edit.straighten", "-",
  "params.add", "-",
  "doc.addPart", "doc.duplicatePart", "doc.renamePart", "doc.deletePart", "doc.addDrawing", "file.import3dAsPart", "-",
  "app.palette", "app.settings",
];
const VIEW = () => [
  ...workspaces().map((w) => `ws.${w.id}`),
  "-",
  "view.fit",
  "view.focus.front",
  "view.focus.top",
  "view.focus.side",
  "-",
  "snap.grid",
  "snap.align",
  "view.result",
  "view.underlay",
  "-",
  "layout.left",
  "layout.right",
  "layout.swap",
  "layout.reset",
  "-",
  "theme.system",
  "theme.light",
  "theme.dark",
];

function fill(menu: HTMLElement, ids: string[]) {
  menu.innerHTML = "";
  for (const id of ids) {
    if (id === "-") {
      if (menu.lastElementChild && menu.lastElementChild.tagName !== "HR") menu.append(document.createElement("hr"));
      continue;
    }
    const c = commands.get(id);
    if (!c) continue;
    const b = document.createElement("button");
    b.dataset.cmd = id;
    b.dataset.activeClass = "checked";
    b.innerHTML = `<span class="mi-check"></span><span class="mi-title"></span><kbd></kbd>`;
    (b.querySelector(".mi-title") as HTMLElement).textContent = c.title;
    menu.append(b);
    bindCommandEl(b);
  }
}

export function initMenus() {
  const buttons = $$<HTMLButtonElement>("[data-menu]");
  const menuOf = (b: HTMLElement) => $(`#menu-${b.dataset.menu}`);
  const closeAll = () => buttons.forEach((b) => (menuOf(b).hidden = true));
  /** 넘치면 옆으로 미는 도구 줄 안의 메뉴(dd-right)는 잘리지 않게 화면 기준으로, 단추 오른쪽 끝에 맞춰 */
  const place = (b: HTMLElement, m: HTMLElement) => {
    if (!m.classList.contains("dd-right")) return;
    const r = b.getBoundingClientRect();
    Object.assign(m.style, { position: "fixed", left: "auto", top: `${r.bottom + 4}px`, right: `${Math.max(4, window.innerWidth - r.right)}px` });
  };
  const refill = () => {
    fill($("#menu-edit"), EDIT);
    fill($("#menu-view"), VIEW());
    refreshCommandStates($("#menu-edit"));
    refreshCommandStates($("#menu-view"));
    refreshCommandStates($("#menu-file"));
    for (const b of buttons) if (b.dataset.menu !== "file" && b.dataset.menu !== "edit" && b.dataset.menu !== "view") refreshCommandStates(menuOf(b));
  };
  // 다른 메뉴가 열린 채로 마우스를 올려 열었으면, 바로 이어지는 클릭으로 닫히지 않게
  let hoverOpened: { b: HTMLElement; at: number } | null = null;
  for (const b of buttons) {
    b.onclick = (e) => {
      e.stopPropagation();
      const m = menuOf(b);
      if (hoverOpened?.b === b && performance.now() - hoverOpened.at < 600 && !m.hidden) return;
      const open = m.hidden;
      closeAll();
      if (open) refill();
      m.hidden = !open;
      if (open) place(b, m);
    };
    b.onmouseenter = () => {
      if (buttons.some((x) => !menuOf(x).hidden) && menuOf(b).hidden) {
        closeAll();
        refill();
        menuOf(b).hidden = false;
        place(b, menuOf(b));
        hoverOpened = { b, at: performance.now() };
      }
    };
  }
  document.addEventListener("click", (e) => {
    for (const b of buttons) if (!menuOf(b).contains(e.target as Node)) menuOf(b).hidden = true;
  });
  on("workspace", closeAll);
}
