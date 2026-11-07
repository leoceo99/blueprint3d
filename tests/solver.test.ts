// 10단계 (R4): 구속 해석기 — 풀이, 가장 적게 움직이기, 계수·자유도, 중복·충돌, 속도
import { describe, expect, it } from "vitest";
import { analyze, solve, type Eq } from "../src/core/solver";

// 점 i = (x[2i], x[2i+1])
const X = (i: number) => 2 * i;
const Y = (i: number) => 2 * i + 1;
let tagSeq = 0;
const eq = (vars: number[], f: (x: Float64Array) => number, g: (x: Float64Array) => number[], tag = tagSeq++): Eq => ({ tag, vars, f, g });
const coincident = (a: number, b: number): Eq[] => [
  eq([X(a), X(b)], (x) => x[X(a)] - x[X(b)], () => [1, -1]),
  eq([Y(a), Y(b)], (x) => x[Y(a)] - x[Y(b)], () => [1, -1]),
];
const horizontal = (a: number, b: number, tag?: number) => eq([Y(a), Y(b)], (x) => x[Y(a)] - x[Y(b)], () => [1, -1], tag);
const distance = (a: number, b: number, d: number, tag?: number) =>
  eq(
    [X(a), Y(a), X(b), Y(b)],
    (x) => Math.hypot(x[X(b)] - x[X(a)], x[Y(b)] - x[Y(a)]) - d,
    (x) => {
      const dx = x[X(b)] - x[X(a)];
      const dy = x[Y(b)] - x[Y(a)];
      const l = Math.hypot(dx, dy) || 1;
      return [-dx / l, -dy / l, dx / l, dy / l];
    },
    tag,
  );
const fixPt = (a: number, px: number, py: number): Eq[] => [
  eq([X(a)], (x) => x[X(a)] - px, () => [1]),
  eq([Y(a)], (x) => x[Y(a)] - py, () => [1]),
];

