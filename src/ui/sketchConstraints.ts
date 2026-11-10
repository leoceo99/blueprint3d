/**
 * 제도판 위의 구속 (10단계): 대상 고르기(점·변·원), 구속 기호와 치수 구속 그리기, 누를 영역, 도형 상태(다 정해짐).
 * SketchPane(뷰 하나)이 이 층을 하나씩 갖는다.
 */
import {
  analyzeView,
  isDimension,
  KIND_LABEL,
  matchSignature,
  measure,
  refCircle,
  refLine,
  refPoint,
  refType,
  type RefType,
  type ShapeState,
  type ViewAnalysis,
} from "../core/constraints";
import { fmtLen } from "../core/units";
import type { Constraint, CRef, Shape2D } from "../core/types";
import { slotCons, slotShapes, type SlotId } from "../core/featureModel";
import { store } from "../store";
import { ui } from "./state";

type Pt = [number, number];

export interface Candidate {
  ref: CRef;
  type: RefType;
  /** 화면 좌표: 점이면 그 점, 선이면 두 끝, 원이면 중심과 반지름(px) */
  screen: { pt?: Pt; a?: Pt; b?: Pt; c?: Pt; r?: number };
  dist: number;
}

/** SketchPane이 넘겨 주는 것 */
export interface PaneLike {
  readonly view: SlotId;
  toScreen(u: number, v: number): [number, number];
  /** 화면에서 이 뷰가 차지하는 사각형 (축을 그릴 범위) */
  region(): [number, number, number, number];
}

const GLYPH: Partial<Record<Constraint["kind"], string>> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  concentric: "◎",
  tangent: "T",
  symmetric: "⇹",
  onLine: "∈",
  midpoint: "M",
  fix: "⌖",
  coincident: "•",
};

export class ConstraintLayer {
  /** 화면에 그린 구속의 누를 영역 */
  hits: { box: [number, number, number, number]; id: string; dim: boolean }[] = [];
  private cache: { version: number; an: ViewAnalysis } | null = null;

  constructor(private pane: PaneLike) {}

  private get view() {
    return this.pane.view;
  }

  /** 자유도·도형 상태 (프로젝트가 바뀔 때만 다시 계산) */
  analysis(): ViewAnalysis {
    if (this.cache?.version !== store.version) this.cache = { version: store.version, an: analyzeView(store.project, this.view) };
    return this.cache.an;
  }

  stateOf(id: string): ShapeState | undefined {
    return this.analysis().shapes.get(id);
  }

  // ---------------- 고르기 ----------------

  /** 커서 근처의 대상 (지금 구속 종류가 받는 것만). 점 > 원 > 선 순서로 */
  pick(x: number, y: number, allow?: (t: RefType) => boolean): Candidate | null {
    const p = store.project;
    const S = (u: number, v: number) => this.pane.toScreen(u, v);
    const out: Candidate[] = [];
    const pushPt = (ref: CRef, w: Pt) => {
      const pt = S(w[0], w[1]);
      out.push({ ref, type: "point", screen: { pt }, dist: Math.hypot(pt[0] - x, pt[1] - y) - 3 });
    };
    const pushLine = (ref: CRef, a: Pt, b: Pt) => {
      const A = S(a[0], a[1]);
      const B = S(b[0], b[1]);
      out.push({ ref, type: "line", screen: { a: A, b: B }, dist: segDist([x, y], A, B) });
    };
    const pushCircle = (ref: CRef, c: Pt, r: number) => {
      const C = S(c[0], c[1]);
      const R = Math.abs(S(c[0] + r, c[1])[0] - C[0]);
      out.push({ ref, type: "circle", screen: { c: C, r: R }, dist: Math.abs(Math.hypot(C[0] - x, C[1] - y) - R) + 1 });
    };
    for (const s of slotShapes(p, this.view)) {
      for (const k of pointKeys(s)) pushPt({ s: s.id, k }, refPoint(p, this.view, { s: s.id, k }));
      for (const k of lineKeys(s)) {
        const [a, b] = refLine(p, this.view, { s: s.id, k });
        pushLine({ s: s.id, k }, a, b);
      }
      for (const k of circleKeys(s)) {
        const c = refCircle(p, this.view, { s: s.id, k });
        pushCircle({ s: s.id, k }, c.c, c.r);
      }
    }
    pushPt({ s: "@o", k: "" }, [0, 0]);
    // 축: 화면 안의 긴 선
    const [rx0, ry0, rx1, ry1] = this.pane.region();
    const o = S(0, 0);
    if (o[1] > ry0 && o[1] < ry1) out.push({ ref: { s: "@x", k: "" }, type: "line", screen: { a: [rx0, o[1]], b: [rx1, o[1]] }, dist: Math.abs(o[1] - y) + 2 });
    if (o[0] > rx0 && o[0] < rx1) out.push({ ref: { s: "@y", k: "" }, type: "line", screen: { a: [o[0], ry0], b: [o[0], ry1] }, dist: Math.abs(o[0] - x) + 2 });
    const tol = { point: 9, circle: 6, line: 6 };
    const ok = out.filter((c) => c.dist < tol[c.type] && (!allow || allow(c.type)));
    ok.sort((a, b) => rank(a) - rank(b));
    return ok[0] ?? null;
  }

