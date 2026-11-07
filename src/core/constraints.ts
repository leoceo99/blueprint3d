/**
 * 스케치 구속 (10단계): 뷰 안 도형들 사이의 조건을 해석기(solver.ts)의 식으로 바꾸고, 풀어서 도형에 다시 쓴다.
 *
 * 변수는 도형의 매개변수 그대로:
 *   사각형 x·y·w·h (왼쪽·아래·가로·세로) · 원 cx·cy·r · 장공 ax·ay·bx·by·w · 다각형 x0·y0·x1·y1…
 * 점·변은 이 변수들의 1차식(예: 사각형 오른쪽 아래 꼭짓점 = (x+w, y))이라 Jacobian을 정확히 구할 수 있다.
 * 잠근 치수(🔒·식)와 “사용자가 방금 바꾼 값”은 고정 변수 → 나머지가 가장 적게 움직여 조건을 맞춘다.
 */
import { analyze, solve, type Eq } from "./solver";
import type { Constraint, ConsKind, CRef, Project, Shape2D, ViewId } from "./types";
import { VIEW_IDS } from "./types";

// ---------------- 변수 ----------------

/** 도형 하나의 변수 이름 (순서 고정) */
export function shapeVarKeys(s: Shape2D): string[] {
  switch (s.kind) {
    case "rect":
      return ["x", "y", "w", "h"];
    case "circle":
      return ["cx", "cy", "r"];
    case "slot":
      return ["ax", "ay", "bx", "by", "w"];
    case "poly":
      return s.pts.flatMap((_, i) => [`x${i}`, `y${i}`]);
  }
}

export function getVar(s: Shape2D, key: string): number {
  switch (s.kind) {
    case "rect":
      return key === "x" ? Math.min(s.x, s.x + s.w) : key === "y" ? Math.min(s.y, s.y + s.h) : key === "w" ? Math.abs(s.w) : Math.abs(s.h);
    case "circle":
      return key === "cx" ? s.cx : key === "cy" ? s.cy : s.r;
    case "slot":
      return key === "ax" ? s.a[0] : key === "ay" ? s.a[1] : key === "bx" ? s.b[0] : key === "by" ? s.b[1] : s.w;
    case "poly": {
      const i = Number(key.slice(1));
      return s.pts[i][key[0] === "x" ? 0 : 1];
    }
  }
}

function setVar(s: Shape2D, key: string, v: number) {
  switch (s.kind) {
    case "rect":
      if (key === "x") s.x = v;
      else if (key === "y") s.y = v;
      else if (key === "w") s.w = v;
      else s.h = v;
      return;
    case "circle":
      if (key === "cx") s.cx = v;
      else if (key === "cy") s.cy = v;
      else s.r = v;
      return;
    case "slot":
      if (key === "ax") s.a = [v, s.a[1]];
      else if (key === "ay") s.a = [s.a[0], v];
      else if (key === "bx") s.b = [v, s.b[1]];
      else if (key === "by") s.b = [s.b[0], v];
      else s.w = v;
      return;
    case "poly": {
      const i = Number(key.slice(1));
      const p = s.pts[i];
      s.pts[i] = key[0] === "x" ? [v, p[1]] : [p[0], v];
    }
  }
}

/** 잠근 치수(식·🔒) → 고정할 변수 이름 */
function lockedVars(s: Shape2D): string[] {
  const out: string[] = [];
  for (const k of Object.keys(s.exprs ?? {})) {
    if (s.kind === "circle" && k === "d") out.push("r");
    else if (k !== "depth") out.push(k);
  }
  return out;
}

// ---------------- 1차식 ----------------

/** c + Σ coef·x[var] */
interface Lin {
  t: [number, number][];
  c: number;
}
const lin = (c: number, t: [number, number][] = []): Lin => ({ t, c });
const add = (a: Lin, b: Lin, kb = 1): Lin => ({ c: a.c + kb * b.c, t: [...a.t, ...b.t.map(([i, k]) => [i, k * kb] as [number, number])] });
const scale = (a: Lin, k: number): Lin => ({ c: a.c * k, t: a.t.map(([i, q]) => [i, q * k]) });
const val = (a: Lin, x: Float64Array) => a.t.reduce((s, [i, k]) => s + k * x[i], a.c);

