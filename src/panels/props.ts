/** 오른쪽 패널: 속성 (선택한 도형의 치수·구멍 규격·깊이·모서리·가운데 맞춤·복사, 구멍 도구 설정) */
import { mirrored, rotated, translated } from "../core/geometry2d";
import { plainNumber } from "../core/expr";
import { getDim, projUnit, setDimInput, toggleLock } from "../core/params";
import { fmtLenU, fmtNum, fmtVol, fromDisplay, unitLabel } from "../core/units";
import { HEAD_LABEL, PURPOSE_LABEL, specDiameter, THREADS, withTableHead } from "../core/standards";
import { type HoleSpec, type Shape2D } from "../core/types";
import { slotAxes, slotLabel, type SlotId } from "../core/featureModel";
import { store } from "../store";
import { fmt, shapeLabel } from "../ui/sketch";
import { ui, type HoleSettings } from "../ui/state";
import { app, invalidatePanels, onPanels } from "../app/context";
import { $, el, esc, keyCell } from "../app/dom";
import { addCopies, centerShape, partCenter, selectedShape, setHole, straightenSelected } from "../app/edit";
import { toast } from "../app/notify";
import { constraintRows, selectedConstraintProps } from "./consPanel";
import { renderFeaturePanel } from "./featurePanel";

export function initProps() {
  onPanels(renderProps);
}

/** 숫자 칸. 길이(isLen)면 문서 단위로 보이고 mm로 돌려준다 */
function numRow(label: string, value: number, onSet: (n: number) => void, min?: number, isLen = true) {
  const show = (v: number) => (isLen ? fmt(v) : fmtNum(v));
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = label;
  const i = document.createElement("input");
  i.type = "number";
  i.step = "any";
  i.value = show(value);
  i.onchange = () => {
    const n = parseFloat(i.value);
    if (!Number.isFinite(n) || (min !== undefined && n < min)) {
      i.value = show(value);
      return;
    }
    store.update(() => onSet(isLen ? fromDisplay(n) : n), `${label} 고치기`);
  };
  i.onkeydown = (e) => e.key === "Enter" && i.blur();
  return [k, i];
}

/**
 * 식에 묶을 수 있는 치수 칸. 숫자를 넣으면 값, 식(예: L/2)을 넣으면 그 식에 묶인다.
 * 🔒: 지금 값으로 잠금 (끌어도 안 바뀜), fx: 식에 묶여 있음
 */
function exprRow(label: string, s: Shape2D, key: string): HTMLElement[] {
  const k = keyCell(label);
  const wrap = el("div", {}, "expr-field");
  const bound = s.exprs?.[key];
  const value = getDim(s, key);
  const isFormula = bound !== undefined && plainNumber(bound) === null;
  const input = el("input", {
    type: "text",
    value: bound ?? fmt(value),
    spellcheck: false,
    title: "숫자 또는 식 (예: L/2, L-8, t*2)",
  });
  if (bound !== undefined) input.classList.add("bound");
  input.onchange = () => {
    let err: string | null = null;
    const ok = store.update(() => (err = setDimInput(s, key, input.value, store.project)), `${label} 고치기`);
    if (err) toast(err);
    // 오류이거나 구속 때문에 되돌려졌으면 칸도 원래 값으로
    if (err || !ok) {
      const cur = store.project.views.front.concat(store.project.views.top, store.project.views.side).find((x) => x.id === s.id) ?? s;
      input.value = cur.exprs?.[key] ?? fmt(getDim(cur, key));
    }
  };
  input.onkeydown = (e) => e.key === "Enter" && input.blur();
  const lock = el("button", {
    textContent: bound !== undefined ? (isFormula ? "fx" : "🔒") : "🔓",
    title: bound !== undefined ? "잠금/식 해제 (값은 그대로)" : "지금 값으로 잠그기 (끌어도 안 바뀜)",
  }, "lock" + (bound !== undefined ? " on" : ""));
  lock.onclick = () => store.update(() => toggleLock(s, key, projUnit(store.project)), bound !== undefined ? `${label} 잠금 해제` : `${label} 잠그기`);
  wrap.append(input, lock);
  if (isFormula) wrap.append(el("span", { textContent: `= ${fmt(value)}` }, "muted computed"));
  return [k, wrap];
}