  /** 구속 도구로 누른 곳: 받을 수 있으면 고른 목록에 넣고, 다 고르면 구속을 돌려준다 */
  pickForTool(x: number, y: number): { done: Constraint | null; picked: boolean } {
    const p = store.project;
    const kind = ui.consKind;
    const types = ui.consPicks.map((r) => refType(p, this.view, r)!) as RefType[];
    const cand = this.pick(x, y, (t) => matchSignature(kind, [...types, t]) !== "no");
    if (!cand) return { done: null, picked: false };
    // 같은 대상을 두 번 고르지 않게
    if (ui.consPicks.some((r) => r.s === cand.ref.s && r.k === cand.ref.k)) return { done: null, picked: false };
    ui.consPicks = [...ui.consPicks, cand.ref];
    const m = matchSignature(kind, [...types, cand.type]);
    if (m !== "full") return { done: null, picked: true };
    const refs = ui.consPicks;
    ui.consPicks = [];
    const c: Constraint = { id: `k${Math.random().toString(36).slice(2, 9)}`, kind, refs };
    if (isDimension(kind) || kind === "tangent") {
      const mm = measure(p, this.view, kind, refs);
      if (isDimension(kind)) c.value = Math.round(mm.value * 1000) / 1000;
      if (kind !== "angle") c.side = mm.side;
    }
    if (kind === "fix") c.at = refPoint(p, this.view, refs[0]);
    return { done: c, picked: true };
  }

  // ---------------- 그리기 ----------------

  draw(c: CanvasRenderingContext2D, col: { cons: string; bg: string; accent: string; error: string }, hover: Candidate | null) {
    this.hits = [];
    const p = store.project;
    const list = slotCons(p, this.view) ?? [];
    const S = (w: Pt) => this.pane.toScreen(w[0], w[1]);
    const bad = new Set(this.analysis().unsatisfied);
    const selId = ui.selCons?.view === this.view ? ui.selCons.id : null;
    if (ui.showCons)
      for (const k of list) {
        const color = bad.has(k.id) ? col.error : k.id === selId ? col.accent : col.cons;
        if (isDimension(k.kind)) this.drawDim(c, k, color, col.bg);
        else this.drawGlyph(c, k, color, col.bg, S);
      }
    // 구속 도구: 고른 대상과 커서 아래 후보
    if (ui.tool === "constrain") {
      for (const r of ui.consPicks) this.highlight(c, r, col.accent, 3);
      if (hover) this.highlightCand(c, hover, col.cons);
    }
  }

