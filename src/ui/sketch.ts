import {
  area,
  arcInfo,
  boundsOf,
  bulgeThrough,
  flatten,
  isDegenerate,
  normRect,
  outline,
  pointInShape,
  rectPoints,
  rectToPoly,
  shapeCenter,
  translated,
} from "../core/geometry2d";
import { holeLabel, specDiameter, threadRow } from "../core/standards";
import { plainNumber } from "../core/expr";
import { getDim, setDimInput } from "../core/params";
import { VIEW_AXES, VIEW_IDS, VIEW_LABEL, type Severity, type Shape2D, type ViewId } from "../core/types";
import { newId, store } from "../store";
import type { DraftBoard } from "./board";
import { ui } from "./state";
import { underlayCanvas } from "../underlay";

type Pt = [number, number];
const AX = { X: 0, Y: 1, Z: 2 } as const;

interface Guide {
  axis: "u" | "v";
  value: number;
}

type Drag =
  | { kind: "move"; shape: Shape2D; orig: Shape2D; anchor: Pt; grab: Pt; moved: boolean }
  | { kind: "vertex"; shape: Shape2D; index: number; moved: boolean }
  /** 변 가운데 손잡이를 끌어 변을 원호로 휘게 */
  | { kind: "bend"; shapeId: string; index: number; moved: boolean };

/** 선택한 도형의 손잡이: 꼭짓점(크기 조절) 또는 변 가운데(휘기) */
interface Handle {
  pt: Pt;
  kind: "vertex" | "mid";
  index: number;
}

/** 사각형/원 그리기 중 상태 (끌어서 그리기, 또는 클릭-클릭) */
interface Creating {
  shape: Shape2D;
  start: Pt;
  downAt: [number, number];
  dragged: boolean;
}

interface Colors {
  bg: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  solidFill: string;
  solidStroke: string;
  holeStroke: string;
  accent: string;
  guide: string;
  snap: string;
  text: string;
  error: string;
  warning: string;
  info: string;
  blindFill: string;
  result: string;
  boardBg: string;
  frame: string;
  frameLabelBg: string;
  cornerBg: string;
  underlayInk: string;
}

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v("--canvas-bg"),
    gridMinor: v("--grid-minor"),
    gridMajor: v("--grid-major"),
    axis: v("--axis"),
    solidFill: v("--solid-fill"),
    solidStroke: v("--solid-stroke"),
    holeStroke: v("--hole-stroke"),
    accent: v("--accent"),
    guide: v("--guide"),
    snap: v("--snap"),
    text: v("--text-muted"),
    error: v("--sev-error"),
    warning: v("--sev-warning"),
    info: v("--sev-info"),
    blindFill: v("--blind-fill"),
    result: v("--result-line"),
    boardBg: v("--board-bg"),
    frame: v("--frame"),
    frameLabelBg: v("--frame-label-bg"),
    cornerBg: v("--corner-bg"),
    underlayInk: v("--underlay-ink"),
  };
}

let colors: Colors | null = null;
export function refreshColors() {
  colors = readColors();
}
export function palette(): Colors {
  if (!colors) colors = readColors();
  return colors;
}

/**
 * 제도판 위의 뷰 하나 (정면도/평면도/우측면도): 그 뷰의 도형 그리기·편집·표시.
 * 화면(px, y 아래) ↔ 뷰 좌표(mm, u 오른쪽, v 위) ↔ 3D 좌표(X, Y, Z)
 * 화면 배치·이동·확대·입력 분배는 DraftBoard가 맡는다.
 */
export class SketchPane {
  polyDraft: Pt[] = [];
  onPolyDraft: () => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private drag: Drag | null = null;
  private creating: Creating | null = null;
  private hover: Pt | null = null; // 스냅된 커서 위치
  private hoverRaw: [number, number] | null = null;
  private hoverShapeId: string | null = null;
  /** 모서리 도구로 가리킨 꼭짓점 */
  private hoverCorner: { shapeId: string; index: number; pt: Pt } | null = null;
  /** 측정 도구: 첫 점과 (있으면) 두 번째 점 */
  private measure: { a: Pt; b: Pt | null } | null = null;
  /** 화면에 그린 치수 숫자의 클릭 영역 (선택한 도형) */
  private dimHits: { box: [number, number, number, number]; shapeId: string; key: string }[] = [];
  /** 치수 숫자를 눌러 고치는 중 */
  private dimEdit: { shapeId: string; key: string } | null = null;
  private guides: Guide[] = [];
  private canvas: HTMLCanvasElement;
  private dyn: HTMLInputElement;
  private dynHint: HTMLDivElement;
  readonly ua: number;
  readonly va: number;