function renderProps() {
  const box = $("#props");
  if (box.contains(document.activeElement) && document.activeElement !== box) return;
  box.innerHTML = "";
  const s = selectedShape();
  const lastBuild = app.lastBuild;
  if (app.workspace === "3d") {
    renderFeaturePanel(box);
    return;
  }
  if ((!s || !ui.sel) && ui.tool === "hole") {
    const title = document.createElement("div");
    title.className = "full";
    title.innerHTML = `<b>구멍 설정</b> <span class="muted">· 클릭하면 이 구멍이 놓여요</span>`;
    box.append(
      title,
      ...holeForm(ui.hole, ui.activeView, (next) => {
        ui.hole = next;
        ui.emit();
        invalidatePanels();
      }),
    );
    return;
  }
  if (!s || !ui.sel) {
    const cp = selectedConstraintProps();
    if (cp) {
      box.append(...cp);
      return;
    }
    box.innerHTML = `<div class="props-empty">도형을 선택하면 치수를 숫자로 고칠 수 있어요.<br/>단축키: <kbd>V</kbd> 선택 <kbd>R</kbd> 사각형 <kbd>C</kbd> 원 <kbd>L</kbd> 다각형 <kbd>S</kbd> 장공 <kbd>D</kbd> 구멍 <kbd>E</kbd> 모서리 <kbd>M</kbd> 측정 <kbd>H</kbd> 구멍 전환 <kbd>F</kbd> 전체 보기<br/>선택한 도형의 ◆ 손잡이를 끌면 변이 둥글게 휩니다.</div>`;
    return;
  }
  const [ua, va] = slotAxes(ui.sel.view);
  const head = document.createElement("div");
  head.className = "full";
  head.innerHTML = `<b>${esc(shapeLabel(s))}</b> <span class="muted">· ${slotLabel(store.project, ui.sel.view)}</span>`;
  const seg = document.createElement("div");
  seg.className = "seg full";
  for (const [hole, label] of [
    [false, "몸체 (더하기)"],
    [true, "구멍 (빼기)"],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = s.hole === hole ? "on" : "";
    b.onclick = () => setHole(s, hole);
    seg.appendChild(b);
  }
  box.append(head, seg);
  const view = ui.sel.view;
  if (s.hole && s.kind === "circle") {
    // 원형 구멍: 규격·용도·머리 자리·깊이를 한 곳에서
    const state: HoleSettings = {
      spec: s.spec ?? { size: nearestSize(s.r * 2), purpose: "custom", head: "none", csAngle: 90, drillPoint: false },
      d: s.r * 2,
      depth: s.depth,
    };
    box.append(
      ...exprRow(`중심 ${ua}`, s, "cx"),
      ...exprRow(`중심 ${va}`, s, "cy"),
      ...holeForm(
        state,
        view,
        (next) => {
          store.update(() => {
            const plain = next.spec.purpose === "custom" && next.spec.head === "none" && !next.spec.drillPoint;
            s.spec = plain ? undefined : next.spec;
            s.r = (specDiameter(next.spec) ?? next.d) / 2;
            // 규격 지름을 쓰면 지름 식은 의미가 없으므로 해제
            if (specDiameter(next.spec) !== null && s.exprs?.d !== undefined) toggleLock(s, "d");
            if (next.depth === undefined && s.exprs?.depth !== undefined) toggleLock(s, "depth");
            s.depth = next.depth;
          }, "구멍 설정");
        },
        s,
      ),
    );
    box.append(...alignControls(s, view), ...constraintRows(s, view), ...copyControls(s, view));
    return;
  }
  if (s.hole)
    box.append(
      ...depthRow(
        s.depth,
        view,
        (d) =>
          store.update(() => {
            if (d === undefined && s.exprs?.depth !== undefined) toggleLock(s, "depth");
            s.depth = d;
          }, "깊이 고치기"),
        s,
      ),
    );
  if (s.kind === "rect") {
    box.append(...exprRow(`${ua} (왼쪽)`, s, "x"), ...exprRow(`${va} (아래)`, s, "y"), ...exprRow("가로", s, "w"), ...exprRow("세로", s, "h"));
  } else if (s.kind === "slot") {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    box.append(
      ...exprRow(`중심1 ${ua}`, s, "ax"),
      ...exprRow(`중심1 ${va}`, s, "ay"),
      ...exprRow(`중심2 ${ua}`, s, "bx"),
      ...exprRow(`중심2 ${va}`, s, "by"),
      ...numRow("중심거리", len, (n) => {
        const dir = len > 1e-9 ? [(s.b[0] - s.a[0]) / len, (s.b[1] - s.a[1]) / len] : [1, 0];
        s.b = [s.a[0] + dir[0] * n, s.a[1] + dir[1] * n];
      }, 0),
      ...exprRow("폭", s, "w"),
    );
  } else if (s.kind === "circle") {
    box.append(...exprRow(`중심 ${ua}`, s, "cx"), ...exprRow(`중심 ${va}`, s, "cy"), ...exprRow("지름 Ø", s, "d"));
  } else {
    const k = document.createElement("span");
    k.className = "k full";
    k.textContent = `꼭짓점 (한 줄에 ${ua}, ${va})`;
    const ta = document.createElement("textarea");
    ta.className = "full";
    ta.value = s.pts.map(([x, y]) => `${fmt(x)}, ${fmt(y)}`).join("\n");
    ta.onchange = () => {
      const pts = ta.value
        .split(/[\n;]+/)
        .map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number))
        .filter((a) => a.length >= 2 && a.every(Number.isFinite))
        .map((a) => [fromDisplay(a[0]), fromDisplay(a[1])] as [number, number]);
      if (pts.length < 3) return toast("꼭짓점이 3개 이상 필요합니다.");
      store.update(() => {
        // 점 개수가 바뀌면 변 휘기·모서리 정보는 어느 점 것인지 알 수 없어 지운다
        if (pts.length !== s.pts.length) {
          s.bulges = undefined;
          s.corners = undefined;
        }
        s.pts = pts;
      }, "꼭짓점 고치기");
    };
    box.append(k, ta);
    if (s.bulges?.some((b) => b)) {
      const btn = document.createElement("button");
      btn.className = "small full";
      btn.textContent = "휜 변을 모두 직선으로";
      btn.onclick = () => store.update(() => (s.bulges = undefined), "휜 변 펴기");
      box.append(btn);
    }
  }
  if (s.kind === "poly") {
    const btn = el("button", { textContent: "거의 수평·수직인 변 바로잡기" }, "small full");
    btn.title = "5° 안쪽으로 기울어진 변을 정확히 수평·수직으로 맞춥니다";
    btn.onclick = straightenSelected;
    box.append(btn);
  }
  if (s.kind === "rect" || s.kind === "poly") box.append(...cornerControls(s));
  box.append(...alignControls(s, ui.sel.view), ...constraintRows(s, ui.sel.view), ...copyControls(s, ui.sel.view));
}

