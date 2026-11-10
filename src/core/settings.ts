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
  /** 새 문서의 길이 단위 (지금 문서는 상태 표시줄 단추로) */
  units: "mm" | "inch";
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
  /** 설치형 앱: DWG 변환기(ODA File Converter) 위치 — 비우면 자동으로 찾음 */
  odaPath: string;
  /** DWG 버전 (ACAD2018 …) */
  dwgVersion: string;
  /** 설치형 앱: 최근 연·저장한 파일 경로 */
  recentFiles: string[];
}

export const DWG_VERSION_IDS = ["ACAD2018", "ACAD2013", "ACAD2010", "ACAD2007", "ACAD2004", "ACAD2000"];

export const PANEL_MIN = 170;
export const PANEL_MAX = 560;
export const GRIDS = [0.1, 0.5, 1, 5, 10];
/** inch 문서의 격자 (mm 값): 0.05" 0.1" 1/8" 1/4" 1" */
export const INCH_GRIDS = [1.27, 2.54, 3.175, 6.35, 25.4];
const INCH_LABEL: Record<string, string> = { "1.27": '0.05"', "2.54": '0.1"', "3.175": '1/8"', "6.35": '1/4"', "25.4": '1"' };
export const gridsFor = (u: "mm" | "inch") => (u === "inch" ? INCH_GRIDS : GRIDS);
export const gridLabel = (g: number) => INCH_LABEL[String(g)] ?? `${g} mm`;
/** 단위의 격자 목록에서 가장 가까운 것 (비율로) */
export function nearestGrid(g: number, u: "mm" | "inch"): number {
  const list = gridsFor(u);
  return list.reduce((a, b) => (Math.abs(Math.log(b / g)) < Math.abs(Math.log(a / g)) ? b : a), list[0]);
}

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
    odaPath: "",
    dwgVersion: "ACAD2018",
    recentFiles: [],
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
    units: raw.units === "inch" ? "inch" : "mm",
    grid: GRIDS.includes(raw.grid as number) || INCH_GRIDS.includes(raw.grid as number) ? (raw.grid as number) : d.grid,
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
    odaPath: typeof raw.odaPath === "string" ? raw.odaPath : "",
    dwgVersion: DWG_VERSION_IDS.includes(raw.dwgVersion as string) ? (raw.dwgVersion as string) : "ACAD2018",
    recentFiles: Array.isArray(raw.recentFiles) ? raw.recentFiles.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
  };
}

/** 최근 쓴 명령 목록 갱신 (앞으로, 중복 없이, 최대 20개) */
export function pushRecent(recent: string[], id: string, max = 20): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max);
}