  private drawGlyph(c: CanvasRenderingContext2D, k: Constraint, color: string, bg: string, S: (w: Pt) => Pt) {
    const p = store.project;
    const v = this.view;
    const anchors: Pt[] = [];
    const t = k.refs.map((r) => refType(p, v, r));
    const mid = (r: CRef): Pt => {
      const [a, b] = refLine(p, v, r);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    const top = (r: CRef): Pt => {
      const cc = refCircle(p, v, r);
      return [cc.c[0], cc.c[1] + cc.r];
    };
    const at = (i: number): Pt => (t[i] === "point" ? refPoint(p, v, k.refs[i]) : t[i] === "line" ? mid(k.refs[i]) : top(k.refs[i]));
    if (k.kind === "coincident") {
      const [x, y] = S(refPoint(p, v, k.refs[0]));
      c.fillStyle = color;
      c.beginPath();
      c.arc(x, y, 3.5, 0, Math.PI * 2);
      c.fill();
      this.hits.push({ box: [x - 6, y - 6, x + 6, y + 6], id: k.id, dim: false });
      return;
    }
    if (k.kind === "horizontal" || k.kind === "vertical") {
      if (t[0] === "line") anchors.push(mid(k.refs[0]));
      else {
        const a = refPoint(p, v, k.refs[0]);
        const b = refPoint(p, v, k.refs[1]);
        anchors.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    } else if (k.kind === "symmetric") {
      const a = refPoint(p, v, k.refs[0]);
      const b = refPoint(p, v, k.refs[1]);
      anchors.push(a, b);
    } else if (k.kind === "fix" || k.kind === "midpoint" || k.kind === "onLine") anchors.push(refPoint(p, v, k.refs[0]));
    else if (k.kind === "tangent" || k.kind === "concentric") anchors.push(at(1));
    else for (let i = 0; i < k.refs.length; i++) anchors.push(at(i));
    const text = GLYPH[k.kind] ?? "?";
    anchors.forEach((w, i) => {
      const [x0, y0] = S(w);
      // 겹치지 않게 조금 비켜서 (같은 곳의 여러 기호는 옆으로)
      const x = x0 + 10 + i * 0;
      const y = y0 - 10;
      c.font = "700 10px system-ui, sans-serif";
      const tw = Math.max(14, c.measureText(text).width + 8);
      c.fillStyle = bg;
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.beginPath();
      c.roundRect(x - tw / 2, y - 7, tw, 14, 3);
      c.fill();
      c.stroke();
      c.fillStyle = color;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, x, y + 0.5);
      this.hits.push({ box: [x - tw / 2, y - 7, x + tw / 2, y + 7], id: k.id, dim: false });
    });
  }

  /** 치수 구속: 보조선·치수선·값 (누르면 고치기) */
  private drawDim(c: CanvasRenderingContext2D, k: Constraint, color: string, bg: string) {
    const p = store.project;
    const v = this.view;
    const S = (w: Pt) => this.pane.toScreen(w[0], w[1]);
    let a: Pt;
    let b: Pt;
    let label: string;
    if (k.kind === "angle") {
      const [l0, l1] = refLine(p, v, k.refs[0]);
      const [m0, m1] = refLine(p, v, k.refs[1]);
      const ma: Pt = [(l0[0] + l1[0]) / 2, (l0[1] + l1[1]) / 2];
      const mb: Pt = [(m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2];
      const [x, y] = S([(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2]);
      this.valueBox(c, `∠ ${round(k.value ?? 0)}°${k.expr ? " fx" : ""}`, x, y, color, bg, k.id);
      return;
    }
    const t = k.refs.map((r) => refType(p, v, r));
    if (k.kind === "distance" && t.includes("line")) {
      const pi = t[0] === "point" ? 0 : 1;
      a = refPoint(p, v, k.refs[pi]);
      const [l0, l1] = refLine(p, v, k.refs[1 - pi]);
      b = footOn(a, l0, l1);
    } else {
      a = refPoint(p, v, k.refs[0]);
      b = refPoint(p, v, k.refs[1]);
    }
    const A = S(a);
    const B = S(b);
    let P1: Pt = A;
    let P2: Pt = B;
    const off = 22;
    if (k.kind === "distanceX") {
      const yy = Math.min(A[1], B[1]) - off;
      P1 = [A[0], yy];
      P2 = [B[0], yy];
    } else if (k.kind === "distanceY") {
      const xx = Math.max(A[0], B[0]) + off;
      P1 = [xx, A[1]];
      P2 = [xx, B[1]];
    }
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 1;
    c.setLineDash([3, 2]);
    c.beginPath();
    c.moveTo(A[0], A[1]);
    c.lineTo(P1[0], P1[1]);
    c.moveTo(B[0], B[1]);
    c.lineTo(P2[0], P2[1]);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(P1[0], P1[1]);
    c.lineTo(P2[0], P2[1]);
    c.stroke();
    for (const [q, r] of [
      [P1, P2],
      [P2, P1],
    ] as [Pt, Pt][]) {
      const L = Math.hypot(r[0] - q[0], r[1] - q[1]);
      if (L < 12) continue;
      const ux = (r[0] - q[0]) / L;
      const uy = (r[1] - q[1]) / L;
      c.beginPath();
      c.moveTo(q[0], q[1]);
      c.lineTo(q[0] + ux * 7 - uy * 3, q[1] + uy * 7 + ux * 3);
      c.lineTo(q[0] + ux * 7 + uy * 3, q[1] + uy * 7 - ux * 3);
      c.closePath();
      c.fill();
    }
    label = `${k.kind === "distanceX" ? "↔ " : k.kind === "distanceY" ? "↕ " : ""}${fmtLen(k.value ?? 0)}${k.expr ? " fx" : ""}`;
    this.valueBox(c, label, (P1[0] + P2[0]) / 2, (P1[1] + P2[1]) / 2, color, bg, k.id);
  }

  private valueBox(c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, bg: string, id: string) {
    c.font = "600 11px system-ui, sans-serif";
    const tw = c.measureText(text).width + 12;
    const box: [number, number, number, number] = [x - tw / 2, y - 10, x + tw / 2, y + 10];
    c.fillStyle = bg;
    c.strokeStyle = color;
    c.lineWidth = 1.2;
    c.beginPath();
    c.roundRect(box[0], box[1], tw, 20, 5);
    c.fill();
    c.stroke();
    c.fillStyle = color;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, x, y + 0.5);
    this.hits.push({ box, id, dim: true });
  }

  private highlight(c: CanvasRenderingContext2D, r: CRef, color: string, width: number) {
    const p = store.project;
    const t = refType(p, this.view, r);
    if (!t) return;
    const S = (w: Pt) => this.pane.toScreen(w[0], w[1]);
    const screen: Candidate["screen"] = {};
    if (t === "point") screen.pt = S(refPoint(p, this.view, r));
    else if (t === "line") {
      if (r.s === "@x" || r.s === "@y") {
        const [rx0, ry0, rx1, ry1] = this.pane.region();
        const o = S([0, 0]);
        screen.a = r.s === "@x" ? [rx0, o[1]] : [o[0], ry0];
        screen.b = r.s === "@x" ? [rx1, o[1]] : [o[0], ry1];
      } else {
        const [a, b] = refLine(p, this.view, r);
        screen.a = S(a);
        screen.b = S(b);
      }
    } else {
      const cc = refCircle(p, this.view, r);
      screen.c = S(cc.c);
      screen.r = Math.abs(S([cc.c[0] + cc.r, cc.c[1]])[0] - screen.c[0]);
    }
    this.highlightCand(c, { ref: r, type: t, screen, dist: 0 }, color, width);
  }

  private highlightCand(c: CanvasRenderingContext2D, cand: Candidate, color: string, width = 2.5) {
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = width;
    c.globalAlpha = 0.85;
    const s = cand.screen;
    if (s.pt) {
      c.beginPath();
      c.arc(s.pt[0], s.pt[1], 5, 0, Math.PI * 2);
      c.stroke();
    } else if (s.a && s.b) {
      c.beginPath();
      c.moveTo(s.a[0], s.a[1]);
      c.lineTo(s.b[0], s.b[1]);
      c.stroke();
    } else if (s.c && s.r !== undefined) {
      c.beginPath();
      c.arc(s.c[0], s.c[1], s.r, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** 기호·값 위를 눌렀으면 그 구속 */
  hit(x: number, y: number) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.box[0] && x <= h.box[2] && y >= h.box[1] && y <= h.box[3]) return h;
    }
    return null;
  }
}

// ---------------- 도움 ----------------

export function pointKeys(s: Shape2D): string[] {
  if (s.kind === "rect") return ["v0", "v1", "v2", "v3", "c"];
  if (s.kind === "circle") return ["c"];
  if (s.kind === "slot") return ["a", "b", "c"];
  return s.pts.map((_, i) => `v${i}`);
}
export function lineKeys(s: Shape2D): string[] {
  if (s.kind === "rect") return ["e0", "e1", "e2", "e3"];
  if (s.kind === "slot") return ["e0"];
  if (s.kind === "poly") return s.pts.map((_, i) => `e${i}`).filter((_, i) => !s.bulges?.[i]);
  return [];
}
export function circleKeys(s: Shape2D): string[] {
  if (s.kind === "circle") return ["o"];
  if (s.kind === "slot") return ["ra", "rb"];
  return [];
}

const rank = (c: Candidate) => c.dist + (c.type === "point" ? -4 : c.type === "circle" ? -1 : 0);

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function footOn(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  return [a[0] + t * dx, a[1] + t * dy];
}

const round = (n: number) => String(Math.round(n * 100) / 100);

/** 구속 한 줄 설명: “가로 거리 15 mm — 사각형 왼쪽 아래 ↔ 원 중심” */
export function describeConstraint(k: Constraint, name: (r: CRef) => string): string {
  const v = isDimension(k.kind) ? (k.kind === "angle" ? ` ${round(k.value ?? 0)}°` : ` ${fmtLen(k.value ?? 0)}`) : "";
  return `${KIND_LABEL[k.kind]}${v}${k.expr ? ` (= ${k.expr})` : ""} — ${k.refs.map(name).join(" · ")}`;
}
