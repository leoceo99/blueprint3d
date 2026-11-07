/**
 * 치수 식 계산기 (eval을 쓰지 않는 안전한 계산).
 *   숫자, 변수 이름, + - * / ^, 괄호, 함수 sqrt abs min max round floor ceil sin cos tan(각도는 도), 상수 pi
 *   예: "L/2", "L - 2*e", "sqrt(a^2 + b^2)", "max(t, 3)"
 * 변수 이름: 영문·한글·숫자·_ (숫자로 시작할 수 없음)
 *
 * 단위 (10단계): 숫자·괄호·변수 뒤에 mm cm m in inch " 를 붙일 수 있다 ("10 mm", "0.5 in", "(L/2) mm").
 *   단위를 붙이지 않은 숫자는 “아직 정해지지 않은 수”로 계산하다가,
 *   - 길이와 더하거나 빼면 그 길이의 단위(문서 단위)로,
 *   - 곱하기·나누기에서는 그냥 수(배수)로,
 *   - 식 전체가 길이 칸에 들어가면 문서 단위로 정해진다. (Onshape·Fusion 360과 같은 방식)
 *   그래서 mm 문서에서 예전 식은 그대로 같은 값이고, inch 문서에서는 맨 숫자가 inch가 된다.
 */
import type { Unit } from "./units";
import { MM_PER_INCH } from "./units";

export class ExprError extends Error {}

type Tok = ({ t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string } | { t: "unit"; v: number; w: string }) & { p: number; e: number };

const ID_START = /[A-Za-z_ㄱ-ㆎ가-힣]/;
const ID_PART = /[A-Za-z0-9_ㄱ-ㆎ가-힣]/;

/** 단위 낱말 → mm 몇 개인지 */
export const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: MM_PER_INCH, inch: MM_PER_INCH, '"': MM_PER_INCH };
/** 문서 단위를 식에 쓸 때의 낱말 */
export const unitWord = (u: Unit) => (u === "inch" ? "in" : "mm");
const mmPer = (u: Unit) => (u === "inch" ? MM_PER_INCH : 1);

export function isValidName(name: string): boolean {
  return name.length > 0 && ID_START.test(name[0]) && [...name].every((ch) => ID_PART.test(ch)) && !RESERVED.has(name);
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
};
const CONSTS: Record<string, number> = { pi: Math.PI };
/** 변수 이름으로 못 쓰는 낱말 (함수·상수·단위. m은 기어 모듈처럼 흔해서 이름으로 허용) */
const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS), "mm", "cm", "in", "inch"]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  // 단위가 올 수 있는 자리: 숫자·닫는 괄호·변수 바로 뒤
  const unitSpot = (word: string) => {
    const prev = out[out.length - 1];
    if (!prev || !(word in UNIT_MM)) return false;
    if (prev.t === "num") return true;
    if (word === "m") return false; // "L m"은 변수 m일 수도 있어 숫자 뒤에서만
    return (prev.t === "op" && prev.v === ")") || prev.t === "id";
  };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (j < src.length && /[eE]/.test(src[j]) && /[-+0-9]/.test(src[j + 1] ?? "")) {
        j++;
        if (/[-+]/.test(src[j])) j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new ExprError(`숫자를 읽을 수 없음: ${src.slice(i, j)}`);
      out.push({ t: "num", v, p: i, e: j });
      i = j;
    } else if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      const w = src.slice(i, j);
      if (unitSpot(w)) out.push({ t: "unit", v: UNIT_MM[w], w, p: i, e: j });
      else out.push({ t: "id", v: w, p: i, e: j });
      i = j;
    } else if (ch === '"') {
      if (!unitSpot('"')) throw new ExprError("\" 는 숫자 뒤에만 쓸 수 있어요 (inch)");
      out.push({ t: "unit", v: MM_PER_INCH, w: '"', p: i, e: i + 1 });
      i++;
    } else if ("+-*/^(),×÷".includes(ch)) {
      out.push({ t: "op", v: ch === "×" ? "*" : ch === "÷" ? "/" : ch, p: i, e: i + 1 });
      i++;
    } else throw new ExprError(`쓸 수 없는 문자: ${ch}`);
  }
  return out;
}