interface P2 {
  x: Lin;
  y: Lin;
}

/** 여러 1차식 값 q로 정의한 식 → 해석기 식 */
function mkEq(tag: number, qs: Lin[], F: (q: number[]) => number, G: (q: number[]) => number[]): Eq {
  const vars = [...new Set(qs.flatMap((l) => l.t.map(([i]) => i)))];
  const pos = new Map(vars.map((v, j) => [v, j]));
  const vals = (x: Float64Array) => qs.map((l) => val(l, x));
  return {
    tag,
    vars,
    f: (x) => F(vals(x)),
    g: (x) => {
      const dq = G(vals(x));
      const out = new Array(vars.length).fill(0);
      qs.forEach((l, j) => {
        for (const [i, k] of l.t) out[pos.get(i)!] += dq[j] * k;
      });
      return out;
    },
  };
}

// ---------------- 대상 (점·선·원) ----------------

export type RefType = "point" | "line" | "circle";

/** 대상이 어떤 종류인지 (없거나 쓸 수 없으면 null) */
export function refType(p: Project, view: ViewId, r: CRef): RefType | null {
  if (r.s === "@o") return "point";
  if (r.s === "@x" || r.s === "@y") return "line";
  const s = p.views[view].find((x) => x.id === r.s);
  if (!s) return null;
  const k = r.k;
  if (k === "c") return "point";
  if (k === "a" || k === "b") return s.kind === "slot" ? "point" : null;
  if (k === "o") return s.kind === "circle" ? "circle" : null;
  if (k === "ra" || k === "rb") return s.kind === "slot" ? "circle" : null;
  const m = /^([ve])(\d+)$/.exec(k);
  if (!m) return null;
  const i = Number(m[2]);
  if (m[1] === "v") {
    if (s.kind === "rect") return i < 4 ? "point" : null;
    if (s.kind === "poly") return i < s.pts.length ? "point" : null;
    return null;
  }
  if (s.kind === "rect") return i < 4 ? "line" : null;
  if (s.kind === "slot") return i === 0 ? "line" : null;
  if (s.kind === "poly") return i < s.pts.length && !s.bulges?.[i] ? "line" : null;
  return null;
}

type VarOf = (s: Shape2D, key: string) => Lin;

function pointOf(s: Shape2D, k: string, V: VarOf): P2 {
  const v = (key: string) => V(s, key);
  if (s.kind === "rect") {
    const x = v("x");
    const y = v("y");
    const xr = add(x, v("w"));
    const yt = add(y, v("h"));
    if (k === "c") return { x: add(x, scale(v("w"), 0.5)), y: add(y, scale(v("h"), 0.5)) };
    const i = Number(k.slice(1));
    return [
      { x, y },
      { x: xr, y },
      { x: xr, y: yt },
      { x, y: yt },
    ][i];
  }
  if (s.kind === "circle") return { x: v("cx"), y: v("cy") };
  if (s.kind === "slot") {
    if (k === "a") return { x: v("ax"), y: v("ay") };
    if (k === "b") return { x: v("bx"), y: v("by") };
    return { x: scale(add(v("ax"), v("bx")), 0.5), y: scale(add(v("ay"), v("by")), 0.5) };
  }
  if (k === "c") {
    const n = s.pts.length;
    let x = lin(0);
    let y = lin(0);
    for (let i = 0; i < n; i++) {
      x = add(x, v(`x${i}`), 1 / n);
      y = add(y, v(`y${i}`), 1 / n);
    }
    return { x, y };
  }
  const i = Number(k.slice(1));
  return { x: v(`x${i}`), y: v(`y${i}`) };
}

function lineOf(p: Project, view: ViewId, r: CRef, V: VarOf): [P2, P2] {
  if (r.s === "@x") return [{ x: lin(0), y: lin(0) }, { x: lin(1), y: lin(0) }];
  if (r.s === "@y") return [{ x: lin(0), y: lin(0) }, { x: lin(0), y: lin(1) }];
  const s = p.views[view].find((x) => x.id === r.s)!;
  const i = Number(r.k.slice(1));
  if (s.kind === "rect") return [pointOf(s, `v${i}`, V), pointOf(s, `v${(i + 1) % 4}`, V)];
  if (s.kind === "slot") return [pointOf(s, "a", V), pointOf(s, "b", V)];
  const n = (s as Extract<Shape2D, { kind: "poly" }>).pts.length;
  return [pointOf(s, `v${i}`, V), pointOf(s, `v${(i + 1) % n}`, V)];
}