/** 부품 가운데로 맞추기 (가로/세로) — 위치가 잠겨 있으면 하지 않음 */
function alignControls(s: Shape2D, view: SlotId): HTMLElement[] {
  const row = el("div", {}, "inline");
  const b1 = el("button", { textContent: "↔ 가로 가운데" }, "small");
  b1.onclick = () => centerShape(s, view, 0);
  const b2 = el("button", { textContent: "↕ 세로 가운데" }, "small");
  b2.onclick = () => centerShape(s, view, 1);
  row.append(b1, b2);
  return [keyCell("가운데 맞춤"), row];
}

const DEPTH_FROM: Record<SlotId, string> = { front: "앞면부터", top: "윗면부터", side: "오른쪽 면부터" };

function nearestSize(d: number): string {
  let best = THREADS[0];
  for (const t of THREADS) if (Math.abs(t.nominal - d) < Math.abs(best.nominal - d)) best = t;
  return best.size;
}

/** 깊이: [관통] 체크 또는 mm 값 */
function depthRow(depth: number | undefined, view: SlotId, onSet: (d: number | undefined) => void, shape?: Shape2D): HTMLElement[] {
  const row = el("div", {}, "inline");
  const through = el("input", { type: "checkbox", checked: depth === undefined });
  const lab = el("label", {}, "check");
  lab.append(through, "관통");
  const bound = shape?.exprs?.depth;
  const num = el("input", { type: "text", value: bound ?? (depth !== undefined ? fmt(depth) : ""), placeholder: unitLabel(), spellcheck: false });
  num.style.width = "64px";
  if (bound !== undefined) num.classList.add("bound");
  num.disabled = depth === undefined;
  through.onchange = () => {
    if (through.checked) onSet(undefined);
    else {
      num.disabled = false;
      num.focus();
    }
  };
  num.onchange = () => {
    const n = plainNumber(num.value);
    if (shape && n === null) {
      // 식 (예: t - 2)
      let err: string | null = null;
      store.update(() => (err = setDimInput(shape, "depth", num.value, store.project)), "깊이 고치기");
      if (err) toast(err);
      return;
    }
    if (n !== null && n > 0) {
      if (shape?.exprs?.depth !== undefined) store.update((p) => setDimInput(shape, "depth", String(n), p), "깊이 고치기");
      else onSet(fromDisplay(n));
    }
  };
  num.onkeydown = (e) => e.key === "Enter" && num.blur();
  row.append(lab, num, el("span", { textContent: DEPTH_FROM[view] }, "muted"));
  if (bound !== undefined && plainNumber(bound) === null && depth !== undefined) row.append(el("span", { textContent: `= ${fmt(depth)}` }, "muted"));
  return [keyCell("깊이"), row];
}

