import { boundsOf, isDegenerate, normRect, pointInShape, shapeCenter } from "../core/geometry2d";
import { VIEW_AXES, VIEW_IDS, type Shape2D, type ViewId } from "../core/types";
import { newId, store } from "../store";

export type Tool = "select" | "rect" | "circle" | "poly";

type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "move"; shape: Shape2D; start: [number, number]; orig: Shape2D; moved: boolean }
  | { kind: "vertex"; shape: Shape2D; index: number; moved: boolean }
  | { kind: "create"; shape: Shape2D; start: [number, number] };

interface Colors {
  bg: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  solidFill: string;
  solidStroke: string;
  holeStroke: string;
  select: string;
  guide: string;
  text: string;
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
    select: v("--accent"),
    guide: v("--guide"),
    text: v("--text-muted"),
  };
}

/**
 * 한 뷰의 2D 스케치 편집기 (캔버스).
 * 좌표: 월드(mm, v는 위쪽) ↔ 화면(px, y는 아래쪽)
 */
export class SketchEditor {
  view: ViewId = "front";
  tool: Tool = "select";
  grid = 5;
  selectedId: string | null = null;
  /** 작성 중인 다각형 점들 */
  polyDraft: [number, number][] = [];
  onSelect: (s: Shape2D | null) => void = () => {};
  onPolyDraft: (n: number) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private scale = 4; // px per mm
  private ox = 0; // 화면상의 월드 원점
  private oy = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private pinch: { dist: number; mid: [number, number]; scale: number; ox: number; oy: number } | null = null;
  private hover: [number, number] | null = null;
  private colors: Colors = readColors();
  private dpr = 1;
  private needsFit = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.render();
    });
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.resize()).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.colors = readColors();
      this.render();
    });
    store.subscribe(() => this.render());
  }

  // ---------- 공개 API ----------

  setView(v: ViewId) {
    this.cancelPoly();
    this.view = v;
    this.select(null);
    this.fit();
  }

  setTool(t: Tool) {
    if (t !== "poly") this.cancelPoly();
    this.tool = t;
    this.render();
  }

  refreshColors() {
    this.colors = readColors();
    this.render();
  }

  /** 현재 뷰(없으면 다른 뷰) 도형이 모두 보이게 화면 맞춤 */
  fit() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) {
      this.needsFit = true;
      return;
    }
    this.needsFit = false;
    let b = boundsOf(store.shapes(this.view));
    if (!b) {
      // 다른 뷰에서 공유하는 축의 범위를 참고
      const g = this.guideRanges();
      const ur = g.u ?? [0, 60];
      const vr = g.v ?? [0, 40];
      b = [ur[0], vr[0], ur[1], vr[1]];
    }
    const bw = Math.max(b[2] - b[0], 10);
    const bh = Math.max(b[3] - b[1], 10);
    this.scale = Math.min((w * 0.75) / bw, (h * 0.7) / bh);
    this.scale = Math.min(Math.max(this.scale, 0.2), 200);
    this.ox = w / 2 - ((b[0] + b[2]) / 2) * this.scale;
    this.oy = h / 2 + ((b[1] + b[3]) / 2) * this.scale;
    this.render();
  }

  select(id: string | null) {
    this.selectedId = id;
    this.onSelect(this.selected());
    this.render();
  }

  selected(): Shape2D | null {
    return store.shapes(this.view).find((s) => s.id === this.selectedId) ?? null;
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const id = this.selectedId;
    store.update((p) => {
      p.views[this.view] = p.views[this.view].filter((s) => s.id !== id);
    });
    this.select(null);
  }

  /** 작성 중인 다각형을 닫아서 확정 */
  finishPoly() {
    const pts = this.polyDraft;
    this.polyDraft = [];
    this.onPolyDraft(0);
    if (pts.length < 3) {
      this.render();
      return;
    }
    const s: Shape2D = { id: newId(), kind: "poly", hole: false, pts };
    if (isDegenerate(s)) {
      this.render();
      return;
    }
    this.addShape(s);
  }

  cancelPoly() {
    if (!this.polyDraft.length) return;
    this.polyDraft = [];
    this.onPolyDraft(0);
    this.render();
  }

  undoPolyPoint() {
    this.polyDraft.pop();
    this.onPolyDraft(this.polyDraft.length);
    this.render();
  }

  // ---------- 좌표 ----------

  private toWorld(x: number, y: number): [number, number] {
    return [(x - this.ox) / this.scale, (this.oy - y) / this.scale];
  }
  private toScreen(u: number, v: number): [number, number] {
    return [this.ox + u * this.scale, this.oy - v * this.scale];
  }
  private snap(p: [number, number]): [number, number] {
    const g = this.grid;
    if (!g) return p;
    const r = (n: number) => Math.round(Math.round(n / g) * g * 1e6) / 1e6;
    return [r(p[0]), r(p[1])];
  }
  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---------- 입력 ----------

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });

    if (this.pointers.size === 2) {
      // 두 손가락: 확대/이동. 진행 중이던 생성은 취소
      if (this.drag?.kind === "create") this.drag = null;
      if (this.drag && (this.drag.kind === "move" || this.drag.kind === "vertex")) {
        if (this.drag.moved) store.revert();
        else store.dropCheckpoint();
      }
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
        scale: this.scale,
        ox: this.ox,
        oy: this.oy,
      };
      this.render();
      return;
    }
    if (this.pointers.size > 2) return;

    const w = this.toWorld(x, y);
    const sw = this.snap(w);

    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: "pan", sx: x, sy: y, ox: this.ox, oy: this.oy };
      return;
    }

    if (this.tool === "poly") {
      const first = this.polyDraft[0];
      if (first && this.polyDraft.length >= 3) {
        const [fx, fy] = this.toScreen(first[0], first[1]);
        if (Math.hypot(fx - x, fy - y) < 18) {
          this.finishPoly();
          return;
        }
      }
      const last = this.polyDraft[this.polyDraft.length - 1];
      if (!last || last[0] !== sw[0] || last[1] !== sw[1]) this.polyDraft.push(sw);
      this.onPolyDraft(this.polyDraft.length);
      this.render();
      return;
    }

    if (this.tool === "rect" || this.tool === "circle") {
      const shape: Shape2D =
        this.tool === "rect"
          ? { id: newId(), kind: "rect", hole: false, x: sw[0], y: sw[1], w: 0, h: 0 }
          : { id: newId(), kind: "circle", hole: false, cx: sw[0], cy: sw[1], r: 0 };
      this.drag = { kind: "create", shape, start: sw };
      return;
    }

    // 선택 도구
    const sel = this.selected();
    if (sel) {
      const vi = this.hitVertex(sel, x, y);
      if (vi >= 0) {
        store.checkpoint();
        this.drag = { kind: "vertex", shape: sel, index: vi, moved: false };
        return;
      }
    }
    const hit = this.hitShape(w);
    if (hit) {
      this.select(hit.id);
      store.checkpoint();
      this.drag = { kind: "move", shape: hit, start: sw, orig: structuredClone(hit), moved: false };
      return;
    }
    this.select(null);
    this.drag = { kind: "pan", sx: x, sy: y, ox: this.ox, oy: this.oy };
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const k = dist / Math.max(this.pinch.dist, 1);
      const ns = Math.min(Math.max(this.pinch.scale * k, 0.2), 200);
      const f = ns / this.pinch.scale;
      this.scale = ns;
      this.ox = mid[0] - (this.pinch.mid[0] - this.pinch.ox) * f;
      this.oy = mid[1] - (this.pinch.mid[1] - this.pinch.oy) * f;
      this.render();
      return;
    }

    const w = this.toWorld(x, y);
    const sw = this.snap(w);
    this.hover = e.pointerType === "mouse" || this.drag ? sw : null;

    const d = this.drag;
    if (!d) {
      this.render();
      return;
    }
    if (d.kind === "pan") {
      this.ox = d.ox + (x - d.sx);
      this.oy = d.oy + (y - d.sy);
    } else if (d.kind === "create") {
      const s = d.shape;
      if (s.kind === "rect") {
        s.w = sw[0] - d.start[0];
        s.h = sw[1] - d.start[1];
      } else if (s.kind === "circle") {
        const r = Math.hypot(w[0] - d.start[0], w[1] - d.start[1]);
        s.r = this.grid ? Math.max(this.grid / 2, Math.round(r / (this.grid / 2)) * (this.grid / 2)) : r;
      }
    } else if (d.kind === "move") {
      const du = sw[0] - d.start[0];
      const dv = sw[1] - d.start[1];
      if (du || dv) d.moved = true;
      translateShape(d.shape, d.orig, du, dv);
      store.changed();
      this.onSelect(d.shape);
    } else if (d.kind === "vertex") {
      d.moved = true;
      setVertex(d.shape, d.index, sw);
      store.changed();
      this.onSelect(d.shape);
    }
    this.render();
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === "create") {
      const s = d.shape;
      if (s.kind === "rect") Object.assign(s, normRect(s));
      if (!isDegenerate(s)) this.addShape(s);
      else this.render();
    } else if ((d.kind === "move" || d.kind === "vertex") && !d.moved) {
      // 아무 변화 없으면 실행 취소 지점을 남기지 않는다
      store.dropCheckpoint();
    }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [x, y] = this.local(e);
    const k = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.min(Math.max(this.scale * k, 0.2), 200);
    const f = ns / this.scale;
    this.ox = x - (x - this.ox) * f;
    this.oy = y - (y - this.oy) * f;
    this.scale = ns;
    this.render();
  }

  private addShape(s: Shape2D) {
    // 이미 있는 몸체 안쪽에 그리면 자동으로 구멍으로 지정
    const [cx, cy] = shapeCenter(s);
    s.hole = store.shapes(this.view).some((o) => !o.hole && pointInShape(cx, cy, o) && contains(o, s));
    store.update((p) => {
      p.views[this.view].push(s);
    });
    this.select(s.id);
  }

  private hitShape(w: [number, number]): Shape2D | null {
    const list = store.shapes(this.view);
    // 위에 그려진(나중) 도형, 그리고 구멍을 우선
    const ordered = [...list.filter((s) => s.hole).reverse(), ...list.filter((s) => !s.hole).reverse()];
    const pad = 6 / this.scale;
    for (const s of ordered) {
      if (pointInShape(w[0], w[1], s)) return s;
      if (s.kind === "circle" && Math.abs(Math.hypot(w[0] - s.cx, w[1] - s.cy) - s.r) < pad) return s;
    }
    return null;
  }

  private hitVertex(s: Shape2D, x: number, y: number): number {
    const vs = vertices(s);
    for (let i = 0; i < vs.length; i++) {
      const [sx, sy] = this.toScreen(vs[i][0], vs[i][1]);
      if (Math.hypot(sx - x, sy - y) < 16) return i;
    }
    return -1;
  }

  /** 다른 뷰에서 이 뷰와 공유하는 축의 범위 (도면 정렬 보조선) */
  private guideRanges(): { u: [number, number] | null; v: [number, number] | null } {
    const [ua, va] = VIEW_AXES[this.view];
    let u: [number, number] | null = null;
    let v: [number, number] | null = null;
    for (const other of VIEW_IDS) {
      if (other === this.view) continue;
      const b = boundsOf(store.shapes(other));
      if (!b) continue;
      const [oua, ova] = VIEW_AXES[other];
      const ranges: Record<string, [number, number]> = {};
      ranges[oua] = [b[0], b[2]];
      ranges[ova] = [b[1], b[3]];
      if (ranges[ua]) u = merge(u, ranges[ua]);
      if (ranges[va]) v = merge(v, ranges[va]);
    }
    return { u, v };
  }

  // ---------- 그리기 ----------

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    if (this.needsFit) this.fit();
    else this.render();
  }

  render() {
    const c = this.ctx;
    const col = this.colors;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = col.bg;
    c.fillRect(0, 0, w, h);

    this.drawGrid(w, h);
    this.drawGuides(w, h);

    const shapes = store.shapes(this.view);
    const draft = this.drag?.kind === "create" ? this.drag.shape : null;
    // 몸체 → 구멍 순서로 칠해서 구멍이 뚫려 보이게
    for (const s of [...shapes.filter((s) => !s.hole), ...(draft && !draft.hole ? [draft] : [])]) {
      this.pathShape(s);
      c.fillStyle = col.solidFill;
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = col.solidStroke;
      c.setLineDash([]);
      c.stroke();
    }
    for (const s of shapes.filter((s) => s.hole)) {
      this.pathShape(s);
      c.fillStyle = col.bg;
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = col.holeStroke;
      c.setLineDash([6, 4]);
      c.stroke();
      c.setLineDash([]);
    }

    const sel = this.selected();
    if (sel) {
      this.pathShape(sel);
      c.lineWidth = 2.5;
      c.strokeStyle = col.select;
      c.stroke();
      for (const [u, v] of vertices(sel)) {
        const [x, y] = this.toScreen(u, v);
        c.fillStyle = col.bg;
        c.strokeStyle = col.select;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, y, 6, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
      this.drawShapeLabel(sel);
    }
    if (draft) this.drawShapeLabel(draft);

    // 작성 중인 다각형
    if (this.polyDraft.length) {
      c.beginPath();
      this.polyDraft.forEach(([u, v], i) => {
        const [x, y] = this.toScreen(u, v);
        if (i) c.lineTo(x, y);
        else c.moveTo(x, y);
      });
      if (this.hover) {
        const [x, y] = this.toScreen(this.hover[0], this.hover[1]);
        c.lineTo(x, y);
      }
      c.strokeStyle = col.select;
      c.lineWidth = 2;
      c.stroke();
      this.polyDraft.forEach(([u, v], i) => {
        const [x, y] = this.toScreen(u, v);
        c.beginPath();
        c.arc(x, y, i === 0 ? 9 : 4, 0, Math.PI * 2);
        c.fillStyle = i === 0 ? col.select : col.bg;
        c.fill();
        c.strokeStyle = col.select;
        c.stroke();
      });
    }

    // 커서 위치 좌표
    if (this.hover && (this.tool !== "select" || this.drag)) {
      const [x, y] = this.toScreen(this.hover[0], this.hover[1]);
      c.strokeStyle = col.select;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x - 8, y);
      c.lineTo(x + 8, y);
      c.moveTo(x, y - 8);
      c.lineTo(x, y + 8);
      c.stroke();
    }
    const [ua, va] = VIEW_AXES[this.view];
    c.fillStyle = col.text;
    c.font = "12px system-ui, sans-serif";
    c.textAlign = "left";
    c.textBaseline = "bottom";
    const pos = this.hover ? `  (${fmt(this.hover[0])}, ${fmt(this.hover[1])})` : "";
    c.fillText(`가로 ${ua} · 세로 ${va} · 격자 ${this.grid || "끔"}${this.grid ? "mm" : ""}${pos}`, 10, h - 8);
  }

  private pathShape(s: Shape2D) {
    const c = this.ctx;
    c.beginPath();
    if (s.kind === "circle") {
      const [x, y] = this.toScreen(s.cx, s.cy);
      c.arc(x, y, Math.max(s.r * this.scale, 0.5), 0, Math.PI * 2);
      return;
    }
    vertices(s).forEach(([u, v], i) => {
      const [x, y] = this.toScreen(u, v);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.closePath();
  }

  private drawShapeLabel(s: Shape2D) {
    const c = this.ctx;
    let label = "";
    let at: [number, number];
    if (s.kind === "rect") {
      const r = normRect(s);
      label = `${fmt(r.w)} × ${fmt(r.h)}`;
      at = [r.x + r.w / 2, r.y + r.h];
    } else if (s.kind === "circle") {
      label = `Ø${fmt(s.r * 2)}`;
      at = [s.cx, s.cy + s.r];
    } else {
      const b = boundsOf([{ ...s, hole: false }])!;
      label = `${fmt(b[2] - b[0])} × ${fmt(b[3] - b[1])}`;
      at = [(b[0] + b[2]) / 2, b[3]];
    }
    const [x, y] = this.toScreen(at[0], at[1]);
    c.font = "600 12px system-ui, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "bottom";
    const tw = c.measureText(label).width + 10;
    c.fillStyle = this.colors.select;
    c.beginPath();
    c.roundRect(x - tw / 2, y - 26, tw, 18, 4);
    c.fill();
    c.fillStyle = "#fff";
    c.fillText(label, x, y - 11);
  }

  private drawGrid(w: number, h: number) {
    const c = this.ctx;
    const col = this.colors;
    // 화면에서 격자 간격이 너무 촘촘하지 않게
    const base = this.grid || 1;
    const steps = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const step = steps.find((s) => s >= base && s * this.scale >= 8) ?? 5000;
    const major = step * 5;
    const [u0, v1] = this.toWorld(0, 0);
    const [u1, v0] = this.toWorld(w, h);
    c.lineWidth = 1;
    for (const [st, color] of [
      [step, col.gridMinor],
      [major, col.gridMajor],
    ] as const) {
      c.strokeStyle = color;
      c.beginPath();
      for (let u = Math.floor(u0 / st) * st; u <= u1; u += st) {
        const x = Math.round(this.toScreen(u, 0)[0]) + 0.5;
        c.moveTo(x, 0);
        c.lineTo(x, h);
      }
      for (let v = Math.floor(v0 / st) * st; v <= v1; v += st) {
        const y = Math.round(this.toScreen(0, v)[1]) + 0.5;
        c.moveTo(0, y);
        c.lineTo(w, y);
      }
      c.stroke();
    }
    // 원점 축
    const [ax, ay] = this.toScreen(0, 0);
    const revolve = store.project.mode === "revolve" && this.view === "front";
    c.strokeStyle = col.axis;
    c.lineWidth = revolve ? 2 : 1.25;
    c.setLineDash(revolve ? [12, 4, 2, 4] : []);
    c.beginPath();
    c.moveTo(ax, 0);
    c.lineTo(ax, h);
    c.moveTo(0, ay);
    c.lineTo(w, ay);
    c.stroke();
    c.setLineDash([]);
    if (revolve) {
      c.fillStyle = col.axis;
      c.font = "600 12px system-ui, sans-serif";
      c.textAlign = "left";
      c.textBaseline = "top";
      c.fillText("회전축 — 오른쪽 절반에 단면을 그리세요", ax + 6, 8);
    }
  }

  private drawGuides(w: number, h: number) {
    if (store.project.mode === "revolve") return;
    const g = this.guideRanges();
    const c = this.ctx;
    c.strokeStyle = this.colors.guide;
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.beginPath();
    if (g.u)
      for (const u of g.u) {
        const x = Math.round(this.toScreen(u, 0)[0]) + 0.5;
        c.moveTo(x, 0);
        c.lineTo(x, h);
      }
    if (g.v)
      for (const v of g.v) {
        const y = Math.round(this.toScreen(0, v)[1]) + 0.5;
        c.moveTo(0, y);
        c.lineTo(w, y);
      }
    c.stroke();
    c.setLineDash([]);
  }
}

// ---------- 도형 유틸 ----------

function vertices(s: Shape2D): [number, number][] {
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
  return s.pts;
}

function setVertex(s: Shape2D, i: number, p: [number, number]) {
  if (s.kind === "poly") {
    s.pts[i] = p;
  } else if (s.kind === "circle") {
    s.r = Math.max(Math.hypot(p[0] - s.cx, p[1] - s.cy), 0.1);
  } else {
    const r = normRect(s);
    // 반대편 꼭짓점을 고정
    const opp = vertices(s)[(i + 2) % 4];
    const nx = Math.min(opp[0], p[0]);
    const ny = Math.min(opp[1], p[1]);
    Object.assign(s, { x: nx, y: ny, w: Math.abs(p[0] - opp[0]) || r.w, h: Math.abs(p[1] - opp[1]) || r.h });
  }
}

function translateShape(s: Shape2D, orig: Shape2D, du: number, dv: number) {
  if (s.kind === "rect" && orig.kind === "rect") {
    s.x = orig.x + du;
    s.y = orig.y + dv;
  } else if (s.kind === "circle" && orig.kind === "circle") {
    s.cx = orig.cx + du;
    s.cy = orig.cy + dv;
  } else if (s.kind === "poly" && orig.kind === "poly") {
    s.pts = orig.pts.map(([u, v]) => [u + du, v + dv]);
  }
}

function contains(outer: Shape2D, inner: Shape2D): boolean {
  return vertices(inner.kind === "circle" ? circleBox(inner) : inner).every(([u, v]) => pointInShape(u, v, outer));
}

function circleBox(c: Extract<Shape2D, { kind: "circle" }>): Shape2D {
  const k = Math.SQRT1_2 * c.r;
  return {
    id: "",
    kind: "poly",
    hole: false,
    pts: [
      [c.cx - c.r, c.cy],
      [c.cx + c.r, c.cy],
      [c.cx, c.cy - c.r],
      [c.cx, c.cy + c.r],
      [c.cx + k, c.cy + k],
      [c.cx - k, c.cy - k],
    ],
  };
}

function merge(a: [number, number] | null, b: [number, number]): [number, number] {
  return a ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : b;
}

export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}