function circleOf(p: Project, view: ViewId, r: CRef, V: VarOf): { c: P2; r: Lin } {
  const s = p.views[view].find((x) => x.id === r.s)!;
  if (s.kind === "circle") return { c: pointOf(s, "c", V), r: V(s, "r") };
  return { c: pointOf(s, r.k === "ra" ? "a" : "b", V), r: scale(V(s, "w"), 0.5) };
}

function refPointLin(p: Project, view: ViewId, r: CRef, V: VarOf): P2 {
  if (r.s === "@o") return { x: lin(0), y: lin(0) };
  const s = p.views[view].find((x) => x.id === r.s)!;
  if (r.k === "o") return pointOf(s, "c", V);
  if (r.k === "ra" || r.k === "rb") return pointOf(s, r.k === "ra" ? "a" : "b", V);
  return pointOf(s, r.k, V);
}

/** 지금 값으로 (변수 없이) */
const NOW: VarOf = (s, key) => lin(getVar(s, key));
const nowVal = (l: Lin) => l.c;

/** 화면 표시용: 대상의 지금 위치 */
export function refPoint(p: Project, view: ViewId, r: CRef): [number, number] {
  const q = refPointLin(p, view, r, NOW);
  return [nowVal(q.x), nowVal(q.y)];
}
export function refLine(p: Project, view: ViewId, r: CRef): [[number, number], [number, number]] {
  const [a, b] = lineOf(p, view, r, NOW);
  return [
    [nowVal(a.x), nowVal(a.y)],
    [nowVal(b.x), nowVal(b.y)],
  ];
}
export function refCircle(p: Project, view: ViewId, r: CRef): { c: [number, number]; r: number } {
  const q = circleOf(p, view, r, NOW);
  return { c: [nowVal(q.c.x), nowVal(q.c.y)], r: nowVal(q.r) };
}

// ---------------- 구속 종류 ----------------

/** 구속마다 받는 대상 (순서대로). "point|line"은 둘 중 하나 */
export const SIGNATURES: Record<ConsKind, RefType[][]> = {
  coincident: [["point", "point"]],
  horizontal: [["line"], ["point", "point"]],
  vertical: [["line"], ["point", "point"]],
  parallel: [["line", "line"]],
  perpendicular: [["line", "line"]],
  equal: [["line", "line"], ["circle", "circle"]],
  concentric: [["circle", "circle"]],
  tangent: [["line", "circle"], ["circle", "line"], ["circle", "circle"]],
  symmetric: [["point", "point", "line"]],
  onLine: [["point", "line"], ["point", "circle"]],
  midpoint: [["point", "line"]],
  fix: [["point"]],
  distance: [["point", "point"], ["point", "line"], ["line", "point"]],
  distanceX: [["point", "point"]],
  distanceY: [["point", "point"]],
  angle: [["line", "line"]],
};

export const KIND_LABEL: Record<ConsKind, string> = {
  coincident: "일치",
  horizontal: "수평",
  vertical: "수직",
  parallel: "평행",
  perpendicular: "직각",
  equal: "같게",
  concentric: "동심",
  tangent: "접선",
  symmetric: "대칭",
  onLine: "선 위에",
  midpoint: "가운데",
  fix: "고정",
  distance: "거리",
  distanceX: "가로 거리",
  distanceY: "세로 거리",
  angle: "각도",
};

/** 값이 있는 (치수) 구속 */
export const isDimension = (k: ConsKind) => k === "distance" || k === "distanceX" || k === "distanceY" || k === "angle";

/** 대상 종류가 이 구속에 맞는지 (지금까지 고른 것이 앞부분으로 맞으면 "partial") */
export function matchSignature(kind: ConsKind, types: RefType[]): "full" | "partial" | "no" {
  let partial = false;
  for (const sig of SIGNATURES[kind]) {
    if (types.length > sig.length) continue;
    if (!types.every((t, i) => sig[i] === t)) continue;
    if (types.length === sig.length) return "full";
    partial = true;
  }
  return partial ? "partial" : "no";
}

