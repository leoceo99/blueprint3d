/**
 * 설정 읽고 쓰기 (localStorage). 바뀌면 "settings" 이벤트.
 */
import { defaultSettings, normalizeSettings, type Settings } from "../core/settings";
import { emit } from "./context";
import { toast } from "./notify";

const KEY = "blueprint3d.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
    // 7단계에서 따로 저장하던 ‘실험 기능 보이기’ 옮기기
    const s = defaultSettings();
    if (localStorage.getItem("blueprint3d.showExperimental") === "0") s.showExperimental = false;
    return s;
  } catch {
    return defaultSettings();
  }
}

let cur = load();

export const prefs = {
  get(): Settings {
    return cur;
  },
  set(patch: Partial<Settings>) {
    cur = normalizeSettings({ ...cur, ...patch });
    try {
      localStorage.setItem(KEY, JSON.stringify(cur));
    } catch {
      /* 저장 못 해도 이번에는 적용 */
    }
    emit("settings");
  },
};

// ---------------- 테마 ----------------
const mq = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : null;
/** 지금 어두운 화면인지 (시스템 설정 포함) */
export function isDark() {
  const t = cur.theme;
  return t === "dark" || (t === "system" && !!mq?.matches);
}
/** <html data-theme>를 설정에 맞게. CSS 색 변수가 따라 바뀐다 */
export function applyTheme() {
  const t = cur.theme;
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
export function onSystemTheme(fn: () => void) {
  mq?.addEventListener("change", fn);
}

// ---------------- 실험 기능 ----------------
export const expOn = () => cur.showExperimental;
export const applyExp = () => document.body.classList.toggle("no-exp", !expOn());
/** 실험 기능을 쓰려 할 때: 꺼져 있으면 알려 주고 false */
export function needExp() {
  if (expOn()) return true;
  toast("도면 이미지 인식과 AI는 실험 기능이에요. 설정(⚙)에서 ‘실험 기능 보이기’를 켜면 쓸 수 있어요.");
  return false;
}
