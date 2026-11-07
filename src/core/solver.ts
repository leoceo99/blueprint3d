/**
 * 구속 해석기 (10단계, R4): 식 f_i(x) = 0 들을 만족하는 변수 x를 찾는다.
 *
 *  - 한 걸음: 최소 노름 뉴턴 dx = −Jᵀ(JJᵀ + λI)⁻¹ f  (SolveSpace식 — 조건을 지키며 **가장 적게 움직이는** 해)
 *    줄어들지 않으면 걸음을 반씩 줄이고, 그래도 안 되면 λ를 키운다 (Levenberg–Marquardt 감쇠)
 *  - 서로 이어지지 않은 식 묶음은 따로 푼다 (FreeCAD의 부분 계처럼 — 큰 스케치도 빠르게)
 *  - 분석: Jacobian 행을 넣은 순서대로 Gram–Schmidt → 계수(rank), 자유도, 중복 식(나중에 넣은 것을 지목),
 *    변수마다 “정해짐” (그 변수 방향이 행 공간 안에 있으면 더 움직일 수 없음)
 * 고정 변수는 식 안의 상수로 넣는다 (해석기는 움직일 수 있는 변수만 안다).
 */

export interface Eq {
  /** 어느 구속에서 나온 식인지 (진단용) */
  tag: number;
  /** 이 식이 쓰는 변수 번호 */
  vars: number[];
  /** 값 */
  f(x: Float64Array): number;
  /** vars 순서대로 편미분 */
  g(x: Float64Array): number[];
}

export interface SolveOptions {
  /** 이만큼 작으면 만족 (mm 단위 식 기준) */
  tol?: number;
  maxIter?: number;
}

export interface SolveResult {
  ok: boolean;
  iters: number;
  /** 가장 큰 |f| */
  residual: number;
}

export interface Analysis {
  rank: number;
  /** 식에 나오는 변수 수 − 계수 (식에 안 나오는 변수는 따로 셈) */
  dof: number;
  /** 앞의 식들로 이미 정해져서 필요 없는(또는 부딪치는) 식 번호 */
  redundant: number[];
  /** 변수마다 더 움직일 수 없는지 */
  determined: Uint8Array;
}

const TOL = 1e-9;

/** 식들을 변수로 이어진 묶음으로 나눈다 (union-find) */
export function components(eqs: Eq[], n: number): { eqs: number[]; vars: number[] }[] {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (const e of eqs) for (let k = 1; k < e.vars.length; k++) parent[find(e.vars[k])] = find(e.vars[0]);
  const groups = new Map<number, { eqs: number[]; vars: Set<number> }>();
  eqs.forEach((e, i) => {
    if (!e.vars.length) {
      // 변수가 없는 식 (상수끼리) — 혼자 묶음
      groups.set(-1 - i, { eqs: [i], vars: new Set() });
      return;
    }
    const r = find(e.vars[0]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { eqs: [], vars: new Set() }));
    g.eqs.push(i);
    for (const v of e.vars) g.vars.add(v);
  });
  return [...groups.values()].map((g) => ({ eqs: g.eqs, vars: [...g.vars].sort((a, b) => a - b) }));
}

/** 식들을 푼다 (x를 바꿈) */
export function solve(x: Float64Array, eqs: Eq[], opts: SolveOptions = {}): SolveResult {
  const tol = opts.tol ?? TOL;
  let ok = true;
  let iters = 0;
  let residual = 0;
  for (const c of components(eqs, x.length)) {
    const r = solveGroup(x, c.eqs.map((i) => eqs[i]), c.vars, tol, opts.maxIter ?? 80);
    ok &&= r.ok;
    iters = Math.max(iters, r.iters);
    residual = Math.max(residual, r.residual);
  }
  return { ok, iters, residual };
}

function maxAbs(f: Float64Array) {
  let m = 0;
  for (let i = 0; i < f.length; i++) m = Math.max(m, Math.abs(f[i]));
  return m;
}
function sumSq(f: Float64Array) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return s;
}