// ---------------- 식 만들기 ----------------

function dist2(dx: number, dy: number) {
  return Math.hypot(dx, dy) || 1e-12;
}

/** 점 C에서 직선 AB까지 부호 있는 거리와 편미분 [Ax,Ay,Bx,By,Cx,Cy] */
function sdLine(q: number[]): [number, number[]] {
  const [ax, ay, bx, by, cx, cy] = q;
  const dx = bx - ax;
  const dy = by - ay;
  const wx = cx - ax;
  const wy = cy - ay;
  const L = dist2(dx, dy);
  const cr = dx * wy - dy * wx;
  const dcr = [-wy + dy, -dx + wx, wy, -wx, -dy, dx];
  const dL = [-dx / L, -dy / L, dx / L, dy / L, 0, 0];
  return [cr / L, dcr.map((d, i) => (d * L - cr * dL[i]) / (L * L))];
}

/** 이 구속의 식들 (tag = 구속 번호) */
function equationsFor(p: Project, view: ViewId, c: Constraint, tag: number, V: VarOf, value: number): Eq[] {
  const t = c.refs.map((r) => refType(p, view, r)!);
  const P = (i: number) => refPointLin(p, view, c.refs[i], V);
  const Ln = (i: number) => lineOf(p, view, c.refs[i], V);
  const C = (i: number) => circleOf(p, view, c.refs[i], V);
  const diff = (a: Lin, b: Lin) => mkEq(tag, [a, b], ([u, w]) => u - w, () => [1, -1]);
  const side = c.side ?? 1;
  switch (c.kind) {
    case "coincident": {
      const a = P(0);
      const b = P(1);
      return [diff(a.x, b.x), diff(a.y, b.y)];
    }
    case "concentric": {
      const a = C(0).c;
      const b = C(1).c;
      return [diff(a.x, b.x), diff(a.y, b.y)];
    }
    case "horizontal":
    case "vertical": {
      const [a, b] = t[0] === "line" ? Ln(0) : [P(0), P(1)];
      return [c.kind === "horizontal" ? diff(a.y, b.y) : diff(a.x, b.x)];
    }
    case "parallel":
    case "perpendicular": {
      const [a, b] = Ln(0);
      const [d, e] = Ln(1);
      const k = 1 / (lenOf(p, view, c.refs[0]) * lenOf(p, view, c.refs[1]));
      return [
        mkEq(
          tag,
          [a.x, a.y, b.x, b.y, d.x, d.y, e.x, e.y],
          (q) => {
            const [ux, uy, vx, vy] = [q[2] - q[0], q[3] - q[1], q[6] - q[4], q[7] - q[5]];
            return k * (c.kind === "parallel" ? ux * vy - uy * vx : ux * vx + uy * vy);
          },
          (q) => {
            const [ux, uy, vx, vy] = [q[2] - q[0], q[3] - q[1], q[6] - q[4], q[7] - q[5]];
            // parallel: ux·vy − uy·vx / perpendicular: ux·vx + uy·vy
            const g = c.kind === "parallel" ? [-vy, vx, vy, -vx, uy, -ux, -uy, ux] : [-vx, -vy, vx, vy, -ux, -uy, ux, uy];
            return g.map((v) => v * k);
          },
        ),
      ];
    }
    case "equal": {
      if (t[0] === "circle") return [diff(C(0).r, C(1).r)];
      const [a, b] = Ln(0);
      const [d, e] = Ln(1);
      return [
        mkEq(
          tag,
          [a.x, a.y, b.x, b.y, d.x, d.y, e.x, e.y],
          (q) => dist2(q[2] - q[0], q[3] - q[1]) - dist2(q[6] - q[4], q[7] - q[5]),
          (q) => {
            const l1 = dist2(q[2] - q[0], q[3] - q[1]);
            const l2 = dist2(q[6] - q[4], q[7] - q[5]);
            const [ux, uy, vx, vy] = [(q[2] - q[0]) / l1, (q[3] - q[1]) / l1, (q[6] - q[4]) / l2, (q[7] - q[5]) / l2];
            return [-ux, -uy, ux, uy, vx, vy, -vx, -vy];
          },
        ),
      ];
    }
    case "tangent": {
      if (t[0] === "circle" && t[1] === "circle") {
        const a = C(0);
        const b = C(1);
        // side 1: 바깥 접 (중심 거리 = r1 + r2), −1: 안쪽 접 (= |r1 − r2|, 만들 때의 크기 순서 유지)
        const inner = side < 0;
        const sg = inner ? Math.sign(nowVal(circleOf(p, view, c.refs[0], NOW).r) - nowVal(circleOf(p, view, c.refs[1], NOW).r)) || 1 : 1;
        return [
          mkEq(
            tag,
            [a.c.x, a.c.y, b.c.x, b.c.y, a.r, b.r],
            (q) => dist2(q[2] - q[0], q[3] - q[1]) - (inner ? sg * (q[4] - q[5]) : q[4] + q[5]),
            (q) => {
              const L = dist2(q[2] - q[0], q[3] - q[1]);
              const ux = (q[2] - q[0]) / L;
              const uy = (q[3] - q[1]) / L;
              return [-ux, -uy, ux, uy, inner ? -sg : -1, inner ? sg : -1];
            },
          ),
        ];
      }
      const li = t[0] === "line" ? 0 : 1;
      const [a, b] = Ln(li);
      const cc = C(1 - li);
      return [
        mkEq(
          tag,
          [a.x, a.y, b.x, b.y, cc.c.x, cc.c.y, cc.r],
          (q) => sdLine(q)[0] - side * q[6],
          (q) => [...sdLine(q)[1], -side],
        ),
      ];
    }
    case "symmetric": {
      const a = P(0);
      const b = P(1);
      const [l0, l1] = Ln(2);
      const L = lenOf(p, view, c.refs[2]);
      const mid = { x: scale(add(a.x, b.x), 0.5), y: scale(add(a.y, b.y), 0.5) };
      return [
        // 두 점을 잇는 선이 축에 수직
        mkEq(
          tag,
          [a.x, a.y, b.x, b.y, l0.x, l0.y, l1.x, l1.y],
          (q) => ((q[2] - q[0]) * (q[6] - q[4]) + (q[3] - q[1]) * (q[7] - q[5])) / L,
          (q) => {
            const [ux, uy, vx, vy] = [q[2] - q[0], q[3] - q[1], q[6] - q[4], q[7] - q[5]];
            return [-vx, -vy, vx, vy, -ux, -uy, ux, uy].map((v) => v / L);
          },
        ),
        // 가운데 점이 축 위에
        mkEq(tag, [l0.x, l0.y, l1.x, l1.y, mid.x, mid.y], (q) => sdLine(q)[0], (q) => sdLine(q)[1]),
      ];
    }
    case "onLine": {
      const a = P(0);
      if (t[1] === "circle") {
        const cc = C(1);
        return [
          mkEq(
            tag,
            [a.x, a.y, cc.c.x, cc.c.y, cc.r],
            (q) => dist2(q[0] - q[2], q[1] - q[3]) - q[4],
            (q) => {
              const L = dist2(q[0] - q[2], q[1] - q[3]);
              const ux = (q[0] - q[2]) / L;
              const uy = (q[1] - q[3]) / L;
              return [ux, uy, -ux, -uy, -1];
            },
          ),
        ];
      }
      const [l0, l1] = Ln(1);
      return [mkEq(tag, [l0.x, l0.y, l1.x, l1.y, a.x, a.y], (q) => sdLine(q)[0], (q) => sdLine(q)[1])];
    }
    case "midpoint": {
      const a = P(0);
      const [l0, l1] = Ln(1);
      const mx = scale(add(l0.x, l1.x), 0.5);
      const my = scale(add(l0.y, l1.y), 0.5);
      return [diff(a.x, mx), diff(a.y, my)];
    }
    case "fix": {
      const a = P(0);
      const [u, v] = c.at ?? [0, 0];
      return [diff(a.x, lin(u)), diff(a.y, lin(v))];
    }
    case "distanceX":
    case "distanceY": {
      const a = P(0);
      const b = P(1);
      const k = c.kind === "distanceX" ? "x" : "y";
      // b − a = side·값
      return [mkEq(tag, [a[k], b[k]], ([u, w]) => w - u - side * value, () => [-1, 1])];
    }
    case "distance": {
      if (t[0] === "point" && t[1] === "point") {
        const a = P(0);
        const b = P(1);
        return [
          mkEq(
            tag,
            [a.x, a.y, b.x, b.y],
            (q) => dist2(q[2] - q[0], q[3] - q[1]) - value,
            (q) => {
              const L = dist2(q[2] - q[0], q[3] - q[1]);
              const ux = (q[2] - q[0]) / L;
              const uy = (q[3] - q[1]) / L;
              return [-ux, -uy, ux, uy];
            },
          ),
        ];
      }
      const pi = t[0] === "point" ? 0 : 1;
      const a = P(pi);
      const [l0, l1] = Ln(1 - pi);
      return [mkEq(tag, [l0.x, l0.y, l1.x, l1.y, a.x, a.y], (q) => side * sdLine(q)[0] - value, (q) => sdLine(q)[1].map((g) => side * g))];
    }
    case "angle": {
      const [a, b] = Ln(0);
      const [d, e] = Ln(1);
      const th = (value * Math.PI) / 180;
      const k = 1 / (lenOf(p, view, c.refs[0]) * lenOf(p, view, c.refs[1]));
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      // 두 방향 u, v 사이 각이 θ: cross·cosθ − dot·sinθ = 0
      return [
        mkEq(
          tag,
          [a.x, a.y, b.x, b.y, d.x, d.y, e.x, e.y],
          (q) => {
            const [ux, uy, vx, vy] = [q[2] - q[0], q[3] - q[1], q[6] - q[4], q[7] - q[5]];
            return k * ((ux * vy - uy * vx) * cs - (ux * vx + uy * vy) * sn);
          },
          (q) => {
            const [ux, uy, vx, vy] = [q[2] - q[0], q[3] - q[1], q[6] - q[4], q[7] - q[5]];
            const gc = [-vy, vx, vy, -vx, uy, -ux, -uy, ux];
            const gd = [-vx, -vy, vx, vy, -ux, -uy, ux, uy];
            return gc.map((g, i) => k * (g * cs - gd[i] * sn));
          },
        ),
      ];
    }
  }
  return [];
}

