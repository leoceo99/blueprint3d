/**
 * 단축키 조합 다루기: 키 입력 → "Ctrl+Shift+Z" 같은 정해진 글자, 사용자가 적은 글자 → 같은 형식, 화면 표시.
 * 글자 키는 e.code(자판 위치)로 읽어서 한글 입력 상태에서도 Ctrl+Z, V, R 같은 단축키가 그대로 동작한다.
 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const MODS = ["Ctrl", "Alt", "Shift"] as const;

const CODE_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};

/** 이름 있는 키 (소문자 → 정식 이름) */
const NAMED: Record<string, string> = {
  delete: "Delete",
  del: "Delete",
  backspace: "Backspace",
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  " ": "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = `F${i}`;

const MOD_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS", "Hyper", "Super"]);

function baseKey(e: KeyLike): string | null {
  const code = e.code ?? "";
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (m) return m[1];
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  const k = e.key;
  if (!k || MOD_KEYS.has(k) || k === "Process" || k === "Unidentified" || k === "Dead") return null;
  if (NAMED[k.toLowerCase()]) return NAMED[k.toLowerCase()];
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/** 키 입력 → "Ctrl+Shift+Z". 수정 키만 눌렀으면 null. Mac의 ⌘는 Ctrl로 본다 */
export function keyOf(e: KeyLike): string | null {
  const b = baseKey(e);
  if (!b) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(b);
  return parts.join("+");
}

/** 사람이 적은 조합("ctrl+shift+z", "Del")을 정식 형식으로. 잘못되면 null */
export function normalizeCombo(s: string): string | null {
  const raw = s.trim();
  if (!raw) return null;
  // "Ctrl++" 처럼 + 키 자체는 마지막 토큰
  const tokens = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const mods = new Set<string>();
  let key: string | null = null;
  for (const t0 of tokens) {
    const t = t0.trim();
    if (!t) return null;
    const l = t.toLowerCase();
    if (l === "ctrl" || l === "control" || l === "cmd" || l === "meta" || l === "⌘" || l === "⌃") mods.add("Ctrl");
    else if (l === "alt" || l === "option" || l === "opt" || l === "⌥") mods.add("Alt");
    else if (l === "shift" || l === "⇧") mods.add("Shift");
    else {
      if (key) return null;
      key = NAMED[l] ?? (t.length === 1 ? t.toUpperCase() : /^f\d{1,2}$/i.test(t) ? t.toUpperCase() : t);
    }
  }
  if (!key) return null;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

const SHORT: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Delete: "Del", Backspace: "⌫", Escape: "Esc", Enter: "↵", Space: "␣" };

/** 표시용: long "Ctrl+Shift+Z", short "⌃⇧Z" (리본처럼 좁은 곳) */
export function formatCombo(c: string, style: "long" | "short" = "long"): string {
  if (style === "long") return c.replace("Escape", "Esc").replace("Delete", "Del");
  const parts = c.endsWith("++") ? [...c.slice(0, -2).split("+"), "+"] : c.split("+");
  return parts.map((p) => SHORT[p] ?? p).join("");
}

/** 수정 키가 없거나 Shift만 있는 글자 키: 글을 입력하는 중에는 쓰면 안 되는 단축키 */
export function isPlainKey(c: string): boolean {
  const parts = c.split("+");
  return !parts.includes("Ctrl") && !parts.includes("Alt") && !/^F\d+$/.test(parts[parts.length - 1]);
}