function solveGroup(x: Float64Array, eqs: Eq[], vars: number[], tol: number, maxIter: number): SolveResult {
  const m = eqs.length;
  const k = vars.length;
  const local = new Map<number, number>();
  vars.forEach((v, j) => local.set(v, j));
  const f = new Float64Array(m);
  const evalF = (out: Float64Array) => {
    for (let i = 0; i < m; i++) out[i] = eqs[i].f(x);
  };
  evalF(f);
  if (!k) return { ok: maxAbs(f) < tol, iters: 0, residual: maxAbs(f) };
  const J = new Float64Array(m * k);
  const A = new Float64Array(m * m);
  const y = new Float64Array(m);
  const dx = new Float64Array(k);
  const x0 = new Float64Array(k);
  const f2 = new Float64Array(m);
  let lambda = 1e-12;
  let it = 0;
  for (; it < maxIter; it++) {
    if (maxAbs(f) < tol) return { ok: true, iters: it, residual: maxAbs(f) };
    // Jacobian
    J.fill(0);
    for (let i = 0; i < m; i++) {
      const g = eqs[i].g(x);
      const vs = eqs[i].vars;
      for (let q = 0; q < vs.length; q++) J[i * k + local.get(vs[q])!] += g[q];
    }
    // A = J Jᵀ
    let diag = 0;
    for (let i = 0; i < m; i++)
      for (let j = 0; j <= i; j++) {
        let s = 0;
        for (let q = 0; q < k; q++) s += J[i * k + q] * J[j * k + q];
        A[i * m + j] = A[j * m + i] = s;
        if (i === j) diag = Math.max(diag, s);
      }
    const e0 = sumSq(f);
    let accepted = false;
    for (let tries = 0; tries < 6 && !accepted; tries++) {
      // (A + λI) y = f
      if (!cholSolve(A, m, lambda * Math.max(diag, 1e-12) + 1e-14, f, y)) {
        lambda = Math.max(lambda * 100, 1e-8);
        continue;
      }
      for (let q = 0; q < k; q++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i * k + q] * y[i];
        dx[q] = -s;
        x0[q] = x[vars[q]];
      }
      // 선 탐색: 오차 제곱합이 줄어드는 걸음
      let t = 1;
      for (let h = 0; h < 14; h++, t /= 2) {
        for (let q = 0; q < k; q++) x[vars[q]] = x0[q] + t * dx[q];
        evalF(f2);
        if (sumSq(f2) < e0) {
          f.set(f2);
          accepted = true;
          break;
        }
      }
      if (!accepted) {
        for (let q = 0; q < k; q++) x[vars[q]] = x0[q];
        lambda = Math.max(lambda * 1000, 1e-9);
      } else lambda = Math.max(lambda / 10, 1e-12);
    }
    if (!accepted) break;
  }
  const res = maxAbs(f);
  return { ok: res < tol, iters: it, residual: res };
}

/** 대칭 양의 정부호 (A + μI) y = b — 실패하면 false */
function cholSolve(A: Float64Array, m: number, mu: number, b: Float64Array, y: Float64Array): boolean {
  const L = new Float64Array(m * m);
  for (let i = 0; i < m; i++)
    for (let j = 0; j <= i; j++) {
      let s = A[i * m + j] + (i === j ? mu : 0);
      for (let q = 0; q < j; q++) s -= L[i * m + q] * L[j * m + q];
      if (i === j) {
        if (!(s > 0)) return false;
        L[i * m + i] = Math.sqrt(s);
      } else L[i * m + j] = s / L[j * m + j];
    }
  // L z = b, Lᵀ y = z
  for (let i = 0; i < m; i++) {
    let s = b[i];
    for (let q = 0; q < i; q++) s -= L[i * m + q] * y[q];
    y[i] = s / L[i * m + i];
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = y[i];
    for (let q = i + 1; q < m; q++) s -= L[q * m + i] * y[q];
    y[i] = s / L[i * m + i];
  }
  return true;
}

/**
 * 지금 x에서 식들의 구조 분석: 계수, 자유도, 중복 식, 변수별 정해짐.
 * 식은 넣은 순서대로 보므로 “나중에 넣은” 구속이 중복으로 지목된다.
 */
export function analyze(x: Float64Array, eqs: Eq[], n = x.length): Analysis {
  const determined = new Uint8Array(n);
  const redundant: number[] = [];
  let rank = 0;
  let used = 0;
  for (const c of components(eqs, n)) {
    const k = c.vars.length;
    used += k;
    const local = new Map<number, number>();
    c.vars.forEach((v, j) => local.set(v, j));
    const basis: Float64Array[] = [];
    for (const i of c.eqs) {
      const row = new Float64Array(k);
      const g = eqs[i].g(x);
      eqs[i].vars.forEach((v, q) => (row[local.get(v)!] += g[q]));
      let n0 = 0;
      for (let q = 0; q < k; q++) n0 += row[q] * row[q];
      n0 = Math.sqrt(n0);
      // 두 번 직교화 (수치 안정)
      for (let pass = 0; pass < 2; pass++)
        for (const b of basis) {
          let d = 0;
          for (let q = 0; q < k; q++) d += row[q] * b[q];
          for (let q = 0; q < k; q++) row[q] -= d * b[q];
        }
      let nr = 0;
      for (let q = 0; q < k; q++) nr += row[q] * row[q];
      nr = Math.sqrt(nr);
      if (nr > 1e-7 * Math.max(1, n0)) {
        for (let q = 0; q < k; q++) row[q] /= nr;
        basis.push(row);
      } else redundant.push(i);
    }
    rank += basis.length;
    for (let q = 0; q < k; q++) {
      let s = 0;
      for (const b of basis) s += b[q] * b[q];
      if (s > 1 - 1e-6) determined[c.vars[q]] = 1;
    }
  }
  redundant.sort((a, b) => a - b);
  return { rank, dof: used - rank, redundant, determined };
}