function lenOf(p: Project, view: ViewId, r: CRef) {
  const [[ax, ay], [bx, by]] = refLine(p, view, r);
  return dist2(bx - ax, by - ay);
}

// ---------------- 지금 값 재기 (치수 구속을 만들 때·표시) ----------------

/** 치수 구속의 지금 값과 방향 (side) */
export function measure(p: Project, view: ViewId, kind: ConsKind, refs: CRef[]): { value: number; side: number } {
  const t = refs.map((r) => refType(p, view, r)!);
  if (kind === "distanceX" || kind === "distanceY") {
    const a = refPoint(p, view, refs[0]);
    const b = refPoint(p, view, refs[1]);
    const d = kind === "distanceX" ? b[0] - a[0] : b[1] - a[1];
    return { value: Math.abs(d), side: d < 0 ? -1 : 1 };
  }
  if (kind === "distance") {
    if (t[0] === "point" && t[1] === "point") {
      const a = refPoint(p, view, refs[0]);
      const b = refPoint(p, view, refs[1]);
      return { value: Math.hypot(b[0] - a[0], b[1] - a[1]), side: 1 };
    }
    const pi = t[0] === "point" ? 0 : 1;
    const a = refPoint(p, view, refs[pi]);
    const [l0, l1] = refLine(p, view, refs[1 - pi]);
    const d = sdLine([...l0, ...l1, ...a])[0];
    return { value: Math.abs(d), side: d < 0 ? -1 : 1 };
  }
  if (kind === "angle") {
    const [a, b] = refLine(p, view, refs[0]);
    const [d, e] = refLine(p, view, refs[1]);
    const ang = Math.atan2((b[0] - a[0]) * (e[1] - d[1]) - (b[1] - a[1]) * (e[0] - d[0]), (b[0] - a[0]) * (e[0] - d[0]) + (b[1] - a[1]) * (e[1] - d[1]));
    return { value: (ang * 180) / Math.PI, side: 1 };
  }
  if (kind === "tangent") {
    if (t[0] === "circle" && t[1] === "circle") {
      const a = refCircle(p, view, refs[0]);
      const b = refCircle(p, view, refs[1]);
      const d = Math.hypot(b.c[0] - a.c[0], b.c[1] - a.c[1]);
      // 중심 거리가 반지름 합에 더 가까우면 바깥 접
      return { value: 0, side: Math.abs(d - (a.r + b.r)) <= Math.abs(d - Math.abs(a.r - b.r)) ? 1 : -1 };
    }
    const li = t[0] === "line" ? 0 : 1;
    const [l0, l1] = refLine(p, view, refs[li]);
    const cc = refCircle(p, view, refs[1 - li]);
    return { value: 0, side: sdLine([...l0, ...l1, ...cc.c])[0] < 0 ? -1 : 1 };
  }
  return { value: 0, side: 1 };
}

