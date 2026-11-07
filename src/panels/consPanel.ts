/** 속성 패널의 구속 부분: 선택한 도형의 구속 목록, 고른 구속의 값·지우기 (10단계) */
import { constraintsOf, isDimension, KIND_LABEL, refType } from "../core/constraints";
import { fmtLen } from "../core/units";
import type { Constraint, CRef, Shape2D, ViewId } from "../core/types";
import { VIEW_LABEL } from "../core/types";
import { deleteConstraint, setConstraintValue } from "../consActions";
import { store } from "../store";
import { shapeLabel } from "../ui/sketch";
import { describeConstraint } from "../ui/sketchConstraints";
import { ui } from "../ui/state";
import { el, keyCell } from "../app/dom";
import { toast } from "../app/notify";

const RECT_V = ["왼쪽 아래", "오른쪽 아래", "오른쪽 위", "왼쪽 위"];
const RECT_E = ["아랫변", "오른쪽 변", "윗변", "왼쪽 변"];

/** 대상 이름: “사각형 80×40 왼쪽 아래”, “원점” */
export function refName(view: ViewId, r: CRef): string {
  if (r.s === "@o") return "원점";
  if (r.s === "@x") return "가로축";
  if (r.s === "@y") return "세로축";
  const s = store.project.views[view].find((x) => x.id === r.s);
  if (!s) return "?";
  const base = shapeLabel(s, true);
  const k = r.k;
  let part = "";
  if (k === "c") part = "중심";
  else if (k === "o") part = "";
  else if (k === "a" || k === "b") part = `끝${k === "a" ? 1 : 2} 중심`;
  else if (k === "ra" || k === "rb") part = `끝${k === "ra" ? 1 : 2} 원호`;
  else if (k[0] === "v") part = s.kind === "rect" ? RECT_V[Number(k.slice(1))] : `꼭짓점 ${Number(k.slice(1)) + 1}`;
  else if (k[0] === "e") part = s.kind === "rect" ? RECT_E[Number(k.slice(1))] : s.kind === "slot" ? "축" : `변 ${Number(k.slice(1)) + 1}`;
  return part ? `${base} ${part}` : base;
}

/** 선택한 도형의 구속 목록 */
export function constraintRows(s: Shape2D, view: ViewId): HTMLElement[] {
  const list = constraintsOf(store.project, view, s.id);
  const title = el("div", { textContent: `구속 ${list.length ? list.length + "개" : ""}` }, "full section-title");
  if (!list.length)
    return [title, el("div", { innerHTML: "아직 없음 — 리본의 <b>구속</b>에서 고르거나 <kbd>K</kbd>(거리 치수)를 누르세요." }, "full muted small")];
  const box = el("div", {}, "full cons-list");
  for (const c of list) box.append(row(c, view));
  return [title, box];
}

function row(c: Constraint, view: ViewId): HTMLElement {
  const r = el("div", { title: describeConstraint(c, (x) => refName(view, x)) }, "cons-row" + (ui.selCons?.id === c.id ? " on" : ""));
  r.append(el("span", { textContent: describeConstraint(c, (x) => refName(view, x)) }, "cons-text"));
  const del = el("button", { textContent: "✕", title: "이 구속 지우기" }, "ghost small");
  del.onclick = (e) => {
    e.stopPropagation();
    deleteConstraint(view, c.id);
  };
  r.append(del);
  r.onclick = () => {
    ui.selCons = { view, id: c.id };
    ui.emit();
  };
  return r;
}

/** 고른 구속 (도형을 고르지 않았을 때) */
export function selectedConstraintProps(): HTMLElement[] | null {
  const sel = ui.selCons;
  if (!sel) return null;
  const c = store.project.constraints?.[sel.view]?.find((x) => x.id === sel.id);
  if (!c) return null;
  const out: HTMLElement[] = [];
  out.push(el("div", { innerHTML: `<b>구속: ${KIND_LABEL[c.kind]}</b> <span class="muted">· ${VIEW_LABEL[sel.view]}</span>` }, "full"));
  c.refs.forEach((r, i) => {
    const t = refType(store.project, sel.view, r);
    out.push(keyCell(`대상 ${i + 1}`), el("span", { textContent: `${refName(sel.view, r)} (${t === "point" ? "점" : t === "line" ? "선" : "원"})` }));
  });
  if (isDimension(c.kind)) {
    const inp = el("input", { type: "text", spellcheck: false, value: c.expr ?? (c.kind === "angle" ? String(Math.round((c.value ?? 0) * 100) / 100) : fmtLen(c.value ?? 0)), title: "숫자 또는 식 (예: 15, L/2)" });
    inp.onchange = () => {
      const err = setConstraintValue(sel.view, c.id, inp.value);
      if (err) {
        toast(err);
        inp.value = c.expr ?? fmtLen(c.value ?? 0);
      }
    };
    inp.onkeydown = (e) => e.key === "Enter" && inp.blur();
    out.push(keyCell(c.kind === "angle" ? "각도 (°)" : "값"), inp);
  }
  const del = el("button", { textContent: "이 구속 지우기 (Delete)" }, "small full danger");
  del.onclick = () => {
    ui.selCons = null;
    deleteConstraint(sel.view, c.id);
    ui.emit();
  };
  out.push(del, el("div", { textContent: "구속은 모양을 정하는 조건이에요. 치수 구속의 값을 바꾸면 모양이 따라 바뀝니다." }, "full muted small"));
  return out;
}
