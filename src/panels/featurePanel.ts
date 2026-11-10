/**
 * 3D 설계의 오른쪽 패널 (13단계): 새 스케치 평면 고르기, 피처 설정(값을 바꾸면 바로 미리 보기), 부품 정보.
 */
import {
  BASE_PLANE_LABEL,
  EXTENT_LABEL,
  FEATURE_ICON,
  FEATURE_LABEL,
  FEATURE_VALUES,
  getFeatureValue,
  OP_LABEL,
  planeLabel,
  type AxisName,
  type BasePlane,
  type BodyOp,
  type Extent,
  type Feature,
} from "../core/featureModel";
import { HEAD_LABEL, PURPOSE_LABEL, specDiameter, THREADS, withTableHead } from "../core/standards";
import type { HoleSpec } from "../core/types";
import { fmtNum, fmtVol, unitLabel } from "../core/units";
import { store } from "../store";
import { fmt } from "../ui/sketch";
import { app, emit } from "../app/context";
import { el, esc, keyCell } from "../app/dom";
import { toast } from "../app/notify";
import {
  BODY_KINDS,
  cancelEdit,
  changeFeature,
  createSketch,
  currentFeature,
  fedit,
  finishEdit,
  insertIndex,
  setFeatureInput,
  sketchesBefore,
  stopPlanePick,
} from "../app/featureEdit";

const PLANE_HINT: Record<BasePlane, string> = { XY: "바닥·윗면 방향 (평면도처럼)", XZ: "앞면 방향 (정면도처럼)", YZ: "옆면 방향 (우측면도처럼)" };

function select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el("select");
  for (const [v, label] of options) s.append(el("option", { value: v, textContent: label, selected: v === value }));
  s.onchange = () => onChange(s.value as T);
  return s;
}

function seg<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const box = el("div", {}, "seg");
  for (const [v, label] of options) {
    const b = el("button", { textContent: label }, v === value ? "on" : "");
    b.onclick = () => onChange(v);
    box.append(b);
  }
  return box;
}

/** 숫자·식 칸 (피처 값). 오류면 알림 후 원래 값 */
function valueInput(f: Feature, key: string): HTMLInputElement {
  const spec = FEATURE_VALUES[f.kind]![key];
  const v = getFeatureValue(f, key);
  const shown = f.exprs?.[key] ?? (spec.site === "len" ? fmt(v) : fmtNum(v));
  const i = el("input", { type: "text", spellcheck: false, value: shown, title: "숫자 또는 식 (예: 20, L/2)" });
  i.dataset.key = key;
  i.onchange = () => {
    let err: string | null = null;
    changeFeature((g) => (err = setFeatureInput(g, key, i.value)));
    if (err) {
      toast(`${spec.label}: ${err}`);
      i.value = shown;
    }
  };
  // Enter: 이 칸만 반영 (피처 창은 열어 둠 — 칸 밖에서 Enter를 한 번 더 누르면 확인)
  i.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    i.blur();
  };
  return i;
}

const unitTag = (site: string) => el("span", { textContent: site === "len" ? unitLabel() : site === "angle" ? "°" : "개" }, "ulabel");
function valueRow(f: Feature, key: string): HTMLElement[] {
  const spec = FEATURE_VALUES[f.kind]![key];
  const wrap = el("span", {}, "unit");
  wrap.append(valueInput(f, key), unitTag(spec.site));
  return [keyCell(spec.label), wrap];
}

function sketchSelect(f: Feature, value: string, onChange: (id: string) => void): HTMLSelectElement {
  const idx = (store.project.features ?? []).findIndex((x) => x.id === f.id);
  const list = sketchesBefore(store.project, idx < 0 ? insertIndex(store.project) : idx);
  const opts: [string, string][] = list.map((s) => [s.id, `${s.name} · ${planeLabel(s.plane)}`]);
  if (!list.some((s) => s.id === value)) opts.unshift([value, "(없는 스케치)"]);
  return select(opts, value, onChange);
}

/** 앞쪽 피처 체크 목록 (패턴·대칭·로프트의 대상) */
function featureChecks(f: Feature, chosen: string[], kinds: Feature["kind"][], onChange: (ids: string[]) => void): HTMLElement {
  const idx = (store.project.features ?? []).findIndex((x) => x.id === f.id);
  const before = (store.project.features ?? []).slice(0, idx).filter((x) => kinds.includes(x.kind));
  const box = el("div", {}, "feat-checks full");
  if (!before.length) box.append(el("span", { textContent: "고를 수 있는 앞 피처가 없어요" }, "muted small"));
  for (const x of before) {
    const lab = el("label");
    const cb = el("input", { type: "checkbox", checked: chosen.includes(x.id) });
    cb.onchange = () => onChange(cb.checked ? [...chosen, x.id] : chosen.filter((id) => id !== x.id));
    lab.append(cb, document.createTextNode(` ${FEATURE_ICON[x.kind]} ${x.name}`));
    box.append(lab);
  }
  return box;
}