// ---------------- 정리 ----------------

/** 쓸 수 없게 된 구속(지운 도형, 바뀐 꼭짓점 수, 휜 변) 빼기. 바뀌었으면 true */
export function pruneConstraints(p: Project): boolean {
  if (!p.constraints) return false;
  let changed = false;
  for (const v of VIEW_IDS) {
    const list = p.constraints[v];
    if (!list) continue;
    const keep = list.filter((c) => {
      const types = c.refs.map((r) => refType(p, v, r));
      return !types.includes(null) && matchSignature(c.kind, types as RefType[]) === "full";
    });
    if (keep.length !== list.length) {
      changed = true;
      if (keep.length) p.constraints[v] = keep;
      else delete p.constraints[v];
    }
  }
  if (p.constraints && !Object.keys(p.constraints).length) delete p.constraints;
  return changed;
}

/** 이 도형이 나오는 구속 */
export const constraintsOf = (p: Project, view: ViewId, shapeId: string) => (p.constraints?.[view] ?? []).filter((c) => c.refs.some((r) => r.s === shapeId));

// ---------------- 풀기 ----------------

export interface ViewSolve {
  ok: boolean;
  /** 풀리지 않을 때 부딪치는 구속 id */
  conflicting: string[];
  /** 도형 크기가 0 이하가 되는 등 받아들일 수 없는 해 */
  invalid?: string;
}

