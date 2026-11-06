/**
 * 패널 배치: 왼쪽(트리·변수)·오른쪽(속성·검사) 패널의 너비 조절(경계 끌기), 접기·펴기(경계 두 번 클릭 또는 Ctrl+B),
 * 좌우 바꾸기. 배치는 설정에 저장되어 새로 고침 뒤에도 그대로.
 */
import { PANEL_MAX, PANEL_MIN, type PanelLayout } from "../core/settings";
import type { Command } from "./commands";
import { app, on } from "./context";
import { $ } from "./dom";
import { prefs } from "./prefs";

const L = () => prefs.get().layout;
const setL = (patch: Partial<PanelLayout>) => prefs.set({ layout: { ...L(), ...patch } });

export function initLayout() {
  const ws = $("#ws-main");
  const left = ws.querySelector<HTMLElement>(".panel.left")!;
  const right = ws.querySelector<HTMLElement>(".panel.right")!;
  const stage = ws.querySelector<HTMLElement>(".stage")!;
  const sLeft = splitter("left");
  const sRight = splitter("right");
  left.after(sLeft);
  stage.after(sRight);
  apply();
  on("settings", apply);

  function apply() {
    const l = L();
    ws.classList.toggle("swapped", l.swapped);
    left.style.width = `${l.left}px`;
    right.style.width = `${l.right}px`;
    left.hidden = !l.leftOpen;
    right.hidden = !l.rightOpen;
    sLeft.classList.toggle("closed", !l.leftOpen);
    sRight.classList.toggle("closed", !l.rightOpen);
    sLeft.title = l.leftOpen ? "끌어서 너비 조절 · 두 번 클릭: 접기" : "눌러서 펴기";
    sRight.title = l.rightOpen ? "끌어서 너비 조절 · 두 번 클릭: 접기" : "눌러서 펴기";
    // 제도판·3D 화면 크기가 바뀌었으니 다시 맞춘다
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function splitter(side: "left" | "right") {
    const s = document.createElement("div");
    s.className = `splitter ${side}`;
    s.setAttribute("role", "separator");
    s.innerHTML = `<span class="grip"></span>`;
    s.addEventListener("dblclick", () => toggle(side));
    s.addEventListener("pointerdown", (e) => {
      const key = side === "left" ? "leftOpen" : "rightOpen";
      if (!L()[key]) {
        toggle(side);
        return;
      }
      e.preventDefault();
      s.setPointerCapture(e.pointerId);
      const panel = side === "left" ? left : right;
      const start = e.clientX;
      const w0 = panel.getBoundingClientRect().width;
      // 화면에서 패널이 splitter의 왼쪽에 있는지 (좌우를 바꾸면 반대)
      const panelOnLeft = (side === "left") !== L().swapped;
      s.classList.add("drag");
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start;
        const w = Math.min(PANEL_MAX, Math.max(PANEL_MIN, w0 + (panelOnLeft ? dx : -dx)));
        panel.style.width = `${w}px`;
      };
      const up = () => {
        s.classList.remove("drag");
        s.removeEventListener("pointermove", move);
        s.removeEventListener("pointerup", up);
        setL({ [side]: Math.round(panel.getBoundingClientRect().width) } as Partial<PanelLayout>);
      };
      s.addEventListener("pointermove", move);
      s.addEventListener("pointerup", up);
    });
    return s;
  }
}

function toggle(side: "left" | "right") {
  const key = side === "left" ? "leftOpen" : "rightOpen";
  setL({ [key]: !L()[key] } as Partial<PanelLayout>);
}

const onMain = () => app.workspace === "design" || app.workspace === "3d";
export const layoutCommands = (): Command[] => [
  { id: "layout.left", title: "왼쪽 패널 접기 · 펴기 (트리·변수)", category: "화면 배치", keywords: ["panel", "sidebar", "tree"], keys: ["Ctrl+B"], global: true, when: onMain, checked: () => L().leftOpen, run: () => toggle("left") },
  { id: "layout.right", title: "오른쪽 패널 접기 · 펴기 (속성·검사)", category: "화면 배치", keywords: ["panel", "properties"], keys: ["Ctrl+Alt+B"], global: true, when: onMain, checked: () => L().rightOpen, run: () => toggle("right") },
  { id: "layout.swap", title: "왼쪽 · 오른쪽 패널 자리 바꾸기", category: "화면 배치", keywords: ["swap", "panel"], checked: () => L().swapped, run: () => setL({ swapped: !L().swapped }) },
  {
    id: "layout.reset",
    title: "패널 배치 처음대로",
    category: "화면 배치",
    keywords: ["reset", "layout"],
    run: () => setL({ left: 230, right: 340, leftOpen: true, rightOpen: true, swapped: false }),
  },
];