const AXES: [AxisName, string][] = [
  ["X", "X축"],
  ["Y", "Y축"],
  ["Z", "Z축"],
];
const BASES: [BasePlane, string][] = [
  ["XY", "XY 평면"],
  ["XZ", "XZ 평면"],
  ["YZ", "YZ 평면"],
];
const OPS = Object.entries(OP_LABEL) as [BodyOp, string][];

/** 피처 종류별 설정 칸 */
function featureFields(f: Feature): HTMLElement[] {
  const out: HTMLElement[] = [];
  const set = (fn: (g: any) => void) => changeFeature(fn);
  switch (f.kind) {
    case "extrude":
      out.push(keyCell("스케치"), sketchSelect(f, f.sketch, (id) => set((g) => (g.sketch = id))));
      out.push(keyCell("몸체에"), seg(OPS, f.op, (op) => set((g) => (g.op = op))));
      out.push(keyCell("끝"), select(Object.entries(EXTENT_LABEL) as [Extent, string][], f.extent, (x) => set((g) => (g.extent = x))));
      if (f.extent === "dist" || f.extent === "sym") out.push(...valueRow(f, "dist"));
      if (f.extent !== "sym" && f.extent !== "throughBoth") {
        const cb = el("input", { type: "checkbox", checked: !!f.flip });
        cb.onchange = () => set((g) => (cb.checked ? (g.flip = true) : delete g.flip));
        const lab = el("label", {}, "check");
        lab.append(cb, document.createTextNode(" 반대쪽으로"));
        out.push(keyCell("방향"), lab);
      }
      break;
    case "revolve":
      out.push(keyCell("스케치"), sketchSelect(f, f.sketch, (id) => set((g) => (g.sketch = id))));
      out.push(keyCell("몸체에"), seg(OPS, f.op, (op) => set((g) => (g.op = op))));
      out.push(
        keyCell("회전축"),
        seg(
          [
            ["v", "세로축"],
            ["u", "가로축"],
          ],
          f.axis,
          (a) => set((g) => (g.axis = a)),
        ),
      );
      out.push(...valueRow(f, "angle"));
      break;
    case "fillet":
    case "chamfer":
      out.push(keyCell("모서리"), el("span", { textContent: `${f.edges.length}개 고름` }, "stat"));
      out.push(el("div", { innerHTML: "3D 화면에서 <b>모서리</b>를 누르세요 (다시 누르면 빼기, 면을 누르면 그 면의 모서리 전부)" }, "hint full"));
      out.push(...valueRow(f, f.kind === "fillet" ? "r" : "d"));
      break;
    case "shell":
      out.push(keyCell("열 면"), el("span", { textContent: `${f.faces.length}개 고름` }, "stat"));
      out.push(el("div", { innerHTML: "3D 화면에서 <b>열어 둘 면</b>을 누르세요 (없으면 속만 빈 상자)" }, "hint full"));
      out.push(...valueRow(f, "t"));
      break;
    case "draft":
      out.push(keyCell("기울일 면"), el("span", { textContent: `${f.faces.length}개 고름` }, "stat"));
      out.push(el("div", { innerHTML: "3D 화면에서 <b>기울일 면</b>을 누르세요" }, "hint full"));
      out.push(...valueRow(f, "angle"));
      out.push(keyCell("기준 평면"), select(BASES, f.neutral, (b) => set((g) => (g.neutral = b))));
      break;
    case "pattern":
      out.push(keyCell("따라 만들 것"), featureChecks(f, f.of, BODY_KINDS, (ids) => set((g) => (g.of = ids))));
      out.push(
        keyCell("방식"),
        seg(
          [
            ["linear", "직선"],
            ["circular", "원형"],
          ],
          f.mode,
          (m) => set((g) => (g.mode = m)),
        ),
      );
      out.push(keyCell(f.mode === "linear" ? "방향" : "회전축"), select(AXES, f.axis, (a) => set((g) => (g.axis = a))));
      out.push(...valueRow(f, "count"));
      out.push(...valueRow(f, f.mode === "linear" ? "spacing" : "angle"));
      break;
    case "mirror":
      out.push(keyCell("대칭할 것"), featureChecks(f, f.of, BODY_KINDS, (ids) => set((g) => (g.of = ids))));
      out.push(el("div", { textContent: "아무것도 고르지 않으면 몸체 전체를 대칭" }, "hint full"));
      out.push(keyCell("대칭 평면"), select(BASES, f.plane, (b) => set((g) => (g.plane = b))));
      break;
    case "hole": {
      out.push(keyCell("자리 스케치"), sketchSelect(f, f.sketch, (id) => set((g) => (g.sketch = id))));
      out.push(el("div", { textContent: "스케치에 그린 원의 중심마다 구멍이 뚫려요" }, "hint full"));
      const spec = f.spec;
      const apply = (next: HoleSpec) =>
        set((g) => {
          g.spec = next;
          const d = specDiameter(next);
          if (d !== null) g.d = d;
        });
      out.push(keyCell("용도"), select(Object.entries(PURPOSE_LABEL) as [HoleSpec["purpose"], string][], spec.purpose, (purpose) => apply(withTableHead({ ...spec, purpose }))));
      out.push(keyCell("나사 규격"), select(THREADS.map((t) => [t.size, t.size] as [string, string]), spec.size, (size) => apply(withTableHead({ ...spec, size }))));
      if (specDiameter(spec) === null) out.push(...valueRow(f, "d"));
      else out.push(keyCell("지름 Ø"), el("span", { textContent: `${fmt(f.d)} ${unitLabel()} (표준값)` }, "stat"));
      out.push(keyCell("머리 자리"), select(Object.entries(HEAD_LABEL) as [HoleSpec["head"], string][], spec.head, (head) => apply({ ...spec, head })));
      const through = el("input", { type: "checkbox", checked: f.depth === null });
      through.onchange = () => set((g) => (g.depth = through.checked ? null : 10));
      const lab = el("label", {}, "check");
      lab.append(through, document.createTextNode(" 관통"));
      out.push(keyCell("깊이"), lab);
      if (f.depth !== null) out.push(...valueRow(f, "depth"));
      const flip = el("input", { type: "checkbox", checked: !!f.flip });
      flip.onchange = () => set((g) => (flip.checked ? (g.flip = true) : delete g.flip));
      const fl = el("label", {}, "check");
      fl.append(flip, document.createTextNode(" 스케치 앞쪽으로 뚫기"));
      out.push(keyCell("방향"), fl);
      break;
    }
    case "sweep": {
      out.push(keyCell("경로 스케치"), sketchSelect(f, f.path, (id) => set((g) => (g.path = id))));
      out.push(
        keyCell("단면"),
        seg(
          [
            ["circle", "원·관"],
            ["sketch", "스케치"],
          ],
          f.profile.kind,
          (k) => set((g) => (g.profile = k === "circle" ? { kind: "circle", d: 10 } : { kind: "sketch", sketch: sketchesBefore(store.project)[0]?.id ?? g.path })),
        ),
      );
      if (f.profile.kind === "circle") {
        const pr = f.profile;
        const num = (label: string, v: number | undefined, onSet: (n: number | undefined) => void) => {
          const i = el("input", { type: "text", value: v === undefined ? "" : fmt(v), placeholder: "없음" });
          i.onchange = () => {
            const n = parseFloat(i.value);
            onSet(Number.isFinite(n) && n > 0 ? n : undefined);
          };
          const w = el("span", {}, "unit");
          w.append(i, unitTag("len"));
          return [keyCell(label), w];
        };
        out.push(...num("바깥 지름", pr.d, (n) => n && set((g) => (g.profile.d = n))));
        out.push(...num("속 지름 (관)", pr.inner, (n) => set((g) => (n && n < g.profile.d ? (g.profile.inner = n) : delete g.profile.inner))));
      } else {
        out.push(keyCell("단면 스케치"), sketchSelect(f, f.profile.sketch, (id) => set((g) => (g.profile.sketch = id))));
        out.push(el("div", { textContent: "단면 스케치의 원점이 경로 시작점에 놓여요" }, "hint full"));
      }
      out.push(keyCell("몸체에"), seg(OPS, f.op, (op) => set((g) => (g.op = op))));
      break;
    }
    case "loft":
      out.push(keyCell("단면 (순서대로)"), featureChecks(f, f.sketches, ["sketch"], (ids) => set((g) => (g.sketches = ids))));
      out.push(keyCell("몸체에"), seg(OPS, f.op, (op) => set((g) => (g.op = op))));
      {
        const cb = el("input", { type: "checkbox", checked: !!f.ruled });
        cb.onchange = () => set((g) => (cb.checked ? (g.ruled = true) : delete g.ruled));
        const lab = el("label", {}, "check");
        lab.append(cb, document.createTextNode(" 곧은 면으로 (매끈하지 않게)"));
        out.push(keyCell("면"), lab);
      }
      break;
  }
  return out;
}