interface Built {
  x: Float64Array;
  slots: { s: Shape2D; key: string; idx: number }[];
  eqs: Eq[];
  cons: Constraint[];
}

/**
 * 뷰의 식 만들기. fixed: "도형id:변수" — 움직이지 않을 변수(방금 바꾼 값, 끄는 도형).
 * values: 치수 구속의 식 값 (없으면 저장된 값)
 */
function build(p: Project, view: ViewId, fixed: Set<string>, values?: Map<string, number>): Built {
  const cons = p.constraints?.[view] ?? [];
  const used = new Set<string>();
  for (const c of cons) for (const r of c.refs) if (!r.s.startsWith("@")) used.add(r.s);
  const slots: Built["slots"] = [];
  const index = new Map<string, number>();
  const xs: number[] = [];
  for (const s of p.views[view]) {
    if (!used.has(s.id)) continue;
    const locked = new Set(lockedVars(s));
    for (const key of shapeVarKeys(s)) {
      if (locked.has(key) || fixed.has(`${s.id}:${key}`) || fixed.has(`${s.id}:*`)) continue;
      index.set(`${s.id}:${key}`, xs.length);
      slots.push({ s, key, idx: xs.length });
      xs.push(getVar(s, key));
    }
  }
  const V: VarOf = (s, key) => {
    const i = index.get(`${s.id}:${key}`);
    return i === undefined ? lin(getVar(s, key)) : lin(0, [[i, 1]]);
  };
  const eqs: Eq[] = [];
  cons.forEach((c, i) => {
    const value = values?.get(c.id) ?? c.value ?? 0;
    eqs.push(...equationsFor(p, view, c, i, V, value));
  });
  return { x: Float64Array.from(xs), slots, eqs, cons };
}

