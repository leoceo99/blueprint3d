/**
 * 설정 화면: 일반(테마·언어·단위·격자), 화면 배치, 단축키 바꾸기, 실험 기능, 저장 공간, AI(실험), 개발자.
 * 키 저장 외에는 바꾸는 즉시 적용·저장된다.
 */
import { AI_MODEL, getApiKey, setApiKey } from "../aiKey";
import { formatCombo, keyOf } from "../core/keys";
import { GRIDS, type Theme } from "../core/settings";
import { h } from "../ui/modal";
import type { Command } from "./commands";
import { commands, on } from "./context";
import { $, $$ } from "./dom";
import { captureNextKey } from "./keyboard";
import { toast } from "./notify";
import { prefs } from "./prefs";
import { showStorage } from "./projects";

const dlg = () => $<HTMLDialogElement>("#settings");

export function openSettings(section?: string) {
  const d = dlg();
  $<HTMLInputElement>("#apiKey").value = getApiKey();
  sync();
  renderKeys();
  void showStorage();
  if (!d.open) d.showModal();
  if (section) requestAnimationFrame(() => d.querySelector(`[data-sec="${section}"]`)?.scrollIntoView({ block: "start" }));
}

export const settingsOpen = () => dlg().open;

function sync() {
  const s = prefs.get();
  $$<HTMLInputElement>('input[name="theme"]').forEach((r) => (r.checked = r.value === s.theme));
  $<HTMLSelectElement>("#setGrid").value = String(s.grid);
  $<HTMLInputElement>("#showExp").checked = s.showExperimental;
  $<HTMLInputElement>("#devExample").checked = s.devExample;
}

export function initSettings() {
  $("#aiModel").textContent = AI_MODEL;
  $("#settingsBtn").dataset.cmd = "app.settings";
  const grid = $<HTMLSelectElement>("#setGrid");
  grid.innerHTML = GRIDS.map((g) => `<option value="${g}">${g} mm</option>`).join("");
  $$<HTMLInputElement>('input[name="theme"]').forEach((r) => (r.onchange = () => r.checked && prefs.set({ theme: r.value as Theme })));
  grid.onchange = () => prefs.set({ grid: parseFloat(grid.value) });
  $<HTMLInputElement>("#showExp").onchange = (e) => prefs.set({ showExperimental: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>("#devExample").onchange = (e) => prefs.set({ devExample: (e.target as HTMLInputElement).checked });
  $("#saveKey").onclick = () => {
    setApiKey($<HTMLInputElement>("#apiKey").value.trim());
    toast(getApiKey() ? "API 키를 저장했습니다." : "API 키를 지웠습니다.");
  };
  $$<HTMLButtonElement>("[data-goto]").forEach((b) => (b.onclick = () => dlg().querySelector(`[data-sec="${b.dataset.goto}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })));
  $<HTMLInputElement>("#keyFilter").oninput = () => renderKeys();
  $("#keysReset").onclick = () => {
    if (!confirm("모든 단축키를 처음대로 되돌릴까요?")) return;
    prefs.set({ keys: {} });
    renderKeys();
  };
  // 설정 창의 배치 단추들도 명령으로
  bindLayoutButtons();
  dlg().addEventListener("close", () => {
    captureNextKey(null);
    editing = null;
  });
  on("settings", () => {
    if (dlg().open) sync();
  });
}

function bindLayoutButtons() {
  for (const b of $$<HTMLButtonElement>("#settings [data-run]"))
    b.onclick = () => {
      commands.run(b.dataset.run!);
    };
}

// ---------------- 단축키 ----------------
let editing: string | null = null;

function setKeys(id: string, keys: string[]) {
  const all = { ...prefs.get().keys };
  const def = commands.defaultKeys(id);
  if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete all[id];
  else all[id] = keys;
  prefs.set({ keys: all });
}

function assign(c: Command, combo: string) {
  // 같은 키를 쓰던 다른 명령에서는 뺀다
  for (const o of commands.conflicts(combo, c.id)) setKeys(o.id, commands.keysOf(o.id).filter((k) => k !== combo));
  setKeys(c.id, [combo]);
}

function renderKeys() {
  const box = $("#keyList");
  if (!box) return;
  box.innerHTML = "";
  const q = $<HTMLInputElement>("#keyFilter").value.trim();
  const list = (q ? commands.search(q) : commands.list().filter((c) => !c.hidden)).filter((c) => !c.id.startsWith("sample."));
  const groups = new Map<string, Command[]>();
  for (const c of list) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category)!.push(c);
  }
  for (const [cat, cs] of groups) {
    box.append(h("div", { textContent: cat }, "key-cat"));
    for (const c of cs) box.append(keyRow(c));
  }
}

function keyRow(c: Command): HTMLElement {
  const keys = commands.keysOf(c.id);
  const custom = commands.isCustom(c.id);
  const chips = h("span", {}, "key-chips");
  if (editing === c.id) chips.append(h("span", { textContent: "새 키를 누르세요… (Esc 취소 · Backspace 없애기)" }, "key-wait"));
  else if (keys.length) for (const k of keys) chips.append(h("kbd", { textContent: formatCombo(k) }));
  else chips.append(h("span", { textContent: "없음" }, "muted small"));
  const change = h("button", { type: "button", textContent: editing === c.id ? "취소" : "바꾸기" }, "small");
  change.onclick = () => {
    if (editing === c.id) {
      editing = null;
      captureNextKey(null);
      renderKeys();
      return;
    }
    editing = c.id;
    renderKeys();
    captureNextKey((e) => {
      const combo = keyOf(e);
      if (!combo) return; // 수정 키만 누름 — 계속 기다림
      captureNextKey(null);
      editing = null;
      if (combo === "Escape") return renderKeys();
      if (combo === "Backspace" || combo === "Delete") {
        setKeys(c.id, []);
        toast(`‘${c.title}’의 단축키를 없앴어요.`);
        return renderKeys();
      }
      const clash = commands.conflicts(combo, c.id);
      assign(c, combo);
      toast(clash.length ? `${formatCombo(combo)}: ‘${c.title}’에 지정했어요. ‘${clash.map((x) => x.title).join("’, ‘")}’에서는 뺐어요.` : `${formatCombo(combo)}: ‘${c.title}’에 지정했어요.`);
      renderKeys();
    });
  };
  const reset = h("button", { type: "button", textContent: "기본값", title: commands.defaultKeys(c.id).map((k) => formatCombo(k)).join(", ") || "없음" }, "small ghost");
  reset.disabled = !custom;
  reset.onclick = () => {
    const all = { ...prefs.get().keys };
    delete all[c.id];
    prefs.set({ keys: all });
    renderKeys();
  };
  return h("div", {}, "key-row" + (custom ? " custom" : "") + (editing === c.id ? " editing" : ""), [h("span", { textContent: c.title }, "key-title"), chips, change, reset]);
}
