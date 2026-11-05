/**
 * 치수 식 계산기 (eval을 쓰지 않는 안전한 계산).
 *   숫자, 변수 이름, + - * / ^, 괄호, 함수 sqrt abs min max round floor ceil sin cos tan(각도는 도), 상수 pi
 *   예: "L/2", "L - 2*e", "sqrt(a^2 + b^2)", "max(t, 3)"
 * 변수 이름: 영문·한글·숫자·_ (숫자로 시작할 수 없음)
 */

export class ExprError extends Error {}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

const ID_START = /[A-Za-z_ㄱ-ㆎ가-힣]/;
const ID_PART = /[A-Za-z0-9_ㄱ-ㆎ가-힣]/;

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
const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS)]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
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
      out.push({ t: "num", v });
      i = j;
    } else if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
    } else if ("+-*/^(),×÷".includes(ch)) {
      out.push({ t: "op", v: ch === "×" ? "*" : ch === "÷" ? "/" : ch });
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

/** 식 계산. lookup이 변수 값을 돌려준다 (없으면 ExprError) */
export function evaluate(src: string, lookup: (name: string) => number): number {
  const toks = tokenize(src);
  if (!toks.length) throw new ExprError("식이 비어 있음");
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && peek().v === v;
  const eat = (v: string) => {
    if (!isOp(v)) throw new ExprError(`'${v}'가 필요함`);
    i++;
  };

  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[i++].v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = toks[i++].v;
      const r = unary();
      if (op === "/" && r === 0) throw new ExprError("0으로 나눌 수 없음");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    if (isOp("-")) {
      i++;
      return -unary();
    }
    if (isOp("+")) {
      i++;
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = primary();
    if (isOp("^")) {
      i++;
      return Math.pow(base, unary());
    }
    return base;
  };
  const primary = (): number => {
    const t = peek();
    if (!t) throw new ExprError("식이 덜 끝남");
    if (t.t === "num") {
      i++;
      return t.v;
    }
    if (t.t === "id") {
      i++;
      if (isOp("(")) {
        const fn = FUNCS[t.v];
        if (!fn) throw new ExprError(`모르는 함수: ${t.v}`);
        i++;
        const args: number[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            i++;
            args.push(expr());
          }
        }
        eat(")");
        return fn(...args);
      }
      if (t.v in CONSTS) return CONSTS[t.v];
      return lookup(t.v);
    }
    if (t.v === "(") {
      i++;
      const v = expr();
      eat(")");
      return v;
    }
    throw new ExprError(`예상하지 못한 '${t.v}'`);
  };

  const v = expr();
  if (i < toks.length) throw new ExprError(`예상하지 못한 '${toks[i].v}'`);
  if (!Number.isFinite(v)) throw new ExprError("결과가 숫자가 아님");
  return v;
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