/** 규격 구멍 설정 (구멍 도구 기본값과 선택한 원형 구멍이 같이 쓴다) */
function holeForm(state: HoleSettings, view: SlotId, apply: (next: HoleSettings) => void, shape?: Shape2D): HTMLElement[] {
  const spec = state.spec;
  const set = (patch: Partial<HoleSpec>, extra: Partial<HoleSettings> = {}) => apply({ ...state, ...extra, spec: { ...spec, ...patch } });
  const select = <T extends string>(options: [T, string][], value: T, onChange: (v: T) => void) => {
    const sel = el("select");
    for (const [v, label] of options) sel.append(el("option", { value: v, textContent: label, selected: v === value }));
    sel.onchange = () => onChange(sel.value as T);
    return sel;
  };
  const out: HTMLElement[] = [];
  out.push(
    keyCell("용도"),
    select(Object.entries(PURPOSE_LABEL) as [HoleSpec["purpose"], string][], spec.purpose, (purpose) =>
      apply({ ...state, spec: withTableHead({ ...spec, purpose }) }),
    ),
  );
  out.push(
    keyCell("나사 규격"),
    select(THREADS.map((t) => [t.size, t.size] as [string, string]), spec.size, (size) => apply({ ...state, spec: withTableHead({ ...spec, size }) })),
  );
  const d = specDiameter(spec);
  if (d === null) out.push(...(shape ? exprRow("지름 Ø", shape, "d") : numRow("지름 Ø", state.d, (n) => apply({ ...state, d: n }), 0.01)));
  else out.push(keyCell("지름 Ø"), el("span", { textContent: `${fmtLenU(d)} (표준값)` }, "stat"));
  out.push(keyCell("머리 자리"), select(Object.entries(HEAD_LABEL) as [HoleSpec["head"], string][], spec.head, (head) => set({ head })));
  if (spec.head === "counterbore")
    out.push(
      ...numRow("자리 지름", spec.cbDiameter ?? 0, (n) => set({ cbDiameter: n }), 0.01),
      ...numRow("자리 깊이", spec.cbDepth ?? 0, (n) => set({ cbDepth: n }), 0.01),
    );
  if (spec.head === "countersink")
    out.push(
      ...numRow("바깥 지름", spec.csDiameter ?? 0, (n) => set({ csDiameter: n }), 0.01),
      ...numRow("각도 (°)", spec.csAngle ?? 90, (n) => set({ csAngle: n }), 1, false),
    );
  out.push(...depthRow(state.depth, view, (depth) => apply({ ...state, depth }), shape));
  if (state.depth !== undefined) {
    const cb = el("input", { type: "checkbox", checked: !!spec.drillPoint });
    cb.onchange = () => set({ drillPoint: cb.checked });
    const lab = el("label", {}, "check");
    lab.append(cb, "바닥을 드릴 끝 모양(118°)으로");
    out.push(keyCell("바닥"), lab);
  }
  return out;
}

