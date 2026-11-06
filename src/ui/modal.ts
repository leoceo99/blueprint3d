/**
 * 가운데 뜨는 창 틀 (내 프로젝트, 버전 기록, 실행 취소 기록, 명령 찾기 등이 같이 쓴다)
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, cls?: string, kids: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

/** 가운데 뜨는 창 틀 */
export class Modal {
  private static all = new Set<Modal>();
  /** 어떤 창이든 열려 있으면 (단축키를 막을 때) */
  static anyOpen() {
    for (const m of Modal.all) if (m.isOpen) return true;
    return false;
  }
  root: HTMLDivElement;
  body: HTMLDivElement;
  head: HTMLDivElement;
  onClose: (() => void) | null = null;
  constructor(title: string, wide = false) {
    Modal.all.add(this);
    this.head = h("div", {}, "md-head", [h("b", { textContent: title }, "md-title")]);
    this.body = h("div", {}, "md-body");
    const close = h("button", { textContent: "닫기", title: "Esc" });
    close.onclick = () => this.close();
    this.head.append(h("div", {}, "spacer"), close);
    this.root = h("div", { hidden: true, tabIndex: -1 }, "md-back", [h("div", {}, "md-card" + (wide ? " wide" : ""), [this.head, this.body])]);
    this.root.addEventListener("mousedown", (e) => e.target === this.root && this.close());
    // 창 안의 내용을 다시 그리면 초점이 페이지로 빠질 수 있어서, Esc는 창 전체에서 받는다
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && this.isOpen) {
          e.stopPropagation();
          e.preventDefault();
          this.close();
        }
      },
      true,
    );
    document.body.appendChild(this.root);
  }
  /** 다시 그린 뒤 초점이 창 밖으로 빠졌으면 창으로 */
  refocus() {
    if (this.isOpen && !this.root.contains(document.activeElement)) this.root.focus();
  }
  get isOpen() {
    return !this.root.hidden;
  }
  show() {
    this.root.hidden = false;
    this.root.focus();
  }
  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.onClose?.();
  }
  setTitle(t: string) {
    (this.head.querySelector(".md-title") as HTMLElement).textContent = t;
  }
}

