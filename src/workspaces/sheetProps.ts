/**
 * 도면 “고른 치수” 칸 (14.4·14.5): 고른 치수의 공차(± · 위·아래 허용차 · 끼워맞춤 H7 …)와 덧붙일 글자,
 * 고른 기호(표면 거칠기 · 기하공차 · 데이텀)의 값. 기호 도구를 쥐고 아무것도 안 골랐으면 “다음에 놓을 기호” 값.
 * 도면 화면을 열 때 내려받는다.
 */
import type { Sheet, DimEdits } from "../core/sheet";
import { GDT_LABEL, measureDim, type DimTol, type GdtSym, type SheetDim } from "../core/sheetDims";
import { COMMON_FITS, fitDeviation, fmtDev } from "../core/fits";
import { fmtLen } from "../core/units";
import { esc } from "../app/dom";
import { isSymbolTool, sheetEdit } from "./sheetState";

/** 표면 거칠기 Ra 표준 수열 (ISO 1302, µm) */
export const RA_SERIES = ["0.025", "0.05", "0.1", "0.2", "0.4", "0.8", "1.6", "3.2", "6.3", "12.5", "25", "50"];
const MODE_LABEL = { any: "가공 방법 상관없음", remove: "제거 가공 (절삭·연삭)", keep: "제거 가공 안 함 (주조·단조 그대로)" };

export interface PropsHost {
  /** 고른 치수 고치기: 값이 undefined면 그 칸을 지움 (실행 취소 가능) */
  patch: (id: string, patch: Record<string, unknown>, label: string) => void;
}

const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;

/** 공차를 쓸 수 있는 치수 (길이를 재는 것) */
const tolerable = (d: SheetDim) => d.kind === "linear" || d.kind === "ordinate" || d.kind === "radius" || d.kind === "diameter";