function planePicker(box: HTMLElement) {
  box.append(el("div", { innerHTML: "<b>새 스케치</b> <span class='muted'>· 평면 고르기</span>" }, "full"));
  const off = el("input", { type: "text", value: "0", title: "평면을 법선 방향으로 띄우는 거리" });
  for (const [b] of BASES) {
    const btn = el("button", { innerHTML: `<b>${BASE_PLANE_LABEL[b]}</b><br/><span class="muted small">${PLANE_HINT[b]}</span>` }, "plane-btn full");
    btn.dataset.plane = b;
    btn.onclick = () => {
      const n = parseFloat(off.value);
      createSketch({ kind: "base", base: b, offset: Number.isFinite(n) ? n : 0 });
    };
    box.append(btn);
  }
  const w = el("span", {}, "unit");
  w.append(off, unitTag("len"));
  box.append(keyCell("평면 거리"), w);
  box.append(el("div", { innerHTML: "또는 <b>3D 화면에서 부품의 평평한 면</b>을 누르면 그 면 위에 스케치해요" }, "hint full"));
  const cancel = el("button", { textContent: "취소" }, "full");
  cancel.onclick = stopPlanePick;
  box.append(cancel);
}

function partInfo(box: HTMLElement) {
  const b = app.lastBuild;
  const feats = store.project.features ?? [];
  const info = b
    ? (() => {
        const [[x0, y0, z0], [x1, y1, z1]] = b.bbox;
        return `<b>3D 모델</b><br/>크기 ${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} ${unitLabel()}<br/>부피 ${fmtVol(b.volume)} · 덩어리 ${b.solidCount}개`;
      })()
    : `<b>3D 모델 없음</b><br/>${esc(app.buildError ?? "스케치를 그리고 돌출해 보세요.")}`;
  const start = feats.length
    ? "피처를 <b>두 번 누르면</b> 고칠 수 있어요. 위 단추로 피처를 더하세요."
    : "<b>시작하기</b>: ① <kbd>스케치</kbd> → 평면 고르기 → 도형 그리기 → ✓ 스케치 끝내기 ② <kbd>돌출</kbd>로 두께 주기<br/>3면도로 그리고 싶으면 <kbd>1</kbd> 2D 설계.";
  box.innerHTML = `<div class="props-empty">${info}<br/><br/>${start}<br/><br/>마우스 왼쪽 끌기: 돌리기 · 오른쪽 끌기: 이동 · 휠: 확대</div>`;
}

