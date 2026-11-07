/** 왼쪽 패널: 변수 (L = 80 처럼 이름 붙인 치수) */
import { isValidName, plainNumber } from "../core/expr";
import { evaluateParams, paramUsage, renameParam } from "../core/params";
import { store } from "../store";
import type { Val } from "../core/expr";
import { fmtLenU, fmtNum, toDisplay, unitLabel } from "../core/units";
import { onPanels } from "../app/context";
import { $, el } from "../app/dom";
import { toast } from "../app/notify";

export function initParams() {
  onPanels(renderParams);
  $("#addParam").onclick = addParam;
}

export function addParam() {
  const used = new Set((store.project.params ?? []).map((x) => x.name));
  const name = ["L", "W", "H", "t", "d", "e"].find((n) => !used.has(n)) ?? `v${used.size + 1}`;
  store.update((p) => (p.params = [...(p.params ?? []), { name, expr: "10" }]), `변수 ${name} 추가`);
  requestAnimationFrame(() => $<HTMLInputElement>("#params .param-row:last-child .pexpr")?.select());
}

/** 변수 값: 그냥 수, 길이(문서 단위로), 넓이 … */
function fmtVal(v: Val | undefined): string {
  if (!v) return "?";
  if (v.free || v.d === 0) return fmtNum(v.v);
  if (v.d === 1) return fmtLenU(v.v);
  const x = v.v * toDisplay(1) ** v.d;
  return `${fmtNum(x)} ${unitLabel()}${v.d === 2 ? "²" : v.d === 3 ? "³" : `^${v.d}`}`;
}

function renderParams() {
  const box = $("#params");
  if (box.contains(document.activeElement)) return;
  box.innerHTML = "";
  const p = store.project;
  const { vals, errors } = evaluateParams(p);
  const list = p.params ?? [];
  if (!list.length) {
    box.append(el("div", { innerHTML: "치수에 이름을 붙여 쓰면 한 번에 고칠 수 있어요.<br/>예: <code>L = 80</code> → 가로 칸에 <code>L</code>, 구멍 위치에 <code>L/2</code><br/>단위도 붙일 수 있어요: <code>10 mm</code>, <code>0.5 in</code>" }, "params-empty"));
    return;
  }
  list.forEach((prm, i) => {
    const row = el("div", {}, "param-row" + (errors.has(prm.name) ? " err" : ""));
    const name = el("input", { value: prm.name, spellcheck: false, title: "변수 이름" }, "pname");
    name.onchange = () => {
      const to = name.value.trim();
      if (to === prm.name) return;
      if (!isValidName(to)) return toast("이름은 영문·한글로 시작하고 영문·한글·숫자·_만 쓸 수 있어요."), (name.value = prm.name);
      if (list.some((x) => x.name === to)) return toast("같은 이름의 변수가 이미 있어요."), (name.value = prm.name);
      const from = prm.name;
      store.update((pp) => renameParam(pp, from, to), `변수 이름 ${from} → ${to}`);
    };
    const expr = el("input", { value: prm.expr, spellcheck: false, title: "값 또는 식" }, "pexpr");
    expr.onchange = () => {
      const t = expr.value.trim();
      if (!t) return (expr.value = prm.expr);
      store.update((pp) => (pp.params![i].expr = t), `${prm.name} = ${t}`);
    };
    for (const inp of [name, expr]) inp.onkeydown = (e) => e.key === "Enter" && inp.blur();
    const val = el("span", {
      textContent: errors.has(prm.name) ? "⚠" : plainNumber(prm.expr) === null ? `= ${fmtVal(vals.get(prm.name))}` : "",
      title: errors.get(prm.name) ?? "",
    }, "pval");
    const del = el("button", { textContent: "×", title: "변수 지우기" }, "pdel");
    del.onclick = () => {
      const n = paramUsage(p, prm.name);
      if (n && !confirm(`${prm.name}을(를) ${n}곳에서 쓰고 있어요. 지우면 그 치수에 오류가 납니다. 지울까요?`)) return;
      store.update((pp) => pp.params!.splice(i, 1), `변수 ${prm.name} 지우기`);
    };
    row.append(name, el("span", { textContent: "=" }, "peq"), expr, val, del);
    box.append(row);
  });
}
