/**
 * 구속 만들기·지우기·값 바꾸기 (제도판·속성 패널·명령이 같이 쓴다).
 * 실패하면 store.onConstraintError로 알린다 (화면 쪽에서 토스트).
 */
import { analyzeView, KIND_LABEL } from "./core/constraints";
import { plainNumber, referencedNames } from "./core/expr";
import { evaluateParams } from "./core/params";
import type { Constraint, ViewId } from "./core/types";
import { fromDisplay } from "./core/units";
import { store } from "./store";

/** 구속 추가. 이미 정해진 것(중복)이면 만들지 않는다 */
export function addConstraint(view: ViewId, c: Constraint): boolean {
  const trial = structuredClone(store.project);
  ((trial.constraints ??= {})[view] ??= []).push(c);
  const an = analyzeView(trial, view);
  if (an.redundant.includes(c.id)) {
    store.onConstraintError?.(`이미 정해져 있어서 ‘${KIND_LABEL[c.kind]}’ 구속은 필요 없어요 (중복 구속).`, [c.id]);
    return false;
  }
  return store.update((p) => {
    ((p.constraints ??= {})[view] ??= []).push(c);
  }, `구속: ${KIND_LABEL[c.kind]}`);
}

export function deleteConstraint(view: ViewId, id: string) {
  const c = store.project.constraints?.[view]?.find((x) => x.id === id);
  if (!c) return;
  store.update((p) => {
    const list = (p.constraints?.[view] ?? []).filter((x) => x.id !== id);
    if (list.length) p.constraints![view] = list;
    else if (p.constraints) {
      delete p.constraints[view];
      if (!Object.keys(p.constraints).length) delete p.constraints;
    }
  }, `구속 지우기: ${KIND_LABEL[c.kind]}`);
}

/** 치수 구속 값: 숫자(표시 단위) 또는 식(L/2). 오류면 설명을 돌려준다 */
export function setConstraintValue(view: ViewId, id: string, input: string): string | null {
  const c = store.project.constraints?.[view]?.find((x) => x.id === id);
  if (!c) return "구속이 없어요";
  const text = input.trim();
  const angle = c.kind === "angle";
  const n = plainNumber(text);
  if (n !== null) {
    if (!angle && n < 0) return "거리는 0 이상이어야 해요";
    const v = angle ? n : fromDisplay(n);
    const ok = store.update((p) => {
      const k = p.constraints![view]!.find((x) => x.id === id)!;
      k.value = v;
      delete k.expr;
    }, `${KIND_LABEL[c.kind]} ${text}`);
    return ok ? null : "구속 조건과 맞지 않아 되돌렸어요";
  }
  if (!text) return "값을 넣어 주세요";
  const { values } = evaluateParams(store.project);
  const unknown = referencedNames(text).find((x) => !values.has(x));
  if (unknown) return `없는 변수: ${unknown}`;
  const ok = store.update((p) => {
    p.constraints![view]!.find((x) => x.id === id)!.expr = text;
  }, `${KIND_LABEL[c.kind]} = ${text}`);
  return ok ? null : "구속 조건과 맞지 않아 되돌렸어요";
}