  constructor(
    private board: DraftBoard,
    readonly view: ViewId,
  ) {
    this.canvas = board.canvas;
    this.ctx = board.ctx;
    const canvas = this.canvas;
    const [u, v] = VIEW_AXES[view];
    this.ua = AX[u];
    this.va = AX[v];
    if (!colors) refreshColors();

    // 치수 직접 입력 (AutoCAD의 동적 입력처럼)
    const host = canvas.parentElement!;
    this.dyn = document.createElement("input");
    this.dyn.className = "dyn-input";
    this.dyn.hidden = true;
    this.dynHint = document.createElement("div");
    this.dynHint.className = "dyn-hint";
    this.dynHint.hidden = true;
    host.append(this.dyn, this.dynHint);
    this.dyn.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (this.dimEdit) {
          if (this.applyDimEdit(this.dyn.value)) this.closeDyn();
          return;
        }
        this.applyDyn(this.dyn.value);
        this.closeDyn();
      } else if (e.key === "Escape") this.closeDyn();
    });
    this.dyn.addEventListener("blur", () => this.closeDyn());
  }

  // ---------------- 좌표 ----------------

  private get w() {
    return this.canvas.clientWidth;
  }
  private get h() {
    return this.canvas.clientHeight;
  }
  private get dpr() {
    return this.board.dpr;
  }
  /** 뷰 좌표 → 화면 (제도판에서 이 뷰의 원점 위치를 더한다) */
  toScreen(u: number, v: number): [number, number] {
    const [ox, oy] = this.board.offset(this.view);
    return this.board.sheetToScreen(u + ox, v + oy);
  }
  toWorld(x: number, y: number): Pt {
    const [ox, oy] = this.board.offset(this.view);
    const [gx, gy] = this.board.screenToSheet(x, y);
    return [gx - ox, gy - oy];
  }
  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---------------- 스냅 ----------------

  /** 다른 도형/뷰에서 이 축에 해당하는 기준 좌표들 */
  private alignTargets(excludeId?: string): { u: number[]; v: number[] } {
    const byAxis: number[][] = [[], [], []];
    for (const view of VIEW_IDS) {
      const [a, b] = VIEW_AXES[view].map((n) => AX[n]);
      for (const s of store.project.views[view]) {
        if (s.id === excludeId) continue;
        for (const [pu, pv] of keyPoints(s)) {
          byAxis[a].push(pu);
          byAxis[b].push(pv);
        }
      }
    }
    for (const [pu, pv] of this.polyDraft) {
      byAxis[this.ua].push(pu);
      byAxis[this.va].push(pv);
    }
    // 3D 결과의 이 뷰 투영 범위와 가운데 (구멍만 그리는 뷰에서 위치 잡기용)
    const rb = ui.result?.[this.view]?.bounds;
    if (rb) {
      // 3D 엔진 결과에는 1e-6 정도 오차가 있어 0.0001mm로 반올림
      const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
      byAxis[this.ua].push(r4(rb[0][0]), r4(rb[1][0]), r4((rb[0][0] + rb[1][0]) / 2));
      byAxis[this.va].push(r4(rb[0][1]), r4(rb[1][1]), r4((rb[0][1] + rb[1][1]) / 2));
    }
    byAxis[this.ua].push(0);
    byAxis[this.va].push(0);
    return { u: byAxis[this.ua], v: byAxis[this.va] };
  }

  /** 정렬 스냅 → 없으면 격자 스냅. 화면에 보여줄 정렬선도 같이 돌려준다. */
  snap(p: Pt, excludeId?: string): { pt: Pt; guides: Guide[] } {
    const guides: Guide[] = [];
    const out: Pt = [p[0], p[1]];
    const tol = 7 / ui.camera.scale;
    if (ui.snapAlign) {
      const t = this.alignTargets(excludeId);
      const near = (vals: number[], x: number) => {
        let best: number | null = null;
        for (const v of vals) if (Math.abs(v - x) < tol && (best === null || Math.abs(v - x) < Math.abs(best - x))) best = v;
        return best;
      };
      const su = near(t.u, p[0]);
      const sv = near(t.v, p[1]);
      if (su !== null) {
        out[0] = su;
        guides.push({ axis: "u", value: su });
      }
      if (sv !== null) {
        out[1] = sv;
        guides.push({ axis: "v", value: sv });
      }
    }
    const g = ui.snapGrid ? ui.grid : 0;
    const r = (n: number) => (g ? Math.round(Math.round(n / g) * g * 1e6) / 1e6 : Math.round(n * 1000) / 1000);
    if (!guides.some((x) => x.axis === "u")) out[0] = r(out[0]);
    if (!guides.some((x) => x.axis === "v")) out[1] = r(out[1]);
    return { pt: out, guides };
  }

  /** Shift: 이전 점 기준 수평/수직/45° 고정 */
  private ortho(p: Pt, from: Pt): Pt {
    const dx = p[0] - from[0];
    const dy = p[1] - from[1];
    const ang = Math.atan2(dy, dx);
    const step = Math.PI / 4;
    const a = Math.round(ang / step) * step;
    const len = Math.hypot(dx, dy);
    if (Math.abs(Math.cos(a)) < 1e-9) return [from[0], from[1] + Math.sign(Math.sin(a)) * len];
    if (Math.abs(Math.sin(a)) < 1e-9) return [from[0] + Math.sign(Math.cos(a)) * len, from[1]];
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [from[0] + Math.sign(dx) * d, from[1] + Math.sign(dy) * d];
  }

  // ---------------- 공개 동작 ----------------

  finishPoly() {
    const pts = this.polyDraft;
    this.polyDraft = [];
    this.onPolyDraft();
    if (pts.length >= 3) {
      const s: Shape2D = { id: newId(), kind: "poly", hole: false, pts };
      if (!isDegenerate(s)) this.addShape(s);
    }
    this.render();
  }

  cancel() {
    this.closeDyn();
    const had = this.polyDraft.length > 0 || this.creating !== null || this.measure !== null;
    this.polyDraft = [];
    this.creating = null;
    this.measure = null;
    this.onPolyDraft();
    this.render();
    return had;
  }

  undoPolyPoint() {
    this.polyDraft.pop();
    this.onPolyDraft();
    this.render();
  }

  get busy() {
    return this.polyDraft.length > 0 || this.creating !== null;
  }

  /** 다른 뷰로 커서가 나가도 이 뷰가 계속 입력을 받아야 하는 상태 */
  get pending() {
    return this.busy || (this.measure !== null && this.measure.b === null);
  }

  /** 커서가 이 뷰 영역을 떠남 */
  leave() {
    this.hover = null;
    this.hoverRaw = null;
    this.hoverShapeId = null;
    this.hoverCorner = null;
  }

  /** 그리는 중에 숫자를 누르면 치수 입력창을 연다 */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.busy) return false;
    if (/^[0-9.\-@]$/.test(e.key)) {
      this.openDyn(e.key);
      return true;
    }
    if (e.key === "Enter" && this.polyDraft.length >= 3) {
      this.finishPoly();
      return true;
    }
    if (e.key === "Backspace" && this.polyDraft.length) {
      this.undoPolyPoint();
      return true;
    }
    return false;
  }

  // ---------------- 입력 ----------------

  down(e: PointerEvent) {
    if (ui.activeView !== this.view) {
      ui.activeView = this.view;
      ui.emit();
    }
    const [x, y] = this.local(e);

    // 선택한 도형의 치수 숫자를 누르면 바로 고치기
    if (ui.tool === "select" && !this.busy) {
      const hit = this.dimHits.find((h) => x >= h.box[0] && x <= h.box[2] && y >= h.box[1] && y <= h.box[3]);
      if (hit) {
        this.openDimEdit(hit);
        return;
      }
    }

    const raw = this.toWorld(x, y);
    let sp = this.snap(raw).pt;

    if (this.creating) {
      // 클릭-클릭 방식의 두 번째 클릭
      this.finishCreate();
      return;
    }

    if (ui.tool === "poly") {
      const first = this.polyDraft[0];
      if (first && this.polyDraft.length >= 3) {
        const [fx, fy] = this.toScreen(first[0], first[1]);
        if (Math.hypot(fx - x, fy - y) < 10) {
          this.finishPoly();
          return;
        }
      }
      const last = this.polyDraft[this.polyDraft.length - 1];
      if (last && e.shiftKey) sp = this.ortho(sp, last);
      if (!last || last[0] !== sp[0] || last[1] !== sp[1]) this.polyDraft.push(sp);
      this.onPolyDraft();
      this.render();
      return;
    }

    if (ui.tool === "hole") {
      this.placeHole(sp);
      return;
    }

    if (ui.tool === "measure") {
      if (!this.measure || this.measure.b) this.measure = { a: sp, b: null };
      else this.measure.b = sp;
      this.render();
      return;
    }

    if (ui.tool === "corner") {
      const hc = this.findCorner(x, y);
      if (!hc) return;
      this.applyCorner(hc.shapeId, hc.index, e.shiftKey);
      return;
    }

    if (ui.tool === "rect" || ui.tool === "circle" || ui.tool === "slot") {
      const shape: Shape2D =
        ui.tool === "rect"
          ? { id: newId(), kind: "rect", hole: false, x: sp[0], y: sp[1], w: 0, h: 0 }
          : ui.tool === "circle"
            ? { id: newId(), kind: "circle", hole: false, cx: sp[0], cy: sp[1], r: 0 }
            : { id: newId(), kind: "slot", hole: false, a: sp, b: sp, w: ui.slotWidth };
      this.creating = { shape, start: sp, downAt: [x, y], dragged: false };
      this.render();
      return;
    }

    // 선택 도구
    const sel = this.selected();
    if (sel) {
      const h = this.hitHandle(sel, x, y);
      if (h) {
        store.checkpoint();
        this.drag = h.kind === "vertex" ? { kind: "vertex", shape: sel, index: h.index, moved: false } : { kind: "bend", shapeId: sel.id, index: h.index, moved: false };
        return;
      }
    }
    const hit = this.hitShape(raw);
    if (hit) {
      ui.sel = { view: this.view, id: hit.id };
      ui.emit();
      store.checkpoint();
      this.drag = { kind: "move", shape: hit, orig: structuredClone(hit), anchor: keyPoints(hit)[0], grab: raw, moved: false };
      this.render();
      return;
    }
    if (ui.sel) {
      ui.sel = null;
      ui.emit();
    }
    this.board.startPan(x, y);
  }

  move(e: PointerEvent) {
    const [x, y] = this.local(e);
    this.hoverRaw = [x, y];
    const raw = this.toWorld(x, y);
    const d = this.drag;

    const excl = d?.kind === "move" || d?.kind === "vertex" ? d.shape.id : d?.kind === "bend" ? d.shapeId : this.creating?.shape.id;
    let { pt, guides } = this.snap(raw, excl);
    if (e.shiftKey && ui.tool === "poly" && this.polyDraft.length) pt = this.ortho(pt, this.polyDraft[this.polyDraft.length - 1]);
    this.hover = pt;
    this.guides = guides;
    this.hoverShapeId = !d && ui.tool === "select" ? (this.hitShape(raw)?.id ?? null) : null;
    this.hoverCorner = ui.tool === "corner" ? this.findCorner(x, y) : null;

    // 다른 창에 투영선을 그릴 수 있게 3D 커서 공유
    const cur: [number | null, number | null, number | null] = [null, null, null];
    cur[this.ua] = pt[0];
    cur[this.va] = pt[1];
    ui.cursor = cur;
    ui.activeView = this.view;

    if (this.creating) {
      const c = this.creating;
      if (Math.hypot(x - c.downAt[0], y - c.downAt[1]) > 4) c.dragged = true;
      const s = c.shape;
      if (s.kind === "rect") {
        let q = pt;
        if (e.shiftKey) {
          const m = Math.max(Math.abs(q[0] - c.start[0]), Math.abs(q[1] - c.start[1]));
          q = [c.start[0] + Math.sign(q[0] - c.start[0] || 1) * m, c.start[1] + Math.sign(q[1] - c.start[1] || 1) * m];
        }
        s.w = q[0] - c.start[0];
        s.h = q[1] - c.start[1];
      } else if (s.kind === "circle") {
        const r = Math.hypot(raw[0] - c.start[0], raw[1] - c.start[1]);
        const g = ui.snapGrid ? ui.grid / 2 : 0;
        s.r = g ? Math.max(g, Math.round(r / g) * g) : Math.round(r * 1000) / 1000;
      } else if (s.kind === "slot") {
        s.b = e.shiftKey ? this.ortho(pt, c.start) : pt;
      }
    } else if (d?.kind === "move") {
      const target: Pt = [d.anchor[0] + raw[0] - d.grab[0], d.anchor[1] + raw[1] - d.grab[1]];
      const s = this.snap(target, d.shape.id);
      this.guides = s.guides;
      const du = s.pt[0] - d.anchor[0];
      const dv = s.pt[1] - d.anchor[1];
      if (du || dv) d.moved = true;
      translateShape(d.shape, d.orig, du, dv);
      store.changed();
    } else if (d?.kind === "vertex") {
      d.moved = true;
      setVertex(d.shape, d.index, pt);
      store.changed();
    } else if (d?.kind === "bend") {
      this.bendEdge(d, raw);
    }
    ui.emit();
  }

  up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (this.creating?.dragged) {
      this.finishCreate();
      return;
    }
    if (!d) return;
    if ((d.kind === "move" || d.kind === "vertex" || d.kind === "bend") && !d.moved) store.dropCheckpoint();
    void e;
  }

  private finishCreate() {
    const c = this.creating;
    this.creating = null;
    this.closeDyn();
    if (!c) return;
    const s = c.shape;
    if (s.kind === "rect") Object.assign(s, normRect(s));
    if (!isDegenerate(s)) this.addShape(s);
    this.render();
  }

  private addShape(s: Shape2D, forceHole = false) {
    const [cx, cy] = shapeCenter(s);
    const own = store.project.views[this.view];
    if (forceHole || this.holesOnly()) s.hole = true;
    else if (own.some((o) => !o.hole)) {
      // 이미 있는 몸체 안쪽에 그리면 자동으로 구멍
      s.hole = own.some((o) => !o.hole && pointInShape(cx, cy, o) && contains(o, s));
    } else {
      // 몸체가 없는 뷰: 3D 결과 안쪽에 작게 그리면 그 방향으로 뚫는 구멍으로 본다
      const rb = ui.result?.[this.view]?.bounds;
      if (rb) {
        const inside = cx > rb[0][0] && cx < rb[1][0] && cy > rb[0][1] && cy < rb[1][1];
        const small = area(s) < 0.5 * (rb[1][0] - rb[0][0]) * (rb[1][1] - rb[0][1]);
        s.hole = inside && small;
      }
    }
    store.update((p) => {
      p.views[this.view].push(s);
    });
    ui.sel = { view: this.view, id: s.id };
    ui.emit();
  }

  private selected(): Shape2D | null {
    if (!ui.sel || ui.sel.view !== this.view) return null;
    return store.project.views[this.view].find((s) => s.id === ui.sel!.id) ?? null;
  }

  private hitShape(w: Pt): Shape2D | null {
    const list = store.project.views[this.view];
    const ordered = [...list.filter((s) => s.hole).reverse(), ...list.filter((s) => !s.hole).reverse()];
    const pad = 5 / ui.camera.scale;
    for (const s of ordered) {
      if (pointInShape(w[0], w[1], s)) return s;
      if (s.kind === "circle" && Math.abs(Math.hypot(w[0] - s.cx, w[1] - s.cy) - s.r) < pad) return s;
    }
    return null;
  }

  private hitHandle(s: Shape2D, x: number, y: number): Handle | null {
    for (const h of handles(s)) {
      const [sx, sy] = this.toScreen(h.pt[0], h.pt[1]);
      if (Math.hypot(sx - x, sy - y) < 8) return h;
    }
    return null;
  }

  /** 변 가운데 손잡이를 끌면 그 변이 끄는 점을 지나는 원호가 된다 (사각형은 다각형으로 바뀜) */
  private bendEdge(d: Extract<Drag, { kind: "bend" }>, p: Pt) {
    const list = store.project.views[this.view];
    const idx = list.findIndex((s) => s.id === d.shapeId);
    if (idx < 0) return;
    let s = list[idx];
    if (s.kind === "rect") {
      s = rectToPoly(s);
      list[idx] = s;
    }
    if (s.kind !== "poly") return;
    const n = s.pts.length;
    const a = s.pts[d.index];
    const b = s.pts[(d.index + 1) % n];
    let bulge = bulgeThrough(a, p, b);
    if (Math.abs(bulge) < 0.03) bulge = 0; // 거의 곧으면 직선으로
    bulge = Math.max(-1, Math.min(1, bulge)); // 반원까지만
    const bulges = s.bulges ? [...s.bulges] : new Array(n).fill(0);
    bulges[d.index] = Math.round(bulge * 1e4) / 1e4;
    s.bulges = bulges;
    d.moved = true;
    store.changed();
  }

  /** 모서리 도구: 커서 근처의 사각형/다각형 꼭짓점 */
  private findCorner(x: number, y: number): { shapeId: string; index: number; pt: Pt } | null {
    let best: { shapeId: string; index: number; pt: Pt; d: number } | null = null;
    for (const s of store.project.views[this.view]) {
      if (s.kind !== "rect" && s.kind !== "poly") continue;
      const pts = s.kind === "rect" ? rectPoints(s) : s.pts;
      pts.forEach((pt, i) => {
        const [sx, sy] = this.toScreen(pt[0], pt[1]);
        const dd = Math.hypot(sx - x, sy - y);
        if (dd < 14 && (!best || dd < best.d)) best = { shapeId: s.id, index: i, pt, d: dd };
      });
    }
    return best;
  }

  /** 꼭짓점에 모서리 R/모따기 적용. 같은 것이 이미 있으면 해제. all이면 그 도형의 모든 꼭짓점 */
  private applyCorner(shapeId: string, index: number, all: boolean) {
    const s = store.project.views[this.view].find((x) => x.id === shapeId);
    if (!s || (s.kind !== "rect" && s.kind !== "poly")) return;
    const n = s.kind === "rect" ? 4 : s.pts.length;
    const want = { kind: ui.cornerKind, size: ui.cornerSize };
    const cur = s.corners?.[index];
    const same = cur && cur.kind === want.kind && Math.abs(cur.size - want.size) < 1e-9;
    store.update(() => {
      const corners = s.corners ? [...s.corners] : new Array(n).fill(null);
      while (corners.length < n) corners.push(null);
      const value = same ? null : { ...want };
      if (all) corners.fill(value);
      else corners[index] = value;
      s.corners = corners.some(Boolean) ? corners : undefined;
    });
    ui.sel = { view: this.view, id: s.id };
    ui.emit();
  }

  /** 회전체 모드의 평면도·우측면도에는 구멍만 그린다 */
  private holesOnly() {
    return store.project.mode === "revolve" && this.view !== "front";
  }

  /** 구멍 도구: 설정된 규격 구멍을 클릭한 곳에 놓는다 */
  private placeHole(at: Pt) {
    const h = ui.hole;
    const d = specDiameter(h.spec) ?? h.d;
    const spec = { ...h.spec };
    const hole: Shape2D = { id: newId(), kind: "circle", hole: true, cx: at[0], cy: at[1], r: d / 2, spec, depth: h.depth };
    this.addShape(hole, true);
  }

  // ---------------- 치수 직접 입력 ----------------

  private openDyn(first: string) {
    const at = this.hoverRaw ?? [this.w / 2, this.h / 2];
    this.dyn.hidden = false;
    this.dynHint.hidden = false;
    this.dyn.style.left = `${Math.min(at[0] + 16, this.w - 130)}px`;
    this.dyn.style.top = `${Math.min(at[1] + 16, this.h - 60)}px`;
    this.dynHint.style.left = this.dyn.style.left;
    this.dynHint.style.top = `${Math.min(at[1] + 16, this.h - 60) + 32}px`;
    this.dynHint.textContent =
      this.creating?.shape.kind === "rect"
        ? "가로,세로 (예: 40,20) ⏎"
        : this.creating?.shape.kind === "circle"
          ? "지름 (예: 10) ⏎"
          : this.creating?.shape.kind === "slot"
            ? "중심거리,폭 (예: 20,6) ⏎"
            : "다음 점: 거리<각도 (예: 30<90) 또는 Δx,Δy ⏎";
    this.dyn.value = first;
    this.dyn.focus();
  }

  private closeDyn() {
    if (this.dyn.hidden) return;
    this.dyn.hidden = true;
    this.dynHint.hidden = true;
    this.dyn.classList.remove("err");
    this.dimEdit = null;
    this.canvas.focus();
  }

  /** 치수 숫자를 누르면 그 자리에서 값이나 식을 입력 */
  private openDimEdit(hit: { box: [number, number, number, number]; shapeId: string; key: string }) {
    const s = store.project.views[this.view].find((x) => x.id === hit.shapeId);
    if (!s) return;
    this.dimEdit = { shapeId: hit.shapeId, key: hit.key };
    const cx = (hit.box[0] + hit.box[2]) / 2;
    this.dyn.hidden = false;
    this.dynHint.hidden = false;
    this.dyn.style.left = `${Math.max(4, Math.min(cx - 60, this.w - 130))}px`;
    this.dyn.style.top = `${Math.max(4, hit.box[1] - 4)}px`;
    this.dynHint.style.left = this.dyn.style.left;
    this.dynHint.style.top = `${Math.max(4, hit.box[1] - 4) + 32}px`;
    this.dynHint.textContent = "숫자 또는 식 (예: 40, L/2, L-8) ⏎";
    this.dyn.value = s.exprs?.[hit.key] ?? fmt(getDim(s, hit.key));
    // 클릭이 끝나면 브라우저가 캔버스에 초점을 주므로, 그 다음에 입력칸으로 옮긴다
    setTimeout(() => {
      this.dyn.focus();
      this.dyn.select();
    }, 0);
  }

  private applyDimEdit(text: string): boolean {
    const d = this.dimEdit;
    if (!d) return true;
    const s = store.project.views[this.view].find((x) => x.id === d.shapeId);
    if (!s) return true;
    // 성공했을 때만 실행 취소 기록을 남긴다
    store.checkpoint();
    const err = setDimInput(s, d.key, text, store.project);
    if (err) store.dropCheckpoint();
    else store.changed();
    if (err) {
      this.dyn.classList.add("err");
      this.dynHint.textContent = `⚠ ${err}`;
      return false;
    }
    return true;
  }

  private applyDyn(text: string) {
    const nums = text.replace("@", "").split(/[,\s<]+/).filter(Boolean).map(Number);
    if (!nums.length || nums.some((n) => !Number.isFinite(n))) return;
    const c = this.creating;
    if (c?.shape.kind === "rect") {
      const w = nums[0];
      const h = nums[1] ?? nums[0];
      Object.assign(c.shape, { x: c.start[0], y: c.start[1], w, h });
      this.finishCreate();
    } else if (c?.shape.kind === "circle") {
      c.shape.r = Math.abs(nums[0]) / 2;
      this.finishCreate();
    } else if (c?.shape.kind === "slot") {
      const sl = c.shape;
      const dx = sl.b[0] - sl.a[0];
      const dy = sl.b[1] - sl.a[1];
      const len = Math.hypot(dx, dy);
      const dir: Pt = len > 1e-9 ? [dx / len, dy / len] : [1, 0];
      const L = nums[0];
      sl.b = [Math.round((sl.a[0] + dir[0] * L) * 1e4) / 1e4, Math.round((sl.a[1] + dir[1] * L) * 1e4) / 1e4];
      if (nums[1] && nums[1] > 0) {
        sl.w = nums[1];
        ui.slotWidth = nums[1];
      }
      this.finishCreate();
    } else if (this.polyDraft.length) {
      const last = this.polyDraft[this.polyDraft.length - 1];
      let next: Pt;
      if (text.includes("<")) {
        const a = ((nums[1] ?? 0) * Math.PI) / 180;
        next = [last[0] + nums[0] * Math.cos(a), last[1] + nums[0] * Math.sin(a)];
      } else next = [last[0] + nums[0], last[1] + (nums[1] ?? 0)];
      this.polyDraft.push([Math.round(next[0] * 1e4) / 1e4, Math.round(next[1] * 1e4) / 1e4]);
      this.onPolyDraft();
      this.render();
    }
  }

  // ---------------- 그리기 ----------------

  /** 화면 전체 다시 그리기 (제도판이 세 뷰를 모두 그린다) */
  render() {
    this.board.render();
  }

  /** 제도판이 이 뷰 영역으로 잘라 둔 상태에서 호출한다 */
  /** 가져온 도면 이미지를 밑그림으로 (그 뷰에 해당하는 부분만) */
  private drawImageUnderlay() {
    const u = store.project.underlay;
    if (!u || u.show === false) return;
    const vm = u.views[this.view];
    if (!vm) return;
    const img = underlayCanvas(u.key, colors!.underlayInk);
    if (!img) return;
    const f = img.width / u.w;
    const s = u.mmPerPx;
    const [x0, y0, x1, y1] = vm.crop;
    const [ax, ay] = this.toScreen((x0 - vm.ox) * s, (vm.oy - y0) * s);
    const [bx, by] = this.toScreen((x1 - vm.ox) * s, (vm.oy - y1) * s);
    const c = this.ctx;
    c.save();
    c.globalAlpha = 0.55;
    c.imageSmoothingEnabled = true;
    c.drawImage(img, x0 * f, y0 * f, (x1 - x0) * f, (y1 - y0) * f, ax, ay, bx - ax, by - ay);
    c.restore();
  }

  renderContent() {
    this.dimHits = [];
    const c = this.ctx;
    const col = colors!;
    const { w, h } = this;
    if (!w || !h) return;
    const reg = this.board.regionScreenRect(this.view);
    this.drawImageUnderlay();
    this.drawAxes();
    this.drawResultUnderlay();
    if (store.project.mode !== "revolve") this.drawExtentGuides();

    const shapes = store.project.views[this.view];
    const draft = this.creating?.shape ?? null;
    const sel = this.selected();
    const flagged = this.flaggedShapes();

    for (const s of [...shapes.filter((s) => !s.hole), ...(draft ? [draft] : [])]) {
      this.pathShape(s);
      c.fillStyle = col.solidFill;
      c.fill();
      c.lineWidth = 1.25;
      c.strokeStyle = col.solidStroke;
      c.stroke();
    }
    for (const s of shapes.filter((s) => s.hole)) {
      this.pathShape(s);
      // 관통 구멍은 비어 보이게, 막힌 구멍·포켓은 바닥이 있는 것처럼 옅게 칠한다
      c.fillStyle = s.depth !== undefined ? col.blindFill : col.bg;
      c.fill();
      c.lineWidth = 1.25;
      c.strokeStyle = col.holeStroke;
      c.setLineDash(s.depth !== undefined ? [] : [5, 3]);
      c.stroke();
      c.setLineDash([]);
      if (s.kind === "circle") this.drawHoleDecor(s);
    }
    this.drawHolePreview();
    // 검사에서 걸린 도형 강조
    for (const [id, sev] of flagged) {
      const s = shapes.find((x) => x.id === id);
      if (!s) continue;
      this.pathShape(s);
      c.lineWidth = id === this.hoverFindingShape() ? 4 : 2;
      c.strokeStyle = col[sev];
      c.globalAlpha = 0.85;
      c.stroke();
      c.globalAlpha = 1;
    }
    if (this.hoverShapeId && this.hoverShapeId !== sel?.id) {
      const s = shapes.find((x) => x.id === this.hoverShapeId);
      if (s) {
        this.pathShape(s);
        c.lineWidth = 2;
        c.strokeStyle = col.accent;
        c.globalAlpha = 0.5;
        c.stroke();
        c.globalAlpha = 1;
      }
    }
    if (sel) {
      this.pathShape(sel);
      c.lineWidth = 2;
      c.strokeStyle = col.accent;
      c.stroke();
      if (ui.tool === "select")
        for (const h of handles(sel)) {
          const [x, y] = this.toScreen(h.pt[0], h.pt[1]);
          c.fillStyle = h.kind === "mid" ? col.accent : col.bg;
          c.strokeStyle = col.accent;
          c.lineWidth = 1.5;
          if (h.kind === "mid") {
            // 변 휘기 손잡이: 작은 마름모
            c.beginPath();
            c.moveTo(x, y - 4.5);
            c.lineTo(x + 4.5, y);
            c.lineTo(x, y + 4.5);
            c.lineTo(x - 4.5, y);
            c.closePath();
            c.globalAlpha = 0.75;
            c.fill();
            c.globalAlpha = 1;
          } else {
            c.fillRect(x - 4, y - 4, 8, 8);
            c.strokeRect(x - 4, y - 4, 8, 8);
          }
        }
      if (ui.tool === "select" && (sel.kind === "rect" || sel.kind === "circle" || sel.kind === "slot")) this.drawDims(sel);
      else this.label(sel);
    }
    if (draft) this.label(draft);
    this.drawCornerHover();
    this.drawPolyDraft();
    this.drawMeasure();
    this.drawFindingMarkers();
    this.drawCursor();
    this.drawFlash();

    if (this.holesOnly()) {
      c.fillStyle = col.text;
      c.font = "600 11px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "bottom";
      c.fillText("회전체 모드: 이 뷰에는 구멍만 그릴 수 있어요 (예: 플랜지 볼트 구멍)", (reg[0] + reg[2]) / 2, reg[3] - 10);
    }
  }

  /** 3D 결과를 이 뷰에서 본 모습 (외형선 + 숨은선)을 흐리게 */
  private drawResultUnderlay() {
    const r = ui.showResult ? ui.result?.[this.view] : null;
    if (!r) return;
    const c = this.ctx;
    const { scale } = ui.camera;
    // 투영 경로는 (u, −v) 좌표 → 화면으로: 뷰 원점의 화면 위치만큼 옮긴다
    const [x0, y0] = this.toScreen(0, 0);
    c.save();
    c.setTransform(this.dpr * scale, 0, 0, this.dpr * scale, this.dpr * x0, this.dpr * y0);
    c.strokeStyle = colors!.result;
    c.lineWidth = 1 / scale;
    c.setLineDash([4 / scale, 3 / scale]);
    c.globalAlpha = 0.6;
    for (const p of r.hidden) c.stroke(p);
    c.setLineDash([]);
    c.globalAlpha = 0.9;
    c.lineWidth = 1.5 / scale;
    for (const p of r.visible) c.stroke(p);
    c.restore();
  }

  /** 규격 구멍 표시: 머리 자리(바깥 원), 탭(나사산 3/4 원) */
  private drawHoleDecor(s: Extract<Shape2D, { kind: "circle" }>) {
    const spec = s.spec;
    if (!spec) return;
    const c = this.ctx;
    const [x, y] = this.toScreen(s.cx, s.cy);
    const k = ui.camera.scale;
    c.strokeStyle = colors!.holeStroke;
    c.lineWidth = 1;
    if (spec.head === "counterbore" && spec.cbDiameter) {
      c.beginPath();
      c.arc(x, y, (spec.cbDiameter / 2) * k, 0, Math.PI * 2);
      c.stroke();
    } else if (spec.head === "countersink" && spec.csDiameter) {
      c.setLineDash([2, 2]);
      c.beginPath();
      c.arc(x, y, (spec.csDiameter / 2) * k, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }
    if (spec.purpose === "tap") {
      // 제도 관례: 나사 바깥지름을 3/4 원으로
      const t = threadRow(spec.size);
      if (t) {
        c.beginPath();
        c.arc(x, y, (t.nominal / 2) * k, -Math.PI / 2, Math.PI);
        c.stroke();
      }
    }
  }

  /** 구멍 도구로 놓을 구멍 미리보기 */
  private drawHolePreview() {
    if (ui.tool !== "hole" || !this.hover || ui.activeView !== this.view || this.drag) return;
    const d = specDiameter(ui.hole.spec) ?? ui.hole.d;
    const c = this.ctx;
    const [x, y] = this.toScreen(this.hover[0], this.hover[1]);
    c.globalAlpha = 0.7;
    c.strokeStyle = colors!.holeStroke;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, (d / 2) * ui.camera.scale, 0, Math.PI * 2);
    c.stroke();
    this.drawHoleDecor({ id: "", kind: "circle", hole: true, cx: this.hover[0], cy: this.hover[1], r: d / 2, spec: ui.hole.spec });
    c.globalAlpha = 1;
    this.tag(holeLabel(d, ui.hole.spec, ui.hole.depth), x, y - (d / 2) * ui.camera.scale - 14, colors!.holeStroke);
  }

  private flaggedShapes(): Map<string, Severity> {
    const m = new Map<string, Severity>();
    const rank = { error: 0, warning: 1, info: 2 };
    for (const f of ui.findings) {
      if (f.severity === "info" && ui.hoverFindingId !== f.id) continue;
      for (const r of f.refs)
        if (r.view === this.view && r.shapeId) {
          const prev = m.get(r.shapeId);
          if (!prev || rank[f.severity] < rank[prev]) m.set(r.shapeId, f.severity);
        }
    }
    return m;
  }

  private hoverFindingShape(): string | undefined {
    const f = ui.findings.find((x) => x.id === ui.hoverFindingId);
    return f?.refs.find((r) => r.view === this.view)?.shapeId;
  }

  private pathShape(s: Shape2D) {
    const c = this.ctx;
    c.beginPath();
    if (s.kind === "circle") {
      const [x, y] = this.toScreen(s.cx, s.cy);
      c.arc(x, y, Math.max(s.r * ui.camera.scale, 0.5), 0, Math.PI * 2);
      return;
    }
    const pts = flatten(s, Math.PI / 48);
    pts.forEach(([u, v], i) => {
      const [x, y] = this.toScreen(u, v);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.closePath();
  }

  private drawCornerHover() {
    const hc = this.hoverCorner;
    if (!hc || ui.tool !== "corner") return;
    const c = this.ctx;
    const [x, y] = this.toScreen(hc.pt[0], hc.pt[1]);
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.strokeStyle = colors!.snap;
    c.lineWidth = 2;
    c.stroke();
    const label = ui.cornerKind === "fillet" ? `R${fmt(ui.cornerSize)}` : `C${fmt(ui.cornerSize)}`;
    this.tag(`${label} 적용 (Shift: 전체)`, x, y - 22, colors!.snap);
  }

  private drawMeasure() {
    const m = this.measure;
    if (!m) return;
    const b = m.b ?? (ui.activeView === this.view ? this.hover : null);
    const c = this.ctx;
    const col = colors!;
    const [ax, ay] = this.toScreen(m.a[0], m.a[1]);
    c.fillStyle = col.snap;
    c.beginPath();
    c.arc(ax, ay, 3.5, 0, Math.PI * 2);
    c.fill();
    if (!b) return;
    const [bx, by] = this.toScreen(b[0], b[1]);
    const du = b[0] - m.a[0];
    const dv = b[1] - m.a[1];
    // 가로/세로 성분은 점선, 직선 거리는 실선
    c.strokeStyle = col.snap;
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, ay);
    c.lineTo(bx, by);
    c.stroke();
    c.setLineDash([]);
    c.lineWidth = 1.75;
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.stroke();
    c.beginPath();
    c.arc(bx, by, 3.5, 0, Math.PI * 2);
    c.fill();
    const [ua, va] = VIEW_AXES[this.view];
    const len = Math.hypot(du, dv);
    const ang = (Math.atan2(dv, du) * 180) / Math.PI;
    this.tag(`${fmt(len)} mm  ∠${fmt(ang)}°`, (ax + bx) / 2, (ay + by) / 2 - 14, col.snap);
    this.tag(`Δ${ua} ${fmt(du)} · Δ${va} ${fmt(dv)}`, (ax + bx) / 2, (ay + by) / 2 + 8, col.snap);
  }

  private label(s: Shape2D) {
    let text: string;
    let at: Pt;
    if (s.kind === "rect") {
      const r = normRect(s);
      text = `${fmt(r.w)} × ${fmt(r.h)}`;
      at = [r.x + r.w / 2, r.y + r.h];
    } else if (s.kind === "circle") {
      text = s.hole && (s.spec || s.depth !== undefined) ? holeLabel(s.r * 2, s.spec, s.depth) : `Ø${fmt(s.r * 2)}`;
      at = [s.cx, s.cy + s.r];
    } else if (s.kind === "slot") {
      text = `장공 ${fmt(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]))} × ${fmt(s.w)}`;
      const b = boundsOf([{ ...s, hole: false }])!;
      at = [(b[0] + b[2]) / 2, b[3]];
    } else {
      const b = boundsOf([{ ...s, hole: false }])!;
      text = `${fmt(b[2] - b[0])} × ${fmt(b[3] - b[1])}`;
      at = [(b[0] + b[2]) / 2, b[3]];
    }
    const [x, y] = this.toScreen(at[0], at[1]);
    this.tag(text, x, y - 14, colors!.accent);
  }

  /** 치수 숫자에 보일 글자: 식이면 "L/2 = 40", 잠금이면 "🔒 40" */
  private dimText(s: Shape2D, key: string, prefix = ""): string {
    const v = fmt(getDim(s, key));
    const e = s.exprs?.[key];
    if (e === undefined) return prefix + v;
    return plainNumber(e) !== null ? `🔒 ${prefix}${v}` : `${prefix}${e} = ${v}`;
  }

  /**
   * 치수선 하나: a→b (뷰 좌표) 사이를 화면에서 off(px)만큼 띄워 그리고, 가운데 숫자는 누르면 고칠 수 있다.
   * dir: "h"면 가로 치수(위/아래로 띄움), "v"면 세로 치수(좌/우로 띄움)
   */
  private dimLine(s: Shape2D, key: string, a: Pt, b: Pt, dir: "h" | "v", off: number, prefix = "") {
    const c = this.ctx;
    const col = colors!;
    const [ax, ay] = this.toScreen(a[0], a[1]);
    const [bx, by] = this.toScreen(b[0], b[1]);
    if (Math.hypot(bx - ax, by - ay) < 6) return;
    const bound = s.exprs?.[key] !== undefined;
    const color = bound ? col.accent : col.text;
    // 치수선 위치
    const p1: [number, number] = dir === "h" ? [ax, ay + off] : [ax + off, ay];
    const p2: [number, number] = dir === "h" ? [bx, (dir === "h" ? ay : by) + off] : [(dir === "v" ? ax : bx) + off, by];
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 1;
    c.globalAlpha = 0.9;
    c.beginPath();
    // 치수 보조선
    c.moveTo(ax, ay);
    c.lineTo(...p1);
    c.moveTo(bx, by);
    c.lineTo(...p2);
    c.stroke();
    c.beginPath();
    c.moveTo(...p1);
    c.lineTo(...p2);
    c.stroke();
    // 화살표
    const arrow = (p: [number, number], q: [number, number]) => {
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const ux = (q[0] - p[0]) / L;
      const uy = (q[1] - p[1]) / L;
      c.beginPath();
      c.moveTo(p[0], p[1]);
      c.lineTo(p[0] + ux * 7 - uy * 3, p[1] + uy * 7 + ux * 3);
      c.lineTo(p[0] + ux * 7 + uy * 3, p[1] + uy * 7 - ux * 3);
      c.closePath();
      c.fill();
    };
    arrow(p1, p2);
    arrow(p2, p1);
    c.globalAlpha = 1;
    // 숫자 (누르면 고치기)
    const text = this.dimText(s, key, prefix);
    c.font = "600 11px system-ui, sans-serif";
    const tw = c.measureText(text).width + 12;
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const box: [number, number, number, number] = [mx - tw / 2, my - 10, mx + tw / 2, my + 10];
    c.fillStyle = bound ? col.accent : col.bg;
    c.strokeStyle = color;
    c.beginPath();
    c.roundRect(box[0], box[1], tw, 20, 5);
    c.fill();
    c.stroke();
    c.fillStyle = bound ? "#fff" : col.text;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, mx, my + 0.5);
    this.dimHits.push({ box, shapeId: s.id, key });
  }

  /** 선택한 도형의 크기·위치 치수 (원점 기준) */
  private drawDims(s: Shape2D) {
    if (s.kind === "rect") {
      const r = normRect(s);
      this.dimLine(s, "w", [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], "h", -22);
      this.dimLine(s, "h", [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], "v", 26);
      // 위치: 원점(가로 0, 세로 0)에서 왼쪽 아래 모서리까지
      if (Math.abs(r.x) > 1e-6) this.dimLine(s, "x", [0, r.y], [r.x, r.y], "h", 22);
      if (Math.abs(r.y) > 1e-6) this.dimLine(s, "y", [r.x, 0], [r.x, r.y], "v", -26);
    } else if (s.kind === "circle") {
      const [x, y] = this.toScreen(s.cx, s.cy);
      const rr = s.r * ui.camera.scale;
      // 지름: 규격 구멍이면 규격 이름만 (지름은 규격이 정함)
      if (s.spec && specDiameter(s.spec) !== null) this.tag(holeLabel(s.r * 2, s.spec, s.depth), x, y - rr - 14, colors!.accent);
      else {
        const text = this.dimText(s, "d", "Ø");
        const c = this.ctx;
        c.font = "600 11px system-ui, sans-serif";
        const tw = c.measureText(text).width + 12;
        const by = y - rr - 16;
        const bound = s.exprs?.d !== undefined;
        c.fillStyle = bound ? colors!.accent : colors!.bg;
        c.strokeStyle = bound ? colors!.accent : colors!.text;
        c.beginPath();
        c.roundRect(x - tw / 2, by - 10, tw, 20, 5);
        c.fill();
        c.stroke();
        c.fillStyle = bound ? "#fff" : colors!.text;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(text, x, by + 0.5);
        this.dimHits.push({ box: [x - tw / 2, by - 10, x + tw / 2, by + 10], shapeId: s.id, key: "d" });
      }
      if (Math.abs(s.cx) > 1e-6) this.dimLine(s, "cx", [0, s.cy - s.r], [s.cx, s.cy - s.r], "h", 22);
      if (Math.abs(s.cy) > 1e-6) this.dimLine(s, "cy", [s.cx - s.r, 0], [s.cx - s.r, s.cy], "v", -26);
    } else if (s.kind === "slot") {
      // 폭은 숫자 칸으로, 위치는 첫 번째 중심 기준
      const [x, y] = this.toScreen(s.a[0], s.a[1]);
      const text = this.dimText(s, "w", "폭 ");
      const c = this.ctx;
      c.font = "600 11px system-ui, sans-serif";
      const tw = c.measureText(text).width + 12;
      const by = y - (s.w / 2) * ui.camera.scale - 16;
      const bound = s.exprs?.w !== undefined;
      c.fillStyle = bound ? colors!.accent : colors!.bg;
      c.strokeStyle = bound ? colors!.accent : colors!.text;
      c.beginPath();
      c.roundRect(x - tw / 2, by - 10, tw, 20, 5);
      c.fill();
      c.stroke();
      c.fillStyle = bound ? "#fff" : colors!.text;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, x, by + 0.5);
      this.dimHits.push({ box: [x - tw / 2, by - 10, x + tw / 2, by + 10], shapeId: s.id, key: "w" });
      if (Math.abs(s.a[0]) > 1e-6) this.dimLine(s, "ax", [0, s.a[1] - s.w / 2], [s.a[0], s.a[1] - s.w / 2], "h", 22);
      if (Math.abs(s.a[1]) > 1e-6) this.dimLine(s, "ay", [s.a[0] - s.w / 2, 0], [s.a[0] - s.w / 2, s.a[1]], "v", -26);
    }
  }

  private tag(text: string, x: number, y: number, bg: string) {
    const c = this.ctx;
    c.font = "600 11px system-ui, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    const tw = c.measureText(text).width + 10;
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(x - tw / 2, y - 9, tw, 18, 4);
    c.fill();
    c.fillStyle = "#fff";
    c.fillText(text, x, y + 0.5);
  }

  /** 이 뷰의 원점 축 (회전체 모드의 정면도는 회전축 표시) */
  private drawAxes() {
    const c = this.ctx;
    const col = colors!;
    const [ax, ay] = this.toScreen(0, 0);
    const revolve = store.project.mode === "revolve" && this.view === "front";
    // 축은 이 뷰의 틀 안에만 (영역 끝까지 그으면 다른 뷰와 만나는 곳에서 뚝 끊겨 보인다)
    const [fx0, fy0, fx1, fy1] = this.board.frameScreenRect(this.view);
    c.strokeStyle = col.axis;
    c.lineWidth = revolve ? 1.5 : 1;
    c.setLineDash(revolve ? [12, 4, 2, 4] : []);
    c.beginPath();
    if (ax >= fx0 && ax <= fx1) {
      c.moveTo(Math.round(ax) + 0.5, fy0);
      c.lineTo(Math.round(ax) + 0.5, fy1);
    }
    if (ay >= fy0 && ay <= fy1) {
      c.moveTo(fx0, Math.round(ay) + 0.5);
      c.lineTo(fx1, Math.round(ay) + 0.5);
    }
    c.stroke();
    c.setLineDash([]);
    if (revolve) {
      c.fillStyle = col.axis;
      c.font = "600 11px system-ui, sans-serif";
      c.textAlign = "left";
      c.textBaseline = "top";
      c.fillText("회전축 (Z) — 오른쪽에 단면 절반을 그리세요", ax + 6, Math.max(8, this.board.regionScreenRect(this.view)[1] + 8));
    }
  }

  /** 다른 뷰에 그린 형상의 범위 (주황 점선) */
  private drawExtentGuides() {
    const c = this.ctx;
    const { w, h } = this;
    c.strokeStyle = colors!.guide;
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.beginPath();
    for (const other of VIEW_IDS) {
      if (other === this.view) continue;
      const b = boundsOf(store.project.views[other]);
      if (!b) continue;
      const [oa, ob] = VIEW_AXES[other].map((n) => AX[n]);
      const ranges: Record<number, [number, number]> = { [oa]: [b[0], b[2]], [ob]: [b[1], b[3]] };
      for (const u of ranges[this.ua] ?? []) {
        const x = Math.round(this.toScreen(u, 0)[0]) + 0.5;
        c.moveTo(x, 0);
        c.lineTo(x, h);
      }
      for (const v of ranges[this.va] ?? []) {
        const y = Math.round(this.toScreen(0, v)[1]) + 0.5;
        c.moveTo(0, y);
        c.lineTo(w, y);
      }
    }
    c.stroke();
    c.setLineDash([]);
  }

  private drawPolyDraft() {
    if (!this.polyDraft.length) return;
    const c = this.ctx;
    const col = colors!;
    c.beginPath();
    this.polyDraft.forEach(([u, v], i) => {
      const [x, y] = this.toScreen(u, v);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    const last = this.polyDraft[this.polyDraft.length - 1];
    if (this.hover && ui.activeView === this.view) {
      const [x, y] = this.toScreen(this.hover[0], this.hover[1]);
      c.lineTo(x, y);
    }
    c.strokeStyle = col.accent;
    c.lineWidth = 1.75;
    c.stroke();
    this.polyDraft.forEach(([u, v], i) => {
      const [x, y] = this.toScreen(u, v);
      c.beginPath();
      c.arc(x, y, i === 0 ? 6 : 3.5, 0, Math.PI * 2);
      c.fillStyle = i === 0 ? col.accent : col.bg;
      c.fill();
      c.strokeStyle = col.accent;
      c.stroke();
    });
    if (this.hover && ui.activeView === this.view) {
      const len = Math.hypot(this.hover[0] - last[0], this.hover[1] - last[1]);
      const ang = (Math.atan2(this.hover[1] - last[1], this.hover[0] - last[0]) * 180) / Math.PI;
      const [x, y] = this.toScreen((this.hover[0] + last[0]) / 2, (this.hover[1] + last[1]) / 2);
      if (len > 0) this.tag(`${fmt(len)} mm  ∠${fmt(ang)}°`, x, y - 14, col.accent);
    }
  }

  private drawFindingMarkers() {
    const c = this.ctx;
    const col = colors!;
    for (const f of ui.findings) {
      if (f.severity === "info" && ui.hoverFindingId !== f.id) continue;
      const r = f.refs.find((r) => r.view === this.view && r.u !== undefined && r.v !== undefined);
      if (!r) continue;
      const [x, y] = this.toScreen(r.u!, r.v!);
      const big = ui.hoverFindingId === f.id;
      c.beginPath();
      c.arc(x, y, big ? 9 : 7, 0, Math.PI * 2);
      c.fillStyle = col[f.severity];
      c.fill();
      c.strokeStyle = col.bg;
      c.lineWidth = 1.5;
      c.stroke();
      c.fillStyle = "#fff";
      c.font = `700 ${big ? 12 : 10}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(f.severity === "info" ? "i" : "!", x, y + 0.5);
    }
  }

  private drawCursor() {
    const c = this.ctx;
    const col = colors!;
    const { w, h } = this;
    // 스냅 정렬선
    if (ui.activeView === this.view && this.guides.length && (ui.tool !== "select" || this.drag)) {
      c.strokeStyle = col.snap;
      c.lineWidth = 1;
      c.setLineDash([2, 3]);
      c.beginPath();
      for (const g of this.guides) {
        if (g.axis === "u") {
          const x = Math.round(this.toScreen(g.value, 0)[0]) + 0.5;
          c.moveTo(x, 0);
          c.lineTo(x, h);
        } else {
          const y = Math.round(this.toScreen(0, g.value)[1]) + 0.5;
          c.moveTo(0, y);
          c.lineTo(w, y);
        }
      }
      c.stroke();
      c.setLineDash([]);
    }
    if (!ui.cursor) return;
    if (ui.activeView === this.view) {
      if (!this.hover || (ui.tool === "select" && !this.drag)) return;
      const [x, y] = this.toScreen(this.hover[0], this.hover[1]);
      c.strokeStyle = col.accent;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x - 10, y);
      c.lineTo(x + 10, y);
      c.moveTo(x, y - 10);
      c.lineTo(x, y + 10);
      c.stroke();
      if (this.guides.length) {
        c.beginPath();
        c.arc(x, y, 4, 0, Math.PI * 2);
        c.strokeStyle = col.snap;
        c.stroke();
      }
      return;
    }
    // 다른 창에서 그리는 중인 점의 투영선 (제도판의 투영선처럼)
    const cu = ui.cursor[this.ua];
    const cv = ui.cursor[this.va];
    c.strokeStyle = col.accent;
    c.globalAlpha = 0.45;
    c.lineWidth = 1;
    c.beginPath();
    if (cu !== null) {
      const x = Math.round(this.toScreen(cu, 0)[0]) + 0.5;
      c.moveTo(x, 0);
      c.lineTo(x, h);
    }
    if (cv !== null) {
      const y = Math.round(this.toScreen(0, cv)[1]) + 0.5;
      c.moveTo(0, y);
      c.lineTo(w, y);
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  private drawFlash() {
    const f = ui.flash;
    if (!f || f.view !== this.view) return;
    const left = f.until - performance.now();
    if (left <= 0) {
      ui.flash = null;
      return;
    }
    const [x, y] = this.toScreen(f.u, f.v);
    const c = this.ctx;
    const t = (left % 600) / 600;
    c.beginPath();
    c.arc(x, y, 10 + 18 * (1 - t), 0, Math.PI * 2);
    c.strokeStyle = colors!.accent;
    c.lineWidth = 2.5;
    c.globalAlpha = t;
    c.stroke();
    c.globalAlpha = 1;
    requestAnimationFrame(() => this.render());
  }

  get title() {
    const [u, v] = VIEW_AXES[this.view];
    return `${VIEW_LABEL[this.view]} · ${u}–${v}`;
  }
}

// ---------------- 도형 유틸 ----------------

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}

function clampScale(s: number) {
  return Math.min(Math.max(s, 0.05), 400);
}

/** 스냅 기준이 되는 점들 */
function keyPoints(s: Shape2D): Pt[] {
  if (s.kind === "circle")
    return [
      [s.cx, s.cy],
      [s.cx - s.r, s.cy - s.r],
      [s.cx + s.r, s.cy + s.r],
    ];
  if (s.kind === "slot") {
    const b = boundsOf([{ ...s, hole: false }])!;
    return [s.a, s.b, [b[0], b[1]], [b[2], b[3]]];
  }
  // 꼭짓점 + 원호 중심
  const pts: Pt[] = [...vertices(s)];
  for (const seg of outline(s)) {
    const arc = arcInfo(seg);
    if (arc) pts.push(arc.center);
  }
  return pts;
}

/** 선택한 도형의 손잡이 */
export function handles(s: Shape2D): Handle[] {
  const out: Handle[] = vertices(s).map((pt, index) => ({ pt, kind: "vertex" as const, index }));
  if (s.kind === "rect" || s.kind === "poly") {
    const pts = s.kind === "rect" ? rectPoints(s) : s.pts;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const bulge = s.kind === "poly" ? (s.bulges?.[i] ?? 0) : 0;
      const arc = arcInfo({ a: pts[i], b: pts[(i + 1) % n], bulge });
      const mid: Pt = arc ? arc.mid : [(pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2];
      out.push({ pt: mid, kind: "mid", index: i });
    }
  }
  return out;
}

export function vertices(s: Shape2D): Pt[] {
  if (s.kind === "rect") {
    const r = normRect(s);
    return [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ];
  }
  if (s.kind === "circle") return [[s.cx + s.r, s.cy]];
  if (s.kind === "slot") {
    // 두 중심점 + 폭 손잡이 (a 쪽 옆면)
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
    const n: Pt = [-(s.b[1] - s.a[1]) / L, (s.b[0] - s.a[0]) / L];
    const m: Pt = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    return [s.a, s.b, [m[0] + n[0] * (s.w / 2), m[1] + n[1] * (s.w / 2)]];
  }
  return s.pts;
}

function setVertex(s: Shape2D, i: number, p: Pt) {
  if (s.kind === "poly") s.pts[i] = p;
  else if (s.kind === "circle") s.r = Math.max(Math.hypot(p[0] - s.cx, p[1] - s.cy), 0.05);
  else if (s.kind === "slot") {
    if (i === 0) s.a = p;
    else if (i === 1) s.b = p;
    else {
      // 중심선에서 떨어진 거리 × 2 = 폭
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const d = L > 1e-9 ? Math.abs((s.b[0] - s.a[0]) * (p[1] - s.a[1]) - (s.b[1] - s.a[1]) * (p[0] - s.a[0])) / L : Math.hypot(p[0] - s.a[0], p[1] - s.a[1]);
      s.w = Math.max(Math.round(d * 2 * 1e4) / 1e4, 0.1);
    }
  } else {
    const opp = vertices(s)[(i + 2) % 4];
    const r = normRect(s);
    Object.assign(s, {
      x: Math.min(opp[0], p[0]),
      y: Math.min(opp[1], p[1]),
      w: Math.abs(p[0] - opp[0]) || r.w,
      h: Math.abs(p[1] - opp[1]) || r.h,
    });
  }
}

function translateShape(s: Shape2D, orig: Shape2D, du: number, dv: number) {
  Object.assign(s, translated(orig, du, dv));
}

function contains(outer: Shape2D, inner: Shape2D): boolean {
  return flatten(inner, Math.PI / 6).every(([u, v]) => pointInShape(u, v, outer));
}

export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function shapeLabel(s: Shape2D, short = false): string {
  const base = baseLabel(s);
  if (s.kind === "circle" && s.hole && (s.spec || s.depth !== undefined)) return holeLabel(s.r * 2, s.spec, s.depth, short);
  if (s.hole && s.depth !== undefined) return `${base} · 포켓 깊이 ${fmt(s.depth)}`;
  return base;
}

function baseLabel(s: Shape2D): string {
  if (s.kind === "rect") {
    const r = normRect(s);
    const c = s.corners?.find(Boolean);
    return `사각형 ${fmt(r.w)}×${fmt(r.h)}${c ? ` · ${c.kind === "fillet" ? "R" : "C"}${fmt(c.size)}` : ""}`;
  }
  if (s.kind === "circle") return `원 Ø${fmt(s.r * 2)}`;
  if (s.kind === "slot") return `장공 ${fmt(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]))}×${fmt(s.w)}`;
  const arcs = s.bulges?.filter((b) => b).length ?? 0;
  return `다각형 ${s.pts.length}점${arcs ? ` · 호 ${arcs}` : ""}`;
}
