import { boundsOf, isDegenerate, normRect, pointInShape, shapeCenter } from "../core/geometry2d";
import { VIEW_AXES, VIEW_IDS, VIEW_LABEL, type Severity, type Shape2D, type ViewId } from "../core/types";
import { newId, store } from "../store";
import { ui } from "./state";

type Pt = [number, number];
const AX = { X: 0, Y: 1, Z: 2 } as const;

interface Guide {
  axis: "u" | "v";
  value: number;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; c: [number, number, number] }
  | { kind: "move"; shape: Shape2D; orig: Shape2D; anchor: Pt; grab: Pt; moved: boolean }
  | { kind: "vertex"; shape: Shape2D; index: number; moved: boolean };

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
  };
}

let colors: Colors | null = null;
export function refreshColors() {
  colors = readColors();
}

/**
 * 2D 도면 창 하나 (정면도/평면도/우측면도).
 * 화면(px, y 아래) ↔ 뷰 좌표(mm, u 오른쪽, v 위) ↔ 3D 좌표(X, Y, Z)
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
  private guides: Guide[] = [];
  private dpr = 1;
  private spaceDown = false;
  private dyn: HTMLInputElement;
  private dynHint: HTMLDivElement;
  readonly ua: number;
  readonly va: number;

  constructor(
    private canvas: HTMLCanvasElement,
    readonly view: ViewId,
  ) {
    this.ctx = canvas.getContext("2d")!;
    const [u, v] = VIEW_AXES[view];
    this.ua = AX[u];
    this.va = AX[v];
    if (!colors) refreshColors();

    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.hoverRaw = null;
      this.hoverShapeId = null;
      if (ui.cursor && ui.activeView === this.view) {
        ui.cursor = null;
        ui.emit();
      }
    });
    canvas.addEventListener("dblclick", () => {
      if (ui.tool === "poly" && this.polyDraft.length >= 3) this.finishPoly();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTyping()) this.spaceDown = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceDown = false;
    });

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
  toScreen(u: number, v: number): [number, number] {
    const { scale, c } = ui.camera;
    return [this.w / 2 + (u - c[this.ua]) * scale, this.h / 2 - (v - c[this.va]) * scale];
  }
  toWorld(x: number, y: number): Pt {
    const { scale, c } = ui.camera;
    return [(x - this.w / 2) / scale + c[this.ua], -(y - this.h / 2) / scale + c[this.va]];
  }
  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** 이 뷰가 화면에 꽉 차도록 (공유 카메라를 이 뷰 기준으로) */
  fitTo(bounds: [number, number, number, number] | null) {
    const b = bounds ?? [0, 0, 60, 40];
    const bw = Math.max(b[2] - b[0], 10);
    const bh = Math.max(b[3] - b[1], 10);
    ui.camera.scale = clampScale(Math.min((this.w * 0.7) / bw, (this.h * 0.7) / bh));
    ui.camera.c[this.ua] = (b[0] + b[2]) / 2;
    ui.camera.c[this.va] = (b[1] + b[3]) / 2;
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
    const had = this.polyDraft.length > 0 || this.creating !== null;
    this.polyDraft = [];
    this.creating = null;
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

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
    if (ui.activeView !== this.view) {
      ui.activeView = this.view;
      ui.emit();
    }
    const [x, y] = this.local(e);

    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.drag = { kind: "pan", sx: x, sy: y, c: [...ui.camera.c] };
      return;
    }
    if (e.button !== 0) return;
    if (this.revolveLocked()) return;

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

    if (ui.tool === "rect" || ui.tool === "circle") {
      const shape: Shape2D =
        ui.tool === "rect"
          ? { id: newId(), kind: "rect", hole: false, x: sp[0], y: sp[1], w: 0, h: 0 }
          : { id: newId(), kind: "circle", hole: false, cx: sp[0], cy: sp[1], r: 0 };
      this.creating = { shape, start: sp, downAt: [x, y], dragged: false };
      this.render();
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
    this.drag = { kind: "pan", sx: x, sy: y, c: [...ui.camera.c] };
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    this.hoverRaw = [x, y];
    const raw = this.toWorld(x, y);
    const d = this.drag;

    if (d?.kind === "pan") {
      const { scale } = ui.camera;
      ui.camera.c[this.ua] = d.c[this.ua] - (x - d.sx) / scale;
      ui.camera.c[this.va] = d.c[this.va] + (y - d.sy) / scale;
      ui.emit();
      return;
    }

    const excl = d?.kind === "move" || d?.kind === "vertex" ? d.shape.id : this.creating?.shape.id;
    let { pt, guides } = this.snap(raw, excl);
    if (e.shiftKey && ui.tool === "poly" && this.polyDraft.length) pt = this.ortho(pt, this.polyDraft[this.polyDraft.length - 1]);
    this.hover = pt;
    this.guides = guides;
    this.hoverShapeId = !d && ui.tool === "select" ? (this.hitShape(raw)?.id ?? null) : null;

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
    }
    ui.emit();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (this.creating?.dragged) {
      this.finishCreate();
      return;
    }
    if (!d) return;
    if ((d.kind === "move" || d.kind === "vertex") && !d.moved) store.dropCheckpoint();
    void e;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [x, y] = this.local(e);
    // 트랙패드 두 손가락 스크롤(ctrl 없이 가로 이동이 섞임) → 화면 이동, 그 외 → 확대/축소
    const isPan = !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5;
    if (isPan) {
      ui.camera.c[this.ua] += e.deltaX / ui.camera.scale;
      ui.camera.c[this.va] -= e.deltaY / ui.camera.scale;
      ui.emit();
      return;
    }
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const before = this.toWorld(x, y);
    ui.camera.scale = clampScale(ui.camera.scale * k);
    const after = this.toWorld(x, y);
    ui.camera.c[this.ua] += before[0] - after[0];
    ui.camera.c[this.va] += before[1] - after[1];
    ui.emit();
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

  private addShape(s: Shape2D) {
    // 이미 있는 몸체 안쪽에 그리면 자동으로 구멍
    const [cx, cy] = shapeCenter(s);
    s.hole = store.project.views[this.view].some((o) => !o.hole && pointInShape(cx, cy, o) && contains(o, s));
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

  private hitVertex(s: Shape2D, x: number, y: number): number {
    const vs = vertices(s);
    for (let i = 0; i < vs.length; i++) {
      const [sx, sy] = this.toScreen(vs[i][0], vs[i][1]);
      if (Math.hypot(sx - x, sy - y) < 8) return i;
    }
    return -1;
  }

  private revolveLocked() {
    return store.project.mode === "revolve" && this.view !== "front";
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
          : "다음 점: 거리<각도 (예: 30<90) 또는 Δx,Δy ⏎";
    this.dyn.value = first;
    this.dyn.focus();
  }

  private closeDyn() {
    if (this.dyn.hidden) return;
    this.dyn.hidden = true;
    this.dynHint.hidden = true;
    this.canvas.focus();
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

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.render();
  }

  render() {
    const c = this.ctx;
    const col = colors!;
    const { w, h } = this;
    if (!w || !h) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = col.bg;
    c.fillRect(0, 0, w, h);
    this.drawGrid();
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
      c.fillStyle = col.bg;
      c.fill();
      c.lineWidth = 1.25;
      c.strokeStyle = col.holeStroke;
      c.setLineDash([5, 3]);
      c.stroke();
      c.setLineDash([]);
    }
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
      for (const [u, v] of vertices(sel)) {
        const [x, y] = this.toScreen(u, v);
        c.fillStyle = col.bg;
        c.strokeStyle = col.accent;
        c.lineWidth = 1.5;
        c.fillRect(x - 4, y - 4, 8, 8);
        c.strokeRect(x - 4, y - 4, 8, 8);
      }
      this.label(sel);
    }
    if (draft) this.label(draft);
    this.drawPolyDraft();
    this.drawFindingMarkers();
    this.drawCursor();
    this.drawFlash();

    if (this.revolveLocked()) {
      c.fillStyle = col.bg;
      c.globalAlpha = 0.75;
      c.fillRect(0, 0, w, h);
      c.globalAlpha = 1;
      c.fillStyle = col.text;
      c.font = "13px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("회전체 모드에서는 정면도만 사용합니다", w / 2, h / 2);
    }
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
    vertices(s).forEach(([u, v], i) => {
      const [x, y] = this.toScreen(u, v);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.closePath();
  }

  private label(s: Shape2D) {
    let text: string;
    let at: Pt;
    if (s.kind === "rect") {
      const r = normRect(s);
      text = `${fmt(r.w)} × ${fmt(r.h)}`;
      at = [r.x + r.w / 2, r.y + r.h];
    } else if (s.kind === "circle") {
      text = `Ø${fmt(s.r * 2)}`;
      at = [s.cx, s.cy + s.r];
    } else {
      const b = boundsOf([{ ...s, hole: false }])!;
      text = `${fmt(b[2] - b[0])} × ${fmt(b[3] - b[1])}`;
      at = [(b[0] + b[2]) / 2, b[3]];
    }
    const [x, y] = this.toScreen(at[0], at[1]);
    this.tag(text, x, y - 14, colors!.accent);
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

  private drawGrid() {
    const c = this.ctx;
    const col = colors!;
    const { w, h } = this;
    const steps = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const step = steps.find((s) => s >= (ui.grid || 1) && s * ui.camera.scale >= 8) ?? 5000;
    const major = steps.find((s) => s >= step * 5) ?? step * 5;
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
    const [ax, ay] = this.toScreen(0, 0);
    const revolve = store.project.mode === "revolve" && this.view === "front";
    c.strokeStyle = col.axis;
    c.lineWidth = revolve ? 1.5 : 1;
    c.setLineDash(revolve ? [12, 4, 2, 4] : []);
    c.beginPath();
    c.moveTo(Math.round(ax) + 0.5, 0);
    c.lineTo(Math.round(ax) + 0.5, h);
    c.moveTo(0, Math.round(ay) + 0.5);
    c.lineTo(w, Math.round(ay) + 0.5);
    c.stroke();
    c.setLineDash([]);
    if (revolve) {
      c.fillStyle = col.axis;
      c.font = "600 11px system-ui, sans-serif";
      c.textAlign = "left";
      c.textBaseline = "top";
      c.fillText("회전축 (Z) — 오른쪽에 단면 절반을 그리세요", ax + 6, 8);
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
  return vertices(s);
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
  return s.pts;
}

function setVertex(s: Shape2D, i: number, p: Pt) {
  if (s.kind === "poly") s.pts[i] = p;
  else if (s.kind === "circle") s.r = Math.max(Math.hypot(p[0] - s.cx, p[1] - s.cy), 0.05);
  else {
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
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  if (s.kind === "rect" && orig.kind === "rect") {
    s.x = r(orig.x + du);
    s.y = r(orig.y + dv);
  } else if (s.kind === "circle" && orig.kind === "circle") {
    s.cx = r(orig.cx + du);
    s.cy = r(orig.cy + dv);
  } else if (s.kind === "poly" && orig.kind === "poly") {
    s.pts = orig.pts.map(([u, v]) => [r(u + du), r(v + dv)]);
  }
}

function contains(outer: Shape2D, inner: Shape2D): boolean {
  const pts: Pt[] =
    inner.kind === "circle"
      ? Array.from({ length: 12 }, (_, i) => [inner.cx + inner.r * Math.cos((i * Math.PI) / 6), inner.cy + inner.r * Math.sin((i * Math.PI) / 6)])
      : vertices(inner);
  return pts.every(([u, v]) => pointInShape(u, v, outer));
}

export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function shapeLabel(s: Shape2D): string {
  if (s.kind === "rect") {
    const r = normRect(s);
    return `사각형 ${fmt(r.w)}×${fmt(r.h)}`;
  }
  if (s.kind === "circle") return `원 Ø${fmt(s.r * 2)}`;
  return `다각형 ${s.pts.length}점`;
}
