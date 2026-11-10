/**
 * 변수와 치수 식.
 * - 변수는 서로를 참조할 수 있다 (순서 상관없음, 돌고 도는 참조는 오류).
 * - 도형의 치수가 식에 묶여 있으면, 변경이 있을 때마다 식을 다시 계산해 숫자 값에 써 넣는다.
 *   그래서 화면·3D·검사 코드는 계속 숫자만 보면 된다.
 */
import { convertExprUnit, evalExpr, ExprError, plainNumber, referencedNames, renameInExpr, type Site, type Val } from "./expr";
import type { Project, Shape2D } from "./types";
import { allSlots, FEATURE_VALUES, setFeatureValue, slotCons, slotShapes, type SlotId } from "./featureModel";
import { fromDisplay, toDisplay, type Unit } from "./units";

export interface ParamResult {
  /** 값 (단위 없는 수는 문서 단위 기준 숫자, 길이는 mm) */
  values: Map<string, number>;
  /** 값과 단위 정보 */
  vals: Map<string, Val>;
  errors: Map<string, string>;
}

/** 부품의 길이 단위 (없으면 mm) */
export const projUnit = (p: Project): Unit => p.units ?? "mm";

/** 변수 값 계산 (의존 순서대로, 순환 참조 검출) */
export function evaluateParams(p: Project): ParamResult {
  const defs = new Map((p.params ?? []).map((x) => [x.name, x.expr]));
  const unit = projUnit(p);
  const values = new Map<string, number>();
  const vals = new Map<string, Val>();
  const errors = new Map<string, string>();
  const visiting = new Set<string>();

  const valueOf = (name: string): Val => {
    if (vals.has(name)) return vals.get(name)!;
    if (errors.has(name)) throw new ExprError(`변수 ${name}에 오류가 있음`);
    const expr = defs.get(name);
    if (expr === undefined) throw new ExprError(`없는 변수: ${name}`);
    if (visiting.has(name)) throw new ExprError(`변수끼리 서로를 참조함 (${name})`);
    visiting.add(name);
    try {
      const v = evalExpr(expr, valueOf, unit, "none").val;
      vals.set(name, v);
      values.set(name, v.v);
      return v;
    } finally {
      visiting.delete(name);
    }
  };

  for (const name of defs.keys()) {
    try {
      valueOf(name);
    } catch (e) {
      errors.set(name, (e as Error).message);
    }
  }
  return { values, vals, errors };
}

/** 변수 값 찾기 (없거나 오류면 ExprError) */
export function paramLookup(pr: ParamResult): (name: string) => Val {
  return (name) => {
    const v = pr.vals.get(name);
    if (v) return v;
    throw new ExprError(pr.errors.has(name) ? `변수 ${name}에 오류가 있음` : `없는 변수: ${name}`);
  };
}

/** 길이 칸(mm로) 또는 각도 칸(도)의 식 계산 */
export function evalSite(p: Project, src: string, site: Exclude<Site, "none">, pr: ParamResult = evaluateParams(p)): number {
  return evalExpr(src, paramLookup(pr), projUnit(p), site).value;
}

/** 잠금 숫자 글자 (문서 단위로, mm는 소수 넷째·inch는 여섯째 자리) */
export function lockText(mm: number, unit: Unit): string {
  const k = unit === "inch" ? 1e6 : 1e4;
  return String(Math.round(toDisplay(mm, unit) * k) / k);
}

/** 도형 종류별로 식에 묶을 수 있는 치수와, 그 값을 읽고 쓰는 방법 */
type Accessor = { get: (s: any) => number; set: (s: any, v: number) => void; label: string };

