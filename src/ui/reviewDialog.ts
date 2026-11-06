/**
 * 도면 검토 창 (AI): 사진·스케치·도면 1~6장 → 손글씨 치수 읽기, 뷰·도면끼리 비교, 문제와 질문, 3D 초안.
 */
import { draftToProject, requestDrawingReview, type DrawingImage, type DrawingReview } from "../aiDrawing";
import { getApiKey } from "../aiKey";
import type { Project } from "../core/types";
import { fileToCanvas } from "./importDialog";

type Box = { x: number; y: number; w: number; h: number };
interface Img {
  name: string;
  canvas: HTMLCanvasElement;
}

const MAX_SIDE = 2576; // 이 크기까지는 AI가 원본 해상도로 본다
const SEV = { error: { label: "오류", color: "#dc2626" }, warning: { label: "주의", color: "#d97706" }, info: { label: "확인", color: "#2563eb" } } as const;
const KIND: Record<string, string> = {
  cad_drawing: "CAD 도면",
  hand_sketch: "손 스케치",
  tablet_sketch: "태블릿 스케치",
  photo: "사진",
  screenshot: "화면 캡처",
  other: "기타",
};
const PROJ: Record<string, string> = {
  third_angle: "3각법",
  first_angle: "1각법",
  mixed_or_unclear: "투상법이 섞였거나 애매함",
  single_view: "뷰 하나",
  not_applicable: "—",
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, cls?: string, kids: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

function toJpeg(c: HTMLCanvasElement): DrawingImage["data"] {
  const k = Math.min(1, MAX_SIDE / Math.max(c.width, c.height));
  let src = c;
  if (k < 1) {
    src = document.createElement("canvas");
    src.width = Math.round(c.width * k);
    src.height = Math.round(c.height * k);
    const ctx = src.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(c, 0, 0, src.width, src.height);
  }
  return src.toDataURL("image/jpeg", 0.9).split(",")[1];
}

export class ReviewDialog {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private thumbs: HTMLDivElement;
  private panel: HTMLElement;
  private imgs: Img[] = [];
  private sel = 0;
  private focus: number | null = null;
  private note = "";
  private result: DrawingReview | null = null;
  private error = "";
  private busy: AbortController | null = null;
  private started = 0;

  constructor(
    private hooks: { onDraft: (p: Project) => void; openSettings: () => void },
  ) {
    this.canvas = h("canvas", {}, "rv-canvas");
    this.thumbs = h("div", {}, "rv-thumbs");
    this.panel = h("aside", {}, "imp-panel rv-panel");
    const add = h("button", { textContent: "그림 추가…" });
    add.onclick = () => this.pick();
    const close = h("button", { textContent: "닫기" });
    close.onclick = () => this.close();
    this.root = h("div", { hidden: true, tabIndex: -1 }, "import-dlg", [
      h("div", {}, "imp-head", [h("b", { textContent: "도면 검토 (AI)" }), h("span", { textContent: "사진·손 스케치·도면을 읽고 잘못된 점과 확인할 점을 알려 줍니다" }, "muted small"), h("div", {}, "spacer"), add, close]),
      h("div", {}, "imp-body", [h("div", {}, "imp-stage rv-stage", [this.thumbs, this.canvas]), this.panel]),
    ]);
    document.body.appendChild(this.root);
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
    this.canvas.addEventListener("click", (e) => this.clickCanvas(e));
    window.addEventListener("resize", () => this.isOpen && this.draw());
    // 창에 그림을 끌어다 놓으면 추가
    this.root.addEventListener("dragover", (e) => e.preventDefault());
    this.root.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) this.add(files);
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  async open(files: File[] = []) {
    this.root.hidden = false;
    this.root.focus();
    if (files.length) await this.add(files, true);
    this.render();
  }

  close() {
    this.busy?.abort();
    this.root.hidden = true;
  }

  pick() {
    const input = h("input", { type: "file", accept: "image/*,.pdf,application/pdf", multiple: true });
    input.onchange = () => input.files?.length && this.open([...input.files]);
    input.click();
  }

  private async add(files: File[], replace = false) {
    if (replace) {
      this.imgs = [];
      this.result = null;
      this.focus = null;
      this.error = "";
    }
    for (const f of files) {
      if (this.imgs.length >= 6) {
        this.error = "한 번에 6장까지 검토할 수 있어요.";
        break;
      }
      try {
        const { canvas, pages } = await fileToCanvas(f);
        this.imgs.push({ name: pages > 1 ? `${f.name} (1쪽)` : f.name, canvas });
      } catch {
        this.error = `${f.name}을(를) 읽을 수 없습니다.`;
      }
    }
    this.sel = Math.min(this.sel, Math.max(0, this.imgs.length - 1));
    this.render();
  }

  private async run() {
    if (!this.imgs.length || this.busy) return;
    this.busy = new AbortController();
    this.started = Date.now();
    this.error = "";
    this.result = null;
    this.focus = null;
    this.render();
    const tick = window.setInterval(() => this.renderPanel(), 1000);
    try {
      const images = this.imgs.map((im) => ({ name: im.name, data: toJpeg(im.canvas), mediaType: "image/jpeg" as const }));
      this.result = await requestDrawingReview(images, this.note, this.busy.signal);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      clearInterval(tick);
      this.busy = null;
      this.render();
    }
  }

  private render() {
    this.renderThumbs();
    this.renderPanel();
    this.draw();
  }

  private renderThumbs() {
    this.thumbs.innerHTML = "";
    this.imgs.forEach((im, i) => {
      const t = h("button", { title: im.name }, "rv-thumb" + (i === this.sel ? " on" : ""));
      const c = h("canvas", { width: 96, height: 64 });
      const ctx = c.getContext("2d")!;
      const k = Math.min(96 / im.canvas.width, 64 / im.canvas.height);
      ctx.drawImage(im.canvas, (96 - im.canvas.width * k) / 2, (64 - im.canvas.height * k) / 2, im.canvas.width * k, im.canvas.height * k);
      const del = h("span", { textContent: "×", title: "빼기" }, "rv-del");
      del.onclick = (e) => {
        e.stopPropagation();
        this.imgs.splice(i, 1);
        this.result = null;
        this.sel = Math.max(0, Math.min(this.sel, this.imgs.length - 1));
        this.render();
      };
      t.append(c, h("span", { textContent: `그림 ${i + 1}` }, "rv-num"), del);
      t.onclick = () => {
        this.sel = i;
        this.focus = null;
        this.render();
      };
      this.thumbs.append(t);
    });
    if (!this.imgs.length) this.thumbs.append(h("div", { textContent: "그림을 이 창에 끌어다 놓거나 ‘그림 추가…’를 누르세요. (최대 6장 — 한 조립품의 여러 부품, 같은 부품의 여러 버전도 함께)" }, "muted small rv-empty"));
  }

  private renderPanel() {
    const p = this.panel;
    p.innerHTML = "";
    const sec = (title: string, body: Node[]) => h("div", {}, "imp-sec", [h("div", { textContent: title }, "imp-title"), ...body]);
    if (!getApiKey()) {
      const b = h("button", { textContent: "⚙ API 키 설정" }, "primary");
      b.onclick = () => this.hooks.openSettings();
      p.append(
        sec("AI 키가 필요해요", [
          h("p", { textContent: "손글씨 치수와 메모를 읽고 의미를 이해하는 것은 영상 처리만으로는 할 수 없어서 AI(Claude)를 씁니다. Anthropic API 키를 넣으면 쓸 수 있어요. 키는 이 브라우저에만 저장됩니다." }, "small"),
          b,
        ]),
      );
    }
    const note = h("textarea", { rows: 3, value: this.note, placeholder: "부품 설명이나 궁금한 점 (선택) 예: 고체 로켓 연소실과 마개, O-링으로 밀봉" });
    note.oninput = () => (this.note = note.value);
    const go = h("button", { textContent: this.busy ? "읽는 중…" : `✦ AI로 읽고 검토 (${this.imgs.length}장)` }, "primary imp-go");
    go.disabled = !this.imgs.length || !!this.busy || !getApiKey();
    go.onclick = () => this.run();
    const body: Node[] = [note, go];
    if (this.busy) {
      const sec2 = Math.round((Date.now() - this.started) / 1000);
      const cancel = h("button", { textContent: "취소" });
      cancel.onclick = () => this.busy?.abort();
      body.push(h("div", {}, "imp-row", [h("span", { textContent: `손글씨와 치수를 읽고 계산하는 중… ${sec2}초 (보통 1~3분)` }, "muted small"), cancel]));
    }
    if (this.error) body.push(h("p", { textContent: this.error }, "warn small"));
    p.append(sec("검토", body));
    const r = this.result;
    if (!r) return;

    // 총평과 문제 목록
    const counts = (["error", "warning", "info"] as const).map((s) => [s, r.findings.filter((f) => f.severity === s).length] as const);
    p.append(
      sec("총평", [
        h("p", { textContent: r.overall }, "small"),
        h("div", {}, "imp-row", counts.map(([s, n]) => h("span", { textContent: `${SEV[s].label} ${n}` }, `rv-chip rv-${s}`))),
      ]),
    );
    const list = h("div", {}, "rv-list");
    const order = r.findings.map((f, i) => ({ f, i })).sort((a, b) => ["error", "warning", "info"].indexOf(a.f.severity) - ["error", "warning", "info"].indexOf(b.f.severity));
    for (const { f, i } of order) {
      const item = h("div", {}, "rv-item" + (this.focus === i ? " on" : ""), [
        h("div", {}, "rv-item-head", [
          h("span", { textContent: SEV[f.severity].label }, `rv-chip rv-${f.severity}`),
          h("b", { textContent: f.title }),
        ]),
        h("div", { textContent: `${f.category}${f.images.length ? " · " + f.images.map((x) => `그림 ${x + 1}`).join(", ") : ""}` }, "muted small"),
        h("p", { textContent: f.detail }, "small"),
        h("p", { textContent: `→ ${f.suggestion}` }, "small rv-fix"),
      ]);
      item.onclick = () => {
        this.focus = i;
        if (f.images.length) this.sel = f.images[0];
        this.render();
      };
      list.append(item);
    }
    p.append(sec(`문제와 확인할 점 (${r.findings.length})`, [list]));
    if (r.questions.length) p.append(sec("설계자에게 묻는 것", [h("ol", {}, "rv-q", r.questions.map((q) => h("li", { textContent: q }, "small")))]));

    // 그림별로 읽은 것
    for (const d of r.drawings) {
      const dims = h("details", {}, "rv-dims", [
        h("summary", { textContent: `읽은 치수 ${d.dimensions.length}개 · 주기 ${d.notes.length}개` }),
        ...d.dimensions.map((x) => h("div", { textContent: `${x.text} — ${x.meaning}` }, "small")),
        ...d.notes.map((n) => h("div", { textContent: `· ${n}` }, "small muted")),
      ]);
      const body2: Node[] = [
        h("div", { textContent: `${KIND[d.kind] ?? d.kind} · ${PROJ[d.projection] ?? d.projection} · 뷰 ${d.views.map((v) => v.label).join(", ") || "—"}` }, "muted small"),
        h("p", { textContent: d.understanding }, "small"),
        dims,
      ];
      const draft = draftToProject(d);
      if (draft) {
        const b = h("button", { textContent: "이 그림으로 3D 초안 만들기", title: d.draft?.caveats ?? "" });
        b.onclick = () => {
          this.close();
          this.hooks.onDraft(draft);
        };
        body2.push(b);
        if (d.draft?.caveats) body2.push(h("p", { textContent: `초안 주의: ${d.draft.caveats}` }, "muted small"));
      }
      const title = h("div", {}, "imp-title rv-dtitle", [`그림 ${d.image + 1} · ${d.title}`]);
      title.onclick = () => {
        this.sel = d.image;
        this.focus = null;
        this.render();
      };
      p.append(h("div", {}, "imp-sec", [title, ...body2]));
    }
    p.append(h("p", { textContent: `AI 모델: ${r.model}. AI는 틀릴 수 있으니 중요한 치수는 직접 확인하세요.` }, "muted small rv-foot"));
  }

  private layout() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const top = this.thumbs.getBoundingClientRect().height;
    return { w: r.width, h: r.height - top, top };
  }

  private fit(im: Img) {
    const { w, h: hh } = this.layout();
    const k = Math.min(w / im.canvas.width, hh / im.canvas.height) * 0.96;
    return { k, x: (w - im.canvas.width * k) / 2, y: (hh - im.canvas.height * k) / 2 };
  }

  private boxesFor(i: number): { box: Box; color: string; label: string; idx: number | null }[] {
    const r = this.result;
    if (!r) return [];
    const out: { box: Box; color: string; label: string; idx: number | null }[] = [];
    r.findings.forEach((f, k) => {
      if (f.box && f.images[0] === i) out.push({ box: f.box, color: SEV[f.severity].color, label: `${k + 1}. ${f.title}`, idx: k });
    });
    return out;
  }

  draw() {
    const c = this.canvas;
    const { w, h: hh } = this.layout();
    const dpr = window.devicePixelRatio || 1;
    c.style.width = `${w}px`;
    c.style.height = `${hh}px`;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(hh * dpr));
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const im = this.imgs[this.sel];
    if (!im) return;
    const { k, x, y } = this.fit(im);
    ctx.drawImage(im.canvas, x, y, im.canvas.width * k, im.canvas.height * k);
    const W = im.canvas.width * k;
    const H = im.canvas.height * k;
    // 읽은 뷰 (옅게)
    const d = this.result?.drawings.find((dd) => dd.image === this.sel);
    if (d)
      for (const v of d.views) {
        if (!v.box.w) continue;
        ctx.strokeStyle = "rgba(37,99,235,.55)";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + v.box.x * W, y + v.box.y * H, v.box.w * W, v.box.h * H);
        ctx.setLineDash([]);
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.fillStyle = "rgba(37,99,235,.9)";
        ctx.fillText(v.label, x + v.box.x * W + 4, y + v.box.y * H + 14);
      }
    // 문제 위치
    for (const b of this.boxesFor(this.sel)) {
      const on = this.focus === b.idx;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = on ? 3.5 : 2;
      ctx.globalAlpha = this.focus === null || on ? 1 : 0.35;
      const bx = x + b.box.x * W;
      const by = y + b.box.y * H;
      ctx.strokeRect(bx, by, b.box.w * W, b.box.h * H);
      ctx.font = "700 12px system-ui, sans-serif";
      const label = String((b.idx ?? 0) + 1);
      ctx.fillStyle = b.color;
      ctx.fillRect(bx - 1, by - 18, ctx.measureText(label).width + 10, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, bx + 4, by - 5);
      ctx.globalAlpha = 1;
    }
  }

  private clickCanvas(e: MouseEvent) {
    const im = this.imgs[this.sel];
    if (!im || !this.result) return;
    const r = this.canvas.getBoundingClientRect();
    const { k, x, y } = this.fit(im);
    const px = (e.clientX - r.left - x) / (im.canvas.width * k);
    const py = (e.clientY - r.top - y) / (im.canvas.height * k);
    const hit = this.boxesFor(this.sel)
      .filter((b) => px >= b.box.x && px <= b.box.x + b.box.w && py >= b.box.y && py <= b.box.y + b.box.h)
      .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
    this.focus = hit ? hit.idx : null;
    this.renderPanel();
    this.draw();
    if (hit) this.panel.querySelector(".rv-item.on")?.scrollIntoView({ block: "nearest" });
  }
}