export function renderDimProps(box: HTMLElement, head: HTMLElement, wrap: HTMLElement, sh: Sheet | null, edits: DimEdits, host: PropsHost) {
  const hit = sheetEdit.selected && sh ? sh.dims.find((d) => d.id === sheetEdit.selected) : undefined;
  const tool = sheetEdit.tool;
  if (!hit && !isSymbolTool(tool)) {
    wrap.hidden = true;
    box.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  const def = hit?.def;
  const manual = !!def && (edits.dims ?? []).some((d) => d.id === def.id);
  const fmt = (n: number) => fmtLen(n, sh?.units ?? "mm");
  // 글자 칸에 쓰는 중이면 다시 그리지 않음 (다른 칸으로 옮겨 가도 쓴 값이 그대로 있게)
  const act = document.activeElement as HTMLInputElement | null;
  if (act && box.contains(act) && act.tagName === "INPUT" && act.type !== "checkbox" && box.dataset.for === (def?.id ?? tool)) return;
  box.dataset.for = def?.id ?? tool;
  // Enter = 그 칸 끝 (바뀐 값이 바로 그려지게)
  box.onkeydown = (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") (e.target as HTMLElement).blur();
    e.stopPropagation();
  };

  if (!def) {
    // 다음에 놓을 기호
    head.textContent = tool === "rough" ? "놓을 표면 거칠기" : tool === "gdt" ? "놓을 기하공차" : "놓을 데이텀";
    box.innerHTML = tool === "datum" ? `<p class="muted small">문자는 A, B, C… 차례로 붙어요. 놓은 뒤 두 번 눌러 바꿀 수 있어요.</p>` : symbolForm(tool === "rough" ? "rough" : "gdt", undefined);
    wireSymbol(box, (patch) => applyDefaults(patch));
    return;
  }

  const P = (patch: Record<string, unknown>, label: string) => {
    host.patch(def.id, patch, label);
    applyDefaults(patch);
  };
  if (def.kind === "rough" || def.kind === "gdt") {
    head.textContent = def.kind === "rough" ? "표면 거칠기" : "기하공차";
    box.innerHTML = symbolForm(def.kind, def);
    wireSymbol(box, (patch) => P(patch, def.kind === "rough" ? "표면 거칠기 바꾸기" : "기하공차 바꾸기"));
    return;
  }
  if (def.kind === "datum") {
    head.textContent = "데이텀";
    box.innerHTML = `<label>문자 <input data-f="label" maxlength="2" value="${esc(def.label)}" /></label>`;
    wireSymbol(box, (patch) => P(patch, "데이텀 문자"));
    return;
  }
  if (def.kind === "leader") {
    head.textContent = "지시";
    box.innerHTML = `<label>글자 <input data-f="text" value="${esc(def.text)}" /></label>`;
    wireSymbol(box, (patch) => P(patch, "지시 글자"));
    return;
  }

  head.textContent = manual ? "고른 치수" : "고른 치수 (자동)";
  const nominal = measureDim(def);
  const t = def.tol;
  const kind = t?.kind ?? "none";
  let html = `<div class="muted small">재는 값 ${def.kind === "angle" ? `${Math.round(nominal * 100) / 100}°` : esc(fmt(nominal))}</div>`;
  if (tolerable(def)) {
    html += `<label>공차 <select data-tk>${opt("none", "없음 (일반 공차)", kind)}${opt("sym", "± 같은 값", kind)}${opt("dev", "위·아래 허용차", kind)}${opt("fit", "끼워맞춤 (H7·g6 …)", kind)}</select></label>`;
    if (t?.kind === "sym") html += `<label>± <input data-tv="v" type="number" step="0.001" min="0" value="${t.v}" /></label>`;
    if (t?.kind === "dev")
      html += `<div class="row2"><label>위 <input data-tv="up" type="number" step="0.001" value="${t.up}" /></label><label>아래 <input data-tv="lo" type="number" step="0.001" value="${t.lo}" /></label></div>`;
    if (t?.kind === "fit") {
      const fd = fitDeviation(nominal, t.code);
      html += `<label>기호 <input data-tv="code" list="fitCodes" value="${esc(t.code)}" spellcheck="false" /></label><datalist id="fitCodes">${COMMON_FITS.map((c) => `<option value="${c}"></option>`).join("")}</datalist>`;
      html += fd
        ? `<div class="fit-dev">${esc(t.code)} → <b>${fmtDev(fd.up)}</b> / <b>${fmtDev(fd.lo)}</b> mm <span class="muted small">(${t.code[0] === t.code[0].toUpperCase() ? "구멍" : "축"}, ISO 286)</span></div>`
        : `<div class="fit-dev bad">표에 없는 끼워맞춤이에요 (지름 0~500 mm, IT5~IT11)</div>`;
    }
  }
  html += `<label>덧붙일 글자 <input data-f="suffix" value="${esc((def.suffix ?? "").trim())}" placeholder="예: (참고), 관통" /></label>`;
  box.innerHTML = html;

  box.querySelector<HTMLSelectElement>("[data-tk]")?.addEventListener("change", (e) => {
    const k = (e.target as HTMLSelectElement).value;
    const tol: DimTol | undefined =
      k === "sym" ? { kind: "sym", v: 0.1 } : k === "dev" ? { kind: "dev", up: 0.05, lo: 0 } : k === "fit" ? { kind: "fit", code: def.kind === "diameter" ? "H7" : "h7" } : undefined;
    P({ tol }, tol ? "공차 넣기" : "공차 빼기");
  });
  for (const inp of box.querySelectorAll<HTMLInputElement>("[data-tv]"))
    inp.addEventListener("change", () => {
      if (!t) return;
      const f = inp.dataset.tv!;
      const next = { ...t } as Record<string, unknown>;
      if (f === "code") next.code = inp.value.trim();
      else {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        next[f] = v;
      }
      // 위 < 아래면 바꿔 넣음, ±는 양수
      if (next.kind === "dev" && (next.up as number) < (next.lo as number)) [next.up, next.lo] = [next.lo, next.up];
      if (next.kind === "sym") next.v = Math.abs(next.v as number) || 0.1;
      P({ tol: next }, "공차 값");
    });
  wireSymbol(box, (patch) => P("suffix" in patch ? { suffix: patch.suffix ? ` ${String(patch.suffix).trim()}` : undefined } : patch, "치수 글자 덧붙이기"));
}

/** 거칠기·기하공차 입력 칸 */
function symbolForm(kind: "rough" | "gdt", d: SheetDim | undefined): string {
  if (kind === "rough") {
    const ra = d?.kind === "rough" ? d.ra : sheetEdit.rough.ra;
    const mode = d?.kind === "rough" ? (d.mode ?? "any") : sheetEdit.rough.mode;
    const list = RA_SERIES.includes(ra) ? RA_SERIES : [...RA_SERIES, ra];
    return `<label>Ra (µm) <select data-f="ra">${list.map((v) => opt(v, v, ra)).join("")}</select></label>
      <label>가공 <select data-f="mode">${(["any", "remove", "keep"] as const).map((m) => opt(m, MODE_LABEL[m], mode)).join("")}</select></label>`;
  }
  const g = d?.kind === "gdt" ? { sym: d.sym, value: d.value, dia: !!d.dia, datums: d.datums ?? [] } : sheetEdit.gdt;
  return `<label>종류 <select data-f="sym">${(Object.keys(GDT_LABEL) as GdtSym[]).map((k) => opt(k, GDT_LABEL[k], g.sym)).join("")}</select></label>
    <div class="row2"><label>공차 (mm) <input data-f="value" value="${esc(g.value)}" spellcheck="false" /></label><label class="check"><input type="checkbox" data-f="dia"${g.dia ? " checked" : ""} /> Ø</label></div>
    <label>데이텀 <input data-f="datums" value="${esc(g.datums.join(" "))}" placeholder="예: A  또는  A B" spellcheck="false" /></label>`;
}

/** data-f 칸이 바뀌면 그 값 하나로 고치기 */
function wireSymbol(box: HTMLElement, done: (patch: Record<string, unknown>) => void) {
  for (const el of box.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-f]"))
    el.addEventListener("change", () => {
      const f = el.dataset.f!;
      let v: unknown = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value.trim();
      if (f === "datums") v = String(v).toUpperCase().split(/[\s,|]+/).filter(Boolean).slice(0, 3);
      if (f === "dia" || f === "mode") v = f === "mode" && v === "any" ? undefined : f === "dia" && !v ? undefined : v;
      if (f === "datums" && !(v as string[]).length) v = undefined;
      if ((f === "ra" || f === "value" || f === "label") && !v) return;
      if (f === "label") v = String(v).toUpperCase();
      done({ [f]: v });
    });
}

/** 마지막에 쓴 기호 값을 다음 기호에도 */
function applyDefaults(patch: Record<string, unknown>) {
  if ("ra" in patch && typeof patch.ra === "string") sheetEdit.rough.ra = patch.ra;
  if ("mode" in patch) sheetEdit.rough.mode = (patch.mode as "remove" | "keep" | undefined) ?? "any";
  if ("sym" in patch) sheetEdit.gdt.sym = patch.sym as GdtSym;
  if ("value" in patch && typeof patch.value === "string") sheetEdit.gdt.value = patch.value;
  if ("dia" in patch) sheetEdit.gdt.dia = !!patch.dia;
  if ("datums" in patch) sheetEdit.gdt.datums = (patch.datums as string[] | undefined) ?? [];
}