const ACCESSORS: Record<Shape2D["kind"], Record<string, Accessor>> = {
  rect: {
    x: { label: "왼쪽", get: (s) => Math.min(s.x, s.x + s.w), set: (s, v) => ((s.x = v), s.w < 0 && (s.w = -s.w)) },
    y: { label: "아래", get: (s) => Math.min(s.y, s.y + s.h), set: (s, v) => ((s.y = v), s.h < 0 && (s.h = -s.h)) },
    w: { label: "가로", get: (s) => Math.abs(s.w), set: (s, v) => (s.w = Math.max(v, 1e-6)) },
    h: { label: "세로", get: (s) => Math.abs(s.h), set: (s, v) => (s.h = Math.max(v, 1e-6)) },
  },
  circle: {
    cx: { label: "중심 가로", get: (s) => s.cx, set: (s, v) => (s.cx = v) },
    cy: { label: "중심 세로", get: (s) => s.cy, set: (s, v) => (s.cy = v) },
    d: { label: "지름", get: (s) => s.r * 2, set: (s, v) => (s.r = Math.max(v, 1e-6) / 2) },
  },
  slot: {
    ax: { label: "중심1 가로", get: (s) => s.a[0], set: (s, v) => (s.a = [v, s.a[1]]) },
    ay: { label: "중심1 세로", get: (s) => s.a[1], set: (s, v) => (s.a = [s.a[0], v]) },
    bx: { label: "중심2 가로", get: (s) => s.b[0], set: (s, v) => (s.b = [v, s.b[1]]) },
    by: { label: "중심2 세로", get: (s) => s.b[1], set: (s, v) => (s.b = [s.b[0], v]) },
    w: { label: "폭", get: (s) => s.w, set: (s, v) => (s.w = Math.max(v, 1e-6)) },
  },
  poly: {},
};

const DEPTH: Accessor = { label: "깊이", get: (s) => s.depth ?? NaN, set: (s, v) => (s.depth = Math.max(v, 1e-6)) };

export function accessor(s: Shape2D, key: string): Accessor | undefined {
  if (key === "depth") return s.hole ? DEPTH : undefined;
  return ACCESSORS[s.kind][key];
}

export function getDim(s: Shape2D, key: string): number {
  return accessor(s, key)?.get(s) ?? NaN;
}

export interface ExprProblem {
  /** 3면도 뷰 또는 스케치 피처 id */
  view?: SlotId;
  /** 피처 값의 식이면 그 피처 id */
  featureId?: string;
  shapeId?: string;
  key: string;
  message: string;
}

/**
 * 변수와 식을 계산해서 도형의 숫자 값에 써 넣는다 (프로젝트를 직접 고침).
 * 오류가 난 식은 마지막 값을 그대로 두고 문제 목록으로 돌려준다.
 */
export function applyExpressions(p: Project): { problems: ExprProblem[]; values: Map<string, number> } {
  const pr = evaluateParams(p);
  const { values, errors } = pr;
  const problems: ExprProblem[] = [...errors].map(([name, message]) => ({ key: `param:${name}`, message }));
  if (p.thicknessExpr) {
    try {
      const v = evalSite(p, p.thicknessExpr, "len", pr);
      if (v > 0) p.thickness = v;
      else problems.push({ key: "thickness", message: "두께는 0보다 커야 함" });
    } catch (e) {
      problems.push({ key: "thickness", message: (e as Error).message });
    }
  }
  for (const view of allSlots(p))
    for (const s of slotShapes(p, view)) {
      if (!s.exprs) continue;
      for (const [key, expr] of Object.entries(s.exprs)) {
        const acc = accessor(s, key);
        if (!acc) continue;
        try {
          acc.set(s, evalSite(p, expr, "len", pr));
        } catch (e) {
          problems.push({ view, shapeId: s.id, key, message: (e as Error).message });
        }
      }
    }
  // 피처 값 (거리·각도·개수 …, 13단계)
  for (const f of p.features ?? []) {
    if (!f.exprs) continue;
    for (const [key, expr] of Object.entries(f.exprs)) {
      const spec = FEATURE_VALUES[f.kind]?.[key];
      if (!spec) continue;
      try {
        const v = spec.site === "count" ? evalExpr(expr, paramLookup(pr), projUnit(p), "none").value : evalSite(p, expr, spec.site, pr);
        if (!Number.isFinite(v)) throw new ExprError("숫자가 아님");
        setFeatureValue(f, key, v);
      } catch (e) {
        problems.push({ featureId: f.id, key, message: (e as Error).message });
      }
    }
  }
  return { problems, values };
}

/**
 * 치수 칸에 입력한 글자를 반영한다.
 * 그냥 숫자면 그 값으로 (잠금이었으면 잠금 숫자로 유지), 식이면 식에 묶는다.
 */