/** 모서리 R/모따기를 모든 꼭짓점에 한 번에 */
function cornerControls(s: Extract<Shape2D, { kind: "rect" | "poly" }>): HTMLElement[] {
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = "모서리 전체";
  const row = document.createElement("div");
  row.className = "inline";
  const size = document.createElement("input");
  size.type = "number";
  size.step = "any";
  size.min = "0";
  size.value = fmt(ui.cornerSize);
  size.title = `크기 (${unitLabel()})`;
  const n = s.kind === "rect" ? 4 : s.pts.length;
  const apply = (kind: "fillet" | "chamfer" | null) => {
    const v = fromDisplay(parseFloat(size.value));
    if (kind && !(v > 0)) return toast("크기를 0보다 크게 입력하세요.");
    if (kind) ui.cornerSize = v;
    store.update(() => (s.corners = kind ? new Array(n).fill({ kind, size: v }).map((c) => ({ ...c })) : undefined), kind ? "모서리 전체" : "모서리 전체 해제");
  };
  const mk = (label: string, kind: "fillet" | "chamfer" | null) => {
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = label;
    b.onclick = () => apply(kind);
    return b;
  };
  row.append(size, mk("R 둥글게", "fillet"), mk("C 모따기", "chamfer"), mk("없음", null));
  return [k, row];
}

/** 대칭 복사, 직선 배열, 원형 배열 */
function copyControls(s: Shape2D, view: SlotId): HTMLElement[] {
  const [ua, va] = slotAxes(view);
  const [cu, cv] = partCenter(view);
  /** isLen: 길이면 문서 단위로 보여 주고 읽을 때 mm로 */
  const num = (value: number, title: string, width = 56, isLen = true) => {
    const i = document.createElement("input");
    i.type = "number";
    i.step = "any";
    i.value = isLen ? fmt(value) : fmtNum(value);
    i.dataset.len = isLen ? "1" : "";
    i.title = title;
    i.style.width = `${width}px`;
    return i;
  };
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  const val = (i: HTMLInputElement) => (i.dataset.len ? fromDisplay(parseFloat(i.value)) : parseFloat(i.value));
  const label = (t: string) => {
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = t;
    return k;
  };
  const row = (...els: (HTMLElement | string)[]) => {
    const r = document.createElement("div");
    r.className = "inline";
    for (const e of els) r.append(typeof e === "string" ? Object.assign(document.createElement("span"), { textContent: e, className: "muted" }) : e);
    return r;
  };

  const title = document.createElement("div");
  title.className = "full section-title";
  title.textContent = "복사";

  // 대칭 복사: 기본 기준선은 부품 가운데
  const mu = num(cu, `세로 기준선 ${ua}`);
  const mv = num(cv, `가로 기준선 ${va}`);
  const mirrorRow = row(
    `${ua}=`, mu, btn("↔ 좌우", () => addCopies(view, [mirrored(s, "u", val(mu))], "대칭 복사")),
    `${va}=`, mv, btn("↕ 상하", () => addCopies(view, [mirrored(s, "v", val(mv))], "대칭 복사")),
  );

  // 직선 배열
  const ln = num(3, "개수 (원본 포함)", 44, false);
  const ldu = num(10, `${ua} 간격`);
  const ldv = num(0, `${va} 간격`);
  const linRow = row("개수", ln, `Δ${ua}`, ldu, `Δ${va}`, ldv, btn("만들기", () => {
    const n = Math.round(val(ln));
    if (!(n >= 2 && n <= 200)) return toast("개수는 2~200 사이로 입력하세요.");
    addCopies(view, Array.from({ length: n - 1 }, (_, i) => translated(s, val(ldu) * (i + 1), val(ldv) * (i + 1))), "직선 배열");
  }));

  // 원형 배열: 기본 중심은 부품 가운데, 360°면 균등 분할
  const cn = num(6, "개수 (원본 포함)", 44, false);
  const ccu = num(cu, `중심 ${ua}`);
  const ccv = num(cv, `중심 ${va}`);
  const cang = num(360, "전체 각도 (°)", 52, false);
  const circRow = row("개수", cn, "중심", ccu, ccv, "각도", cang, btn("만들기", () => {
    const n = Math.round(val(cn));
    const total = val(cang);
    if (!(n >= 2 && n <= 360)) return toast("개수는 2~360 사이로 입력하세요.");
    const step = (Math.abs(total) >= 360 ? total / n : total / (n - 1)) * (Math.PI / 180);
    addCopies(view, Array.from({ length: n - 1 }, (_, i) => rotated(s, val(ccu), val(ccv), step * (i + 1))), "원형 배열");
  }));

  return [title, label("대칭 복사"), mirrorRow, label("직선 배열"), linRow, label("원형 배열"), circRow];
}
