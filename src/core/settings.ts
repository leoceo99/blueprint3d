/**
 * 앱 설정 (이 컴퓨터에만 저장): 테마, 언어, 격자, 단축키 바꾼 것, 실험 기능, 패널 배치, 최근 쓴 명령.
 * 저장된 값이 깨져 있어도 기본값으로 채워서 읽는다.
 */
import { normalizeCombo } from "./keys";

export type Theme = "system" | "light" | "dark";

export interface PanelLayout {
  left: number;
  right: number;
  leftOpen: boolean;
  rightOpen: boolean;
  /** 왼쪽·오른쪽 패널 자리 바꾸기 */
  swapped: boolean;
}

export interface Settings {
  theme: Theme;
  language: "ko" | "en";
  /** 길이 단위 — 지금은 mm만 (inch는 10단계) */
  units: "mm";
  /** 처음 격자 (mm) */
  grid: number;
  /** 바꾼 단축키: 명령 id → 조합들 (빈 배열이면 단축키 없음) */
  keys: Record<string, string[]>;
  showExperimental: boolean;
  /** 개발자: 예제 작업 공간 보이기 */
  devExample: boolean;
  layout: PanelLayout;
  /** 최근 쓴 명령 (명령 찾기에서 위로) */
  recent: string[];
}

export const PANEL_MIN = 170;
export const PANEL_MAX = 560;
export const GRIDS = [0.1, 0.5, 1, 5, 10];

export function defaultSettings(): Settings {
  return {
    theme: "system",
    language: "ko",
    units: "mm",
    grid: 1,
    keys: {},
    showExperimental: true,
    devExample: false,
    layout: { left: 230, right: 340, leftOpen: true, rightOpen: true, swapped: false },
    recent: [],
  };
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!obj(raw)) return d;
  const keys: Record<string, string[]> = {};
  if (obj(raw.keys))
    for (const [id, list] of Object.entries(raw.keys)) {
      if (!Array.isArray(list)) continue;
      keys[id] = [...new Set(list.map((k) => (typeof k === "string" ? normalizeCombo(k) : null)).filter((k): k is string => !!k))];
    }
  const l = obj(raw.layout) ? raw.layout : {};
  return {
    theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
    language: raw.language === "en" ? "en" : "ko",
    units: "mm",
    grid: GRIDS.includes(raw.grid as number) ? (raw.grid as number) : d.grid,
    keys,
    showExperimental: raw.showExperimental !== false,
    devExample: raw.devExample === true,
    layout: {
      left: clamp(l.left, PANEL_MIN, PANEL_MAX, d.layout.left),
      right: clamp(l.right, PANEL_MIN, PANEL_MAX, d.layout.right),
      leftOpen: l.leftOpen !== false,
      rightOpen: l.rightOpen !== false,
      swapped: l.swapped === true,
    },
    recent: Array.isArray(raw.recent) ? raw.recent.filter((x): x is string => typeof x === "string").slice(0, 20) : [],
  };
}

/** 최근 쓴 명령 목록 갱신 (앞으로, 중복 없이, 최대 20개) */
export function pushRecent(recent: string[], id: string, max = 20): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max);
}