export function setDimInput(s: Shape2D, key: string, input: string, p: Project): string | null {
  const acc = accessor(s, key);
  if (!acc) return "이 치수는 식을 쓸 수 없어요";
  const text = input.trim();
  if (!text) return "값을 입력하세요";
  const n = plainNumber(text);
  if (n !== null) {
    if (s.exprs?.[key] !== undefined) s.exprs[key] = String(n); // 잠긴 치수는 새 숫자로 잠금 유지
    acc.set(s, fromDisplay(n, projUnit(p)));
    return null;
  }
  try {
    const v = evalSite(p, text, "len");
    s.exprs = { ...(s.exprs ?? {}), [key]: text };
    acc.set(s, v);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 치수 잠금 켜기(지금 값으로 묶음) / 끄기(식 해제, 숫자는 그대로) */
export function toggleLock(s: Shape2D, key: string, unit: Unit = "mm") {
  if (s.exprs?.[key] !== undefined) {
    const { [key]: _drop, ...rest } = s.exprs;
    s.exprs = Object.keys(rest).length ? rest : undefined;
  } else {
    const v = getDim(s, key);
    if (Number.isFinite(v)) s.exprs = { ...(s.exprs ?? {}), [key]: lockText(v, unit) };
  }
}

/** 변수 이름을 바꾸고, 그 변수를 쓰는 모든 식도 같이 고친다 */
export function renameParam(p: Project, from: string, to: string) {
  for (const prm of p.params ?? []) {
    if (prm.name === from) prm.name = to;
    prm.expr = renameInExpr(prm.expr, from, to);
  }
  if (p.thicknessExpr) p.thicknessExpr = renameInExpr(p.thicknessExpr, from, to);
  for (const v of allSlots(p)) {
    for (const s of slotShapes(p, v))
      if (s.exprs) for (const k of Object.keys(s.exprs)) s.exprs[k] = renameInExpr(s.exprs[k], from, to);
    for (const c of slotCons(p, v) ?? []) if (c.expr) c.expr = renameInExpr(c.expr, from, to);
  }
  for (const f of p.features ?? []) if (f.exprs) for (const k of Object.keys(f.exprs)) f.exprs[k] = renameInExpr(f.exprs[k], from, to);
}

/** 이 변수를 쓰는 곳의 수 (지우기 전에 알려 주기용) */
export function paramUsage(p: Project, name: string): number {
  let n = 0;
  const uses = (e?: string) => (e && referencedNames(e).includes(name) ? 1 : 0);
  for (const prm of p.params ?? []) if (prm.name !== name) n += uses(prm.expr);
  n += uses(p.thicknessExpr);
  for (const v of allSlots(p)) {
    for (const s of slotShapes(p, v)) for (const e of Object.values(s.exprs ?? {})) n += uses(e);
    for (const c of slotCons(p, v) ?? []) n += uses(c.expr);
  }
  for (const f of p.features ?? []) for (const e of Object.values(f.exprs ?? {})) n += uses(e);
  return n;
}

/**
 * 부품의 길이 단위 바꾸기 — 모양(mm 값)은 그대로, 식은 새 단위로 계산해도 같은 값이 되게 고쳐 쓴다.
 * 돌려주는 값: 그대로 옮기지 못한 식의 수 (그 식은 원래 글자를 둔다)
 */
export function convertProjectUnit(p: Project, to: Unit): number {
  const from = projUnit(p);
  if (from === to) return 0;
  const before = evaluateParams(p);
  let lost = 0;
  const conv = (src: string, site: Site, lookupTo: (n: string) => Val) => {
    const r = convertExprUnit(src, from, to, site, paramLookup(before), lookupTo);
    if (!r.ok) lost++;
    return r.expr;
  };
  // 1) 변수 (서로 참조하므로 원래 값을 기준으로 하나씩)
  const prevLookup = paramLookup(before);
  for (const prm of p.params ?? []) prm.expr = conv(prm.expr, "none", prevLookup);
  if (to === "inch") p.units = "inch";
  else delete p.units;
  const after = evaluateParams(p);
  const look = paramLookup(after);
  // 2) 길이 칸 (두께, 도형 치수, 거리 구속)
  if (p.thicknessExpr) p.thicknessExpr = conv(p.thicknessExpr, "len", look);
  for (const v of allSlots(p)) {
    for (const s of slotShapes(p, v)) if (s.exprs) for (const k of Object.keys(s.exprs)) s.exprs[k] = conv(s.exprs[k], "len", look);
    for (const c of slotCons(p, v) ?? []) if (c.expr) c.expr = conv(c.expr, c.kind === "angle" ? "angle" : "len", look);
  }
  for (const f of p.features ?? [])
    for (const k of Object.keys(f.exprs ?? {})) {
      const site = FEATURE_VALUES[f.kind]?.[k]?.site;
      if (site === "len" || site === "angle") f.exprs![k] = conv(f.exprs![k], site, look);
    }
  return lost;
}
