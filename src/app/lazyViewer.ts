/**
 * 3D 보기 (three.js)를 나중에 내려받는다 — 10단계 다듬기.
 * 첫 화면(2D 설계)에는 three.js가 필요 없으므로, 3D 화면을 열거나 썸네일·AI 검토 그림이 필요할 때 불러온다.
 * 불러오기 전에 받은 메시·테마·켜짐 상태는 기억해 두었다가 그대로 넘긴다.
 */
import type { MeshData } from "../core/types";
import type { Viewer3D } from "../ui/viewer";

export class LazyViewer {
  private real: Viewer3D | null = null;
  private loading: Promise<Viewer3D> | null = null;
  private mesh: MeshData | null = null;
  private dark = false;
  private active = false;

  constructor(private host: HTMLElement) {}

  /** 진짜 3D 보기 (처음이면 내려받아 만든다) */
  ready(): Promise<Viewer3D> {
    return (this.loading ??= import("../ui/viewer").then(({ Viewer3D }) => {
      const v = new Viewer3D(this.host);
      v.setDark(this.dark);
      v.setMesh(this.mesh);
      if (this.active) v.setActive(true);
      this.real = v;
      return v;
    }));
  }

  get loaded() {
    return !!this.real;
  }

  setMesh(m: MeshData | null) {
    this.mesh = m;
    this.real?.setMesh(m);
  }

  setDark(dark: boolean) {
    this.dark = dark;
    this.real?.setDark(dark);
  }

  setActive(a: boolean) {
    this.active = a;
    if (this.real) this.real.setActive(a);
    else if (a) void this.ready();
  }

  resetView(dir?: [number, number, number]) {
    void this.ready().then((v) => v.resetView(dir));
  }

  /** 등각 시점 그림 (data URL) — 썸네일용 */
  async snapshot(w: number, h: number, type?: string, quality?: number, bg?: string): Promise<string | null> {
    if (!this.mesh) return null;
    return (await this.ready()).snapshot(w, h, type, quality, bg);
  }

  /** AI 검토용 PNG (base64) */
  async capture(): Promise<string | null> {
    if (!this.mesh) return null;
    return (await this.ready()).capture();
  }
}
