/**
 * 작업 공간 모듈: 2D 설계 · 3D 보기 · 도면 출력처럼 자기 화면·도구·명령을 가진 묶음.
 * 새 작업 공간(예: 메쉬 편집, 조립)은 Workspace를 하나 만들어 registerWorkspace로 붙이면
 * 위쪽 탭, 숫자 단축키(1, 2, 3…), 명령 찾기에 자동으로 들어간다. 떼면 모두 빠진다.
 */
import type { Command } from "../app/commands";
import { app, commands, emit, requestRender } from "../app/context";
import { bindCommandEl } from "../app/commandUI";
import { $ } from "../app/dom";

export interface Workspace {
  id: string;
  title: string;
  /** 탭에 붙는 기호 */
  icon: string;
  /** 탭 순서 (작을수록 앞) */
  order: number;
  /** 탭에 마우스를 올리면 보이는 설명 */
  hint?: string;
  show(): void;
  hide(): void;
  /** 이 작업 공간의 명령 — 조건(when)을 안 주면 이 작업 공간에 있을 때만 단축키가 동작 */
  commands?: Command[];
}

const list = new Map<string, Workspace>();
const offs = new Map<string, () => void>();
let current: Workspace | null = null;

export const workspaces = () => [...list.values()].sort((a, b) => a.order - b.order);
export const currentWorkspace = () => current;

export function registerWorkspace(ws: Workspace): () => void {
  list.set(ws.id, ws);
  const cmds = (ws.commands ?? []).map((c) => (c.when ? c : { ...c, when: () => app.workspace === ws.id }));
  offs.set(ws.id, commands.register(cmds));
  refresh();
  return () => unregisterWorkspace(ws.id);
}

export function unregisterWorkspace(id: string) {
  const ws = list.get(id);
  if (!ws) return;
  if (current === ws) showWorkspace(workspaces().find((w) => w !== ws)?.id ?? "design");
  ws.hide();
  list.delete(id);
  offs.get(id)?.();
  offs.delete(id);
  refresh();
}

export function showWorkspace(id: string) {
  const next = list.get(id);
  if (!next) return;
  if (current && current !== next) current.hide();
  current = next;
  app.workspace = id;
  next.show();
  for (const b of $(".ws-tabs").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.ws === id);
  emit("workspace", id);
  requestRender();
}

/** 탭과 "작업 공간 바꾸기" 명령(숫자 단축키)을 다시 만든다 */
let switchOff: (() => void) | null = null;
function refresh() {
  const nav = $(".ws-tabs");
  nav.innerHTML = "";
  const ws = workspaces();
  ws.forEach((w) => {
    const b = document.createElement("button");
    b.dataset.ws = w.id;
    b.setAttribute("role", "tab");
    b.dataset.cmd = `ws.${w.id}`;
    b.textContent = `${w.icon} ${w.title}`;
    b.title = w.hint ?? w.title;
    b.classList.toggle("active", w.id === app.workspace);
    nav.append(b);
  });
  switchOff?.();
  switchOff = commands.register(
    ws.map((w, i) => ({
      id: `ws.${w.id}`,
      title: `${w.title} 화면으로`,
      category: "작업 공간",
      keywords: ["workspace", w.id, w.title],
      keys: i < 9 ? [String(i + 1)] : [],
      checked: () => app.workspace === w.id,
      run: () => showWorkspace(w.id),
    })),
  );
  nav.querySelectorAll<HTMLElement>("[data-cmd]").forEach(bindCommandEl);
}