/** 식 안에서 쓰인 변수 이름들 */
export function referencedNames(src: string): string[] {
  try {
    const toks = tokenize(src);
    return [
      ...new Set(
        toks
          .filter((t, i) => t.t === "id" && !(toks[i + 1]?.t === "op" && toks[i + 1].v === "("))
          .map((t) => t.v as string)
          .filter((n) => !RESERVED.has(n)),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * 계산 중의 값.
 *  free: 단위가 아직 안 정해진 수 (v는 문서 단위 기준) — at: 단위를 붙이면 길이가 되는 토큰 자리들 (없으면 null)
 *  아니면 v는 mm^d (d=1 길이, 0 그냥 수, 2 넓이 …)
 */
export interface Val {
  v: number;
  d: number;
  free: boolean;
  at: number[] | null;
}
export const freeVal = (v: number): Val => ({ v, d: 0, free: true, at: null });
export const lenVal = (mm: number): Val => ({ v: mm, d: 1, free: false, at: null });

/** 어떤 칸의 식인지: 길이 칸(결과 mm), 각도 칸(도), 변수(그대로) */
export type Site = "len" | "angle" | "none";

export interface EvalResult {
  /** len: mm, angle: 도, none: 값 v */
  value: number;
  val: Val;
  /** 맨 숫자·변수가 길이로 정해진 자리 (단위 바꾸기에서 원래 단위를 붙일 곳) */
  coerced: number[];
  /** 단위를 붙여 고칠 수 없는 방식으로 정해진 것이 있음 (예: round(맨 숫자) + 길이) */
  nonlinear: boolean;
  /** 식 전체가 맨 수라서 길이 칸에서 문서 단위로 정해짐 */
  topFree: boolean;
  toks: Tok[];
}

const DIM_ERR = "단위가 맞지 않아요 (길이와 단위 없는 수, 또는 길이와 넓이를 섞음)";

/** 식 계산 (단위 포함). lookup이 변수 값을 돌려준다 (숫자면 단위 없는 수) */
export function evalExpr(src: string, lookup: (name: string) => Val | number, unit: Unit = "mm", site: Site = "none"): EvalResult {
  const toks = tokenize(src);
  if (!toks.length) throw new ExprError("식이 비어 있음");
  const f = mmPer(unit);
  const coerced: number[] = [];
  let nonlinear = false;
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const eat = (v: string) => {
    if (!isOp(v)) throw new ExprError(`'${v}'가 필요함`);
    i++;
  };
  const fixed = (v: number, d: number): Val => ({ v, d, free: false, at: null });
  /** 맨 수를 차원 d로 정하기 */
  const coerce = (x: Val, d: number): Val => {
    if (!x.free) return x;
    if (d === 0) return fixed(x.v, 0);
    if (d === 1 && x.at) coerced.push(...x.at);
    else nonlinear = true;
    return fixed(x.v * f ** d, d);
  };
  /** 더하기·min·max처럼 차원이 같아야 하는 것들 */
  const unify = (xs: Val[]): { xs: Val[]; free: boolean } => {
    const anchor = xs.find((x) => !x.free);
    if (!anchor) return { xs, free: true };
    const ys = xs.map((x) => coerce(x, anchor.d));
    if (ys.some((y) => y.d !== anchor.d)) throw new ExprError(DIM_ERR);
    return { xs: ys, free: false };
  };
  const joinAt = (xs: Val[]) => (xs.every((x) => x.at) ? xs.flatMap((x) => x.at!) : null);

  const expr = (): Val => {
    let a = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[i++] as { v: string }).v;
      const b = term();
      const u = unify([a, b]);
      const v = op === "+" ? u.xs[0].v + u.xs[1].v : u.xs[0].v - u.xs[1].v;
      a = u.free ? { v, d: 0, free: true, at: joinAt([a, b]) } : fixed(v, u.xs[0].d);
    }
    return a;
  };
  const term = (): Val => {
    let a = unary();
    while (isOp("*") || isOp("/")) {
      const op = (toks[i++] as { v: string }).v;
      const b = unary();
      if (op === "/" && b.v === 0) throw new ExprError("0으로 나눌 수 없음");
      const v = op === "*" ? a.v * b.v : a.v / b.v;
      if (a.free && b.free) a = { v, d: 0, free: true, at: op === "*" ? (a.at ?? b.at) : a.at };
      else {
        const da = a.free ? 0 : a.d;
        const db = b.free ? 0 : b.d;
        a = fixed(v, op === "*" ? da + db : da - db);
      }
    }
    return a;
  };
  const unary = (): Val => {
    if (isOp("-")) {
      i++;
      const x = unary();
      return { ...x, v: -x.v };
    }
    if (isOp("+")) {
      i++;
      return unary();
    }
    return power();
  };
  const power = (): Val => {
    const base = postfix();
    if (isOp("^")) {
      i++;
      const ex = unary();
      if (!ex.free && ex.d !== 0) throw new ExprError("지수에는 단위를 쓸 수 없어요");
      const v = Math.pow(base.v, ex.v);
      if (base.free) return { v, d: 0, free: true, at: ex.v === 1 ? base.at : null };
      return fixed(v, base.d * ex.v);
    }
    return base;
  };
  /** 단위 붙이기: 10 mm, (L/2) in */
  const postfix = (): Val => {
    let x = primary();
    while (peek()?.t === "unit") {
      const u = toks[i++] as { v: number };
      if (!x.free && x.d !== 0) throw new ExprError("이미 단위가 있는 값에 또 단위를 붙였어요");
      x = fixed(x.v * u.v, 1);
    }
    return x;
  };
  const primary = (): Val => {
    const t = peek();
    if (!t) throw new ExprError("식이 덜 끝남");
    const at = i;
    if (t.t === "num") {
      i++;
      return { v: t.v, d: 0, free: true, at: [at] };
    }
    if (t.t === "id") {
      i++;
      if (isOp("(")) {
        const fn = FUNCS[t.v];
        if (!fn) throw new ExprError(`모르는 함수: ${t.v}`);
        i++;
        const args: Val[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            i++;
            args.push(expr());
          }
        }
        eat(")");
        return call(t.v, fn, args);
      }
      if (t.v in CONSTS) return freeVal(CONSTS[t.v]);
      const r = lookup(t.v);
      if (typeof r === "number") return { v: r, d: 0, free: true, at: [at] };
      return r.free ? { ...r, at: [at] } : r;
    }
    if (t.t === "unit") throw new ExprError(`단위 '${t.w}' 앞에 숫자가 필요해요`);
    if (t.v === "(") {
      i++;
      const v = expr();
      eat(")");
      return v;
    }
    throw new ExprError(`예상하지 못한 '${t.v}'`);
  };
  const call = (name: string, fn: (...a: number[]) => number, args: Val[]): Val => {
    if (!args.length) throw new ExprError(`${name}에 값이 필요해요`);
    if (name === "min" || name === "max") {
      const u = unify(args);
      const v = fn(...u.xs.map((x) => x.v));
      return u.free ? { v, d: 0, free: true, at: joinAt(args) } : fixed(v, u.xs[0].d);
    }
    const x = args[0];
    if (name === "abs") return { ...x, v: Math.abs(x.v) };
    if (name === "sqrt") return x.free ? freeVal(Math.sqrt(x.v)) : fixed(Math.sqrt(x.v), x.d / 2);
    if (name === "sin" || name === "cos" || name === "tan") {
      if (!x.free && x.d !== 0) throw new ExprError(`${name}에는 각도(단위 없는 수)를 넣어요`);
      return freeVal(fn(x.v));
    }
    // round floor ceil: 길이는 문서 단위로 반올림
    if (x.free || x.d === 0) return x.free ? freeVal(fn(x.v)) : fixed(fn(x.v), 0);
    const k = f ** x.d;
    return fixed(fn(x.v / k) * k, x.d);
  };

  let val = expr();
  if (i < toks.length) {
    const t = toks[i];
    throw new ExprError(`예상하지 못한 '${t.t === "unit" ? t.w : t.v}'`);
  }
  if (!Number.isFinite(val.v)) throw new ExprError("결과가 숫자가 아님");
  let value = val.v;
  let topFree = false;
  if (site === "len") {
    if (val.free || val.d === 0) {
      topFree = true;
      value = val.v * f;
    } else if (val.d !== 1) throw new ExprError("길이가 아니에요 (단위를 확인하세요)");
  } else if (site === "angle") {
    if (!val.free && val.d !== 0) throw new ExprError("각도 칸에 길이 단위를 썼어요");
  }
  return { value, val, coerced, nonlinear, topFree, toks };
}

/** 식 계산 (단위 없는 수로). lookup이 변수 값을 돌려준다 (없으면 ExprError) */
export function evaluate(src: string, lookup: (name: string) => number): number {
  return evalExpr(src, lookup).value;
}

/**
 * 문서 단위를 바꿀 때 식을 고쳐 쓴다 — 고친 식을 새 단위로 계산해도 값이 같게.
 *   맨 숫자 "80" (mm→inch) → "80 mm", inch→mm "1" → "25.4" (딱 떨어지면 숫자로)
 *   식 "L/4" → "(L/4) mm", 다시 mm로 오면 "(L/4) mm" → "L/4"
 *   식 안에서 길이로 정해진 맨 숫자 "W + 10" → "W + 10 mm"
 * 바꿀 수 없으면(드문 비선형 식) ok:false와 원래 식.
 */
export function convertExprUnit(
  src: string,
  from: Unit,
  to: Unit,
  site: Site,
  lookupFrom: (name: string) => Val | number,
  lookupTo: (name: string) => Val | number = lookupFrom,
): { expr: string; ok: boolean } {
  const text = src.trim();
  if (from === to) return { expr: src, ok: true };
  let old: EvalResult;
  try {
    old = evalExpr(text, lookupFrom, from, site);
  } catch {
    return { expr: src, ok: true }; // 원래 오류인 식은 그대로
  }
  const same = (e: string) => {
    try {
      const r = evalExpr(e, lookupTo, to, site);
      const a = site === "none" ? r.val : null;
      if (a && (a.free !== old.val.free || (!a.free && a.d !== old.val.d))) return false;
      return Math.abs(r.value - old.value) <= 1e-9 * Math.max(1, Math.abs(old.value));
    } catch {
      return false;
    }
  };
  const w = unitWord(from);
  // 맨 숫자
  const n = plainNumber(text);
  if (n !== null && site === "len") {
    const r = Math.round(((n * mmPer(from)) / mmPer(to)) * 1e6) / 1e6;
    const cand = String(r);
    if (same(cand)) return { expr: cand, ok: true };
    return { expr: `${text} ${w}`, ok: same(`${text} ${w}`) };
  }
  if (site === "len") {
    // 되돌아오기: "(X) in" → "X" (X가 맨 수이고 값이 같으면)
    const toks = old.toks;
    const last = toks[toks.length - 1];
    if (last.t === "unit" && Math.abs(last.v - mmPer(to)) < 1e-12) {
      let inner: string | null = null;
      if (toks.length === 2 && (toks[0].t === "num" || toks[0].t === "id")) inner = text.slice(toks[0].p, toks[0].e);
      else if (toks[0].t === "op" && toks[0].v === "(" && toks[toks.length - 2].t === "op") {
        // 첫 ( 와 마지막 ) 가 짝인지
        let depth = 0;
        let close = -1;
        for (let k = 0; k < toks.length - 1; k++) {
          const t = toks[k];
          if (t.t === "op" && t.v === "(") depth++;
          if (t.t === "op" && t.v === ")" && --depth === 0) {
            close = k;
            break;
          }
        }
        if (close === toks.length - 2) inner = text.slice(toks[0].e, toks[close].p).trim();
      }
      if (inner) {
        try {
          const r = evalExpr(inner, lookupTo, to, site);
          if (r.topFree && same(inner)) return { expr: inner, ok: true };
        } catch {
          /* 그대로 아래로 */
        }
      }
    }
  }
  // 식 안에서 길이로 정해진 자리마다 원래 단위 붙이기
  let out = text;
  const spots = [...new Set(old.coerced)].sort((a, b) => b - a);
  for (const k of spots) {
    const t = old.toks[k];
    out = `${out.slice(0, t.e)} ${w}${out.slice(t.e)}`;
  }
  if (site === "len" && old.topFree) {
    const toks = tokenize(out);
    out = toks.length === 1 ? `${out} ${w}` : `(${out}) ${w}`;
  }
  if (out === text) return { expr: text, ok: same(text) };
  return same(out) ? { expr: out, ok: true } : { expr: src, ok: false };
}

/** 그냥 숫자인지 (변수·연산 없이) */
export function plainNumber(src: string): number | null {
  const s = src.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** 식 안의 변수 이름 바꾸기 (다른 이름의 일부는 건드리지 않음) */
export function renameInExpr(src: string, from: string, to: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (ID_START.test(src[i]) && (i === 0 || !ID_PART.test(src[i - 1]))) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      out += word === from ? to : word;
      i = j;
    } else {
      out += src[i++];
    }
  }
  return out;
}