/** 3D 설계의 오른쪽 패널 */
export function renderFeaturePanel(box: HTMLElement) {
  if (fedit.plane) return planePicker(box);
  const f = currentFeature();
  if (!f) return partInfo(box);
  const st = app.featureLog.find((x) => x.id === f.id);
  const head = el("div", { innerHTML: `<b>${FEATURE_ICON[f.kind]} ${esc(f.name)}</b> <span class="muted">· ${FEATURE_LABEL[f.kind]}${fedit.isNew ? " 만들기" : " 고치기"}</span>` }, "full");
  box.append(head, ...featureFields(f));
  if (f.kind === "fillet" || f.kind === "chamfer" || f.kind === "shell" || f.kind === "draft") {
    const cb = el("input", { type: "checkbox", checked: fedit.preview });
    cb.onchange = () => {
      fedit.preview = cb.checked;
      emit("featureEdit", f.id);
    };
    const lab = el("label", {}, "check full");
    lab.append(cb, document.createTextNode(" 결과 미리 보기 (켜면 고르기는 쉼)"));
    box.append(lab);
  }
  if (st?.state === "error" || st?.state === "warn") box.append(el("div", { textContent: `${st.state === "error" ? "⚠ " : "ⓘ "}${st.message ?? ""}` }, `feat-msg full ${st.state}`));
  const ok = el("button", { textContent: "✓ 확인" }, "primary");
  ok.onclick = () => finishEdit();
  ok.dataset.featOk = "1";
  const no = el("button", { textContent: fedit.isNew ? "취소 (만들지 않음)" : "취소" });
  no.onclick = () => cancelEdit();
  const row = el("div", {}, "feat-actions full");
  row.append(ok, no);
  box.append(row);
}