describe("해석기", () => {
  it("일치: 두 점이 반씩 움직여 만남 (가장 적게 움직이는 해)", () => {
    const x = Float64Array.from([0, 0, 10, 4]);
    const r = solve(x, coincident(0, 1));
    expect(r.ok).toBe(true);
    expect([...x].map((v) => +v.toFixed(9))).toEqual([5, 2, 5, 2]);
  });

  it("거리: 선을 따라 양쪽으로 똑같이", () => {
    const x = Float64Array.from([0, 0, 8, 0]);
    const r = solve(x, [distance(0, 1, 10), horizontal(0, 1)]);
    expect(r.ok).toBe(true);
    expect(x[0]).toBeCloseTo(-1, 6);
    expect(x[2]).toBeCloseTo(9, 6);
    expect(x[1]).toBeCloseTo(0, 9);
  });

  it("삼각형: 세 변 길이 → 모양은 정해지고 자유도 3 (평행 이동 2 + 회전 1)", () => {
    const x = Float64Array.from([0, 0, 9, 1, 3, 5]);
    const eqs = [distance(0, 1, 10), distance(1, 2, 8), distance(2, 0, 6)];
    expect(solve(x, eqs).ok).toBe(true);
    const d = (a: number, b: number) => Math.hypot(x[X(a)] - x[X(b)], x[Y(a)] - x[Y(b)]);
    expect(d(0, 1)).toBeCloseTo(10, 7);
    expect(d(1, 2)).toBeCloseTo(8, 7);
    const an = analyze(x, eqs);
    expect(an.rank).toBe(3);
    expect(an.dof).toBe(3);
    expect(an.redundant).toEqual([]);
    // 한 점을 고정하고 한 변을 수평으로 → 다 정해짐
    const all = [...eqs, ...fixPt(0, x[0], x[1]), horizontal(0, 1)];
    expect(solve(x, all).ok).toBe(true);
    const an2 = analyze(x, all);
    expect(an2.dof).toBe(0);
    expect([...an2.determined]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("변수별 정해짐: 수평만 주면 y는 묶이지만 혼자 정해지진 않음", () => {
    const x = Float64Array.from([0, 0, 5, 0]);
    const eqs = [...fixPt(0, 0, 0), horizontal(0, 1)];
    const an = analyze(x, eqs);
    expect([...an.determined]).toEqual([1, 1, 0, 1]);
    // 자유도는 식에 나오는 변수만 센다 (x1은 어느 식에도 없어서 부르는 쪽이 따로 더함)
    expect(an.dof).toBe(0);
  });

  it("중복·충돌: 나중에 넣은 식을 지목", () => {
    const x = Float64Array.from([0, 0, 10, 0]);
    const dup = [horizontal(0, 1, 100), horizontal(0, 1, 101)];
    expect(analyze(x, dup).redundant).toEqual([1]);
    expect(solve(x, dup).ok).toBe(true); // 중복이지만 부딪치지는 않음
    const conflict = [distance(0, 1, 10, 200), distance(0, 1, 20, 201)];
    const r = solve(Float64Array.from([0, 0, 12, 0]), conflict);
    expect(r.ok).toBe(false);
    expect(analyze(x, conflict).redundant).toEqual([1]);
  });

  it("이어지지 않은 묶음은 따로 (한쪽이 실패해도 다른 쪽은 풀림)", () => {
    const x = Float64Array.from([0, 0, 1, 0, 50, 0, 60, 0]);
    const eqs = [distance(0, 1, 5), distance(2, 3, 10, 1), distance(2, 3, 20, 2)];
    const r = solve(x, eqs);
    expect(r.ok).toBe(false);
    expect(Math.hypot(x[2] - x[0], x[3] - x[1])).toBeCloseTo(5, 7);
  });

  it("속도: 구속 50개 10ms, 500개 100ms 안 (끌기 중에도 매 프레임)", () => {
    // 50개: 점 26개를 잇는 사슬 (거리 25 + 수평 25)
    const chain = (n: number) => {
      const x = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        x[X(i)] = i * 9 + Math.sin(i) * 2;
        x[Y(i)] = Math.cos(i) * 3;
      }
      const eqs: Eq[] = [];
      for (let i = 0; i + 1 < n; i++) eqs.push(distance(i, i + 1, 10), horizontal(i, i + 1));
      return { x, eqs };
    };
    // 앱에서는 해석기가 계속 돌기 때문에 처음 한 번(JIT 준비)은 빼고 잰다
    for (let w = 0; w < 5; w++) {
      const c = chain(26);
      solve(c.x, c.eqs);
      analyze(c.x, c.eqs);
    }
    const a = chain(26);
    let t = performance.now();
    expect(solve(a.x, a.eqs).ok).toBe(true);
    const t50 = performance.now() - t;
    // 500개: 구멍 250개가 각자 (위치 2개씩) — 실제 부품처럼 작은 묶음이 많음
    const n = 500;
    const x = new Float64Array(2 * n);
    const eqs: Eq[] = [];
    for (let i = 0; i < n; i += 2) {
      x[X(i)] = i;
      x[X(i + 1)] = i + 3;
      x[Y(i + 1)] = 1;
      eqs.push(distance(i, i + 1, 5), horizontal(i, i + 1));
    }
    t = performance.now();
    expect(solve(x, eqs).ok).toBe(true);
    const t500 = performance.now() - t;
    // 큰 한 묶음 200개 (가장 나쁜 경우)
    const b = chain(101);
    t = performance.now();
    expect(solve(b.x, b.eqs).ok).toBe(true);
    const t200 = performance.now() - t;
    console.log(`해석기 속도: 50개 ${t50.toFixed(1)}ms · 500개(작은 묶음) ${t500.toFixed(1)}ms · 한 묶음 200개 ${t200.toFixed(1)}ms`);
    expect(t50).toBeLessThan(10);
    expect(t500).toBeLessThan(100);
    expect(t200).toBeLessThan(150);
  });
});
