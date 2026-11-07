/**
 * 앱 전체가 같이 쓰는 것: 지금 상태(3D 결과, 검사 결과, 작업 공간), 명령 목록, 화면 갱신, 이벤트.
 * 각 모듈은 init()에서 자기 할 일을 등록하고, 서로를 직접 부르기보다 여기의 이벤트·명령으로 잇는다.
 */
import type { Sheet } from "../core/sheet";
import type { BuildResult, Finding } from "../core/types";
import { store } from "../store";
import type { DraftBoard } from "../ui/board";
import { ui } from "../ui/state";
import type { LazyViewer } from "./lazyViewer";
import { CommandRegistry } from "./commands";

export interface AiState {
  summary: string;
  findings: Finding[];
  version: number;
  loading: boolean;
  error?: string;
}

export const app = {
  board: null as unknown as DraftBoard,
  viewer: null as unknown as LazyViewer,
  /** 마지막 3D 결과 (없으면 null) */
  lastBuild: null as BuildResult | null,
  buildError: undefined as string | undefined,
  /** 3D가 새로 만들어질 때마다 1씩 */
  buildStamp: 0,
  lastSheet: null as Sheet | null,
  ruleFindings: [] as Finding[],
  ai: null as AiState | null,
  /** 지금 작업 공간 id */
  workspace: "design",
};

/** 앱의 모든 명령 */
export const commands = new CommandRegistry();

// ---------------- 이벤트 ----------------
type EventMap = {
  /** 3D 만들기가 끝남 (성공·실패 모두) */
  built: void;
  /** 작업 공간이 바뀜 */
  workspace: string;
  /** 다른 프로젝트로 바뀜 */
  switched: void;
  /** 설정이 바뀜 */
  settings: void;
};
const handlers: { [K in keyof EventMap]?: ((v: EventMap[K]) => void)[] } = {};
export function on<K extends keyof EventMap>(name: K, fn: (v: EventMap[K]) => void) {
  (handlers[name] ??= [] as never[]).push(fn as never);
}
export function emit<K extends keyof EventMap>(name: K, ...[v]: EventMap[K] extends void ? [] : [EventMap[K]]) {
  for (const fn of handlers[name] ?? []) (fn as (x: unknown) => void)(v);
}

// ---------------- 화면 갱신 (프레임당 한 번) ----------------
const frameFns: (() => void)[] = [];
const panelFns: (() => void)[] = [];
let rafPending = false;
let panelKey = "";

/** 매 갱신마다 (제도판, 상태 표시줄처럼 가벼운 것) */
export function onFrame(fn: () => void) {
  frameFns.push(fn);
}
/** 내용이 바뀌었을 때만 (트리, 속성, 검사 목록처럼 무거운 것) */
export function onPanels(fn: () => void) {
  panelFns.push(fn);
}
/** 패널을 꼭 다시 그리게 */
export function invalidatePanels() {
  panelKey = "";
  requestRender();
}

export function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const f of frameFns) f();
    const key = [
      app.workspace,
      store.version,
      `${ui.sel?.view}:${ui.sel?.id}`,
      `${ui.selCons?.id}`,
      ui.tool,
      ui.consKind,
      ui.findings.map((f) => f.id).join(","),
      ui.activeView,
      app.ai?.loading,
      app.ai?.version,
      app.buildStamp,
    ].join("|");
    if (key !== panelKey) {
      panelKey = key;
      for (const f of panelFns) f();
    }
  });
}