/** 풀어서 도형에 쓴다. 풀 수 없으면 도형은 그대로 두고 ok: false */
export function solveView(p: Project, view: ViewId, opts: { fixed?: Set<string>; values?: Map<string, number> } = {}): ViewSolve {
  const cons = p.constraints?.[view];
  if (!cons?.length) return { ok: true, conflicting: [] };
  // 사각형은 가로·세로가 양수인 모양으로 (꼭짓점 번호가 바뀌지 않게)
  for (const s of p.views[view]) if (s.kind === "rect" && (s.w < 0 || s.h < 0)) Object.assign(s, { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) });
  const b = build(p, view, opts.fixed ?? new Set(), opts.values);
  const x = Float64Array.from(b.x);
  const r = solve(x, b.eqs);
  if (!r.ok) {
    // 어느 구속이 문제인지: 중복으로 지목된 식 중 만족 안 된 것
    const an = analyze(x, b.eqs);
    const bad = new Set<string>();
    for (const i of an.redundant) if (Math.abs(b.eqs[i].f(x)) > 1e-6) bad.add(b.cons[b.eqs[i].tag].id);
    if (!bad.size) for (const e of b.eqs) if (Math.abs(e.f(x)) > 1e-6) bad.add(b.cons[e.tag].id);
    return { ok: false, conflicting: [...bad] };
  }
  // 크기가 0 이하가 되면 받아들이지 않는다
  for (const sl of b.slots)
    if ((sl.key === "w" || sl.key === "h" || sl.key === "r") && x[sl.idx] <= 1e-6) return { ok: false, conflicting: [], invalid: "크기가 0 이하가 돼요" };
  for (const sl of b.slots) setVar(sl.s, sl.key, x[sl.idx]);
  return { ok: true, conflicting: [] };
}

/** 모든 뷰 */
export function solveAll(p: Project, opts: { fixed?: Set<string>; values?: Map<string, number> } = {}): ViewSolve {
  const conflicting: string[] = [];
  let invalid: string | undefined;
  for (const v of VIEW_IDS) {
    const r = solveView(p, v, opts);
    if (!r.ok) {
      conflicting.push(...r.conflicting);
      invalid ??= r.invalid;
    }
  }
  return { ok: !conflicting.length && !invalid, conflicting, invalid };
}

// ---------------- 분석 (자유도·다 정해졌는지) ----------------

export type ShapeState = "full" | "partial" | "free";

export interface ViewAnalysis {
  /** 남은 자유도 (구속에 안 걸린 도형의 잠기지 않은 치수도 셈) */
  dof: number;
  shapes: Map<string, ShapeState>;
  /** 앞의 구속으로 이미 정해진 (필요 없는) 구속 */
  redundant: string[];
  /** 지금 만족되지 않는 구속 */
  unsatisfied: string[];
}

export function analyzeView(p: Project, view: ViewId): ViewAnalysis {
  const b = build(p, view, new Set());
  const an = analyze(b.x, b.eqs, b.x.length);
  const shapes = new Map<string, ShapeState>();
  const det = new Map<string, boolean[]>();
  for (const sl of b.slots) {
    if (!det.has(sl.s.id)) det.set(sl.s.id, []);
    det.get(sl.s.id)!.push(!!an.determined[sl.idx]);
  }
  // 구속에 걸린 도형의 변수 중 어느 식에도 안 나오는 것도 자유도
  const inEq = new Set(b.eqs.flatMap((e) => e.vars));
  let dof = an.dof + b.slots.filter((sl) => !inEq.has(sl.idx)).length;
  for (const s of p.views[view]) {
    const d = det.get(s.id);
    if (d) {
      // 구속에 걸린 도형: 고정 변수(잠금)는 정해진 것, 나머지는 분석 결과
      shapes.set(s.id, d.every(Boolean) ? "full" : "partial");
      continue;
    }
    const all = shapeVarKeys(s).length;
    const locked = s.kind === "poly" ? 0 : new Set(lockedVars(s)).size;
    dof += all - locked;
    shapes.set(s.id, locked >= all ? "full" : locked ? "partial" : "free");
  }
  // 구속에 걸린 도형도 고정 변수만 있고 식 변수가 하나도 없으면 다 정해짐
  for (const s of p.views[view]) if (!det.has(s.id) && b.cons.some((c) => c.refs.some((r) => r.s === s.id))) shapes.set(s.id, "full");
  const redundant = [...new Set(an.redundant.map((i) => b.cons[b.eqs[i].tag].id))];
  const unsatisfied = [...new Set(b.eqs.filter((e) => Math.abs(e.f(b.x)) > 1e-6).map((e) => b.cons[e.tag].id))];
  return { dof, shapes, redundant, unsatisfied };
}

export function newConstraintId() {
  return `k${Math.random().toString(36).slice(2, 9)}`;
}
