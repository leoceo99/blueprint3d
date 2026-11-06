/**
 * ‘내 프로젝트’ 창(보관함·휴지통·백업)과 ‘버전 기록’ 창.
 */
import { diffSummary, relativeTime, TRASH_DAYS } from "../core/versions";
import type { Project } from "../core/types";
import {
  addVersion,
  deleteVersion,
  duplicateProject,
  exportAll,
  importAll,
  listProjects,
  listVersions,
  parseProject,
  purgeProject,
  renameProject,
  renameVersion,
  restoreProject,
  trashProject,
  type ProjectRec,
  type VersionRec,
} from "../library";
import { h, Modal } from "./modal";

const placeholder = () => h("div", { textContent: "◧" }, "lib-noimg");

export interface LibraryHooks {
  currentId: () => string;
  open: (id: string) => Promise<void>;
  newProject: () => void;
  /** 저장 대기 중인 변경을 보관함에 먼저 쓴다 */
  flush: () => Promise<void>;
  toast: (msg: string) => void;
  download: (name: string, text: string) => void;
  pickText: () => Promise<string | null>;
  showVersions: (id: string) => void;
  renameCurrent: (name: string) => void;
}

export class ProjectsDialog {
  private m = new Modal("내 프로젝트", true);
  private tab: "list" | "trash" = "list";
  private query = "";
  constructor(private hooks: LibraryHooks) {}

  get isOpen() {
    return this.m.isOpen;
  }

  async open() {
    await this.hooks.flush();
    this.tab = "list";
    this.m.show();
    await this.render();
  }

  close() {
    this.m.close();
  }

  private async render() {
    const all = await listProjects();
    const live = all.filter((p) => !p.deletedAt);
    const trash = all.filter((p) => p.deletedAt);
    const b = this.m.body;
    b.innerHTML = "";
    const search = h("input", { type: "search", placeholder: "이름으로 찾기", value: this.query });
    search.oninput = () => {
      this.query = search.value;
      void this.renderGrid(live, trash);
    };
    const nw = h("button", { textContent: "＋ 새 부품" }, "primary");
    nw.onclick = () => {
      this.close();
      this.hooks.newProject();
    };
    const tabList = h("button", { textContent: `프로젝트 ${live.length}` }, "seg-btn" + (this.tab === "list" ? " on" : ""));
    tabList.onclick = () => ((this.tab = "list"), this.render());
    const tabTrash = h("button", { textContent: `휴지통 ${trash.length}` }, "seg-btn" + (this.tab === "trash" ? " on" : ""));
    tabTrash.onclick = () => ((this.tab = "trash"), this.render());
    const exp = h("button", { textContent: "전체 백업 내보내기", title: "모든 프로젝트·버전·3D 파일·밑그림을 한 파일로" });
    exp.onclick = async () => {
      await this.hooks.flush();
      const data = await exportAll();
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      this.hooks.download(`도면3D_백업_${stamp}.json`, JSON.stringify(data));
      this.hooks.toast(`프로젝트 ${data.projects.length}개, 버전 ${data.versions.length}개를 백업했어요.`);
    };
    const imp = h("button", { textContent: "백업 가져오기" });
    imp.onclick = async () => {
      const text = await this.hooks.pickText();
      if (!text) return;
      try {
        const r = await importAll(JSON.parse(text));
        this.hooks.toast(`백업에서 프로젝트 ${r.projects}개, 버전 ${r.versions}개를 가져왔어요.`);
        await this.render();
      } catch (e) {
        this.hooks.toast((e as Error).message || "백업 파일을 읽을 수 없습니다.");
      }
    };
    b.append(h("div", {}, "lib-bar", [h("div", {}, "seg", [tabList, tabTrash]), search, h("div", {}, "spacer"), exp, imp, nw]));
    b.append(h("div", {}, "lib-grid"));
    await this.renderGrid(live, trash);
    this.m.refocus();
  }

  private async renderGrid(live: ProjectRec[], trash: ProjectRec[]) {
    const grid = this.m.body.querySelector(".lib-grid") as HTMLDivElement;
    grid.innerHTML = "";
    const q = this.query.trim().toLowerCase();
    const list = (this.tab === "list" ? live : trash).filter((p) => !q || p.name.toLowerCase().includes(q));
    const now = Date.now();
    if (!list.length) {
      grid.append(h("p", { textContent: this.tab === "trash" ? "휴지통이 비어 있어요." : q ? "찾는 이름이 없어요." : "프로젝트가 없어요." }, "muted"));
      return;
    }
    for (const p of list) {
      const cur = p.id === this.hooks.currentId();
      const img = p.thumb ? h("img", { src: p.thumb, alt: "" }) : placeholder();
      const card = h("div", {}, "lib-card" + (cur ? " cur" : ""), [
        h("div", {}, "lib-thumb", [img]),
        h("div", {}, "lib-info", [
          h("b", { textContent: p.name, title: p.name }),
          h("span", { textContent: p.summary }, "muted small"),
          h("span", {
            textContent: this.tab === "trash" ? `${relativeTime(p.deletedAt!, now)} 삭제 · ${TRASH_DAYS}일 뒤 영구 삭제` : `${relativeTime(p.updatedAt, now)} 수정${cur ? " · 지금 열림" : ""}`,
          }, "muted small"),
        ]),
      ]);
      const actions = h("div", {}, "lib-actions");
      const btn = (t: string, fn: () => void, cls = "") => {
        const x = h("button", { textContent: t }, cls);
        x.onclick = (e) => {
          e.stopPropagation();
          fn();
        };
        actions.append(x);
      };
      if (this.tab === "list") {
        card.onclick = async () => {
          this.close();
          if (!cur) await this.hooks.open(p.id);
        };
        btn("복제", async () => {
          await this.hooks.flush();
          await duplicateProject(p.id);
          await this.render();
        });
        btn("이름", async () => {
          const name = prompt("새 이름", p.name)?.trim();
          if (!name) return;
          // 지금 열린 것은 보통 편집처럼 (실행 취소 가능), 아니면 보관함에서 바로
          if (cur) this.hooks.renameCurrent(name);
          else await renameProject(p.id, name);
          await this.hooks.flush();
          await this.render();
        });
        btn("버전", () => {
          this.close();
          this.hooks.showVersions(p.id);
        });
        if (!cur)
          btn("삭제", async () => {
            await trashProject(p.id);
            this.hooks.toast(`‘${p.name}’을(를) 휴지통에 넣었어요. ${TRASH_DAYS}일 안에 되살릴 수 있어요.`);
            await this.render();
          }, "danger");
      } else {
        btn("되살리기", async () => {
          await restoreProject(p.id);
          await this.render();
        }, "primary");
        btn("영구 삭제", async () => {
          if (!confirm(`‘${p.name}’과 버전 기록을 영구 삭제할까요? 되돌릴 수 없어요.`)) return;
          await purgeProject(p.id);
          await this.render();
        }, "danger");
      }
      card.append(actions);
      grid.append(card);
    }
  }
}

export interface VersionHooks {
  currentId: () => string;
  current: () => Project;
  /** 지금 프로젝트를 이 내용으로 되돌린다 (실행 취소 가능하게) */
  restore: (p: Project) => void;
  openAsNew: (p: Project) => void;
  open: (id: string) => Promise<void>;
  flush: () => Promise<void>;
  thumb: () => string | undefined;
  toast: (msg: string) => void;
}

export class VersionsDialog {
  private m = new Modal("버전 기록", true);
  private projectId = "";
  constructor(private hooks: VersionHooks) {}

  get isOpen() {
    return this.m.isOpen;
  }

  async open(projectId = this.hooks.currentId()) {
    await this.hooks.flush();
    // 다른 프로젝트의 기록이면 그 프로젝트를 연다
    if (projectId !== this.hooks.currentId()) await this.hooks.open(projectId);
    this.projectId = projectId;
    this.m.show();
    await this.render();
  }

  close() {
    this.m.close();
  }

  /** 지금 상태를 버전으로 저장 */
  async saveNow(label?: string) {
    await this.hooks.flush();
    const name = label ?? prompt("버전 이름 (예: 구멍 위치 바꾸기 전)", "")?.trim();
    if (name === undefined || name === null) return;
    await addVersion(this.hooks.currentId(), this.hooks.current(), { auto: false, label: name || "버전", thumb: this.hooks.thumb() });
    this.hooks.toast(`버전 ‘${name || "버전"}’을(를) 저장했어요.`);
    if (this.isOpen) await this.render();
  }

  private async render() {
    const b = this.m.body;
    const cur = this.hooks.current();
    this.m.setTitle(`버전 기록 — ${cur.name}`);
    b.innerHTML = "";
    const save = h("button", { textContent: "지금 상태를 버전으로 저장" }, "primary");
    save.onclick = () => this.saveNow();
    b.append(
      h("div", {}, "lib-bar", [
        h("span", { textContent: "고치는 동안 10분마다 자동으로 남고(최근 50개), 직접 저장한 버전은 지우기 전까지 남아요." }, "muted small"),
        h("div", {}, "spacer"),
        save,
      ]),
    );
    const list = h("div", {}, "ver-list");
    const vs = await listVersions(this.projectId);
    if (!vs.length) list.append(h("p", { textContent: "아직 버전이 없어요." }, "muted"));
    const now = Date.now();
    for (const v of vs) list.append(this.row(v, cur, now));
    b.append(list);
    this.m.refocus();
  }

  private row(v: VersionRec, cur: Project, now: number): HTMLElement {
    const p = parseProject(v.data);
    const diff = p ? diffSummary(p, cur) : "읽을 수 없는 버전";
    const img = v.thumb ? h("img", { src: v.thumb, alt: "" }) : placeholder();
    const actions = h("div", {}, "lib-actions");
    const btn = (t: string, fn: () => void, cls = "") => {
      const x = h("button", { textContent: t }, cls);
      x.onclick = fn;
      actions.append(x);
    };
    if (p) {
      btn("이 버전으로 되돌리기", async () => {
        // 되돌리기 전 상태도 버전으로 남겨 둔다
        await addVersion(this.hooks.currentId(), this.hooks.current(), { auto: true, label: "되돌리기 전", thumb: this.hooks.thumb() });
        this.hooks.restore(p);
        this.close();
        this.hooks.toast(`‘${v.label}’(${relativeTime(v.time, Date.now())})로 되돌렸어요. Ctrl+Z로 다시 돌아갈 수 있어요.`);
      }, "primary");
      btn("새 프로젝트로", () => {
        p.name = `${p.name} (${relativeTime(v.time, Date.now())} 버전)`;
        this.close();
        this.hooks.openAsNew(p);
      });
    }
    btn("이름", async () => {
      const name = prompt("버전 이름", v.label)?.trim();
      if (!name) return;
      await renameVersion(v.id, name);
      await this.render();
    });
    btn("삭제", async () => {
      await deleteVersion(v.id);
      await this.render();
    }, "danger");
    return h("div", {}, "ver-row", [
      h("div", {}, "lib-thumb small", [img]),
      h("div", {}, "lib-info", [
        h("div", {}, "", [h("b", { textContent: v.label }), h("span", { textContent: v.auto ? " 자동" : " 직접 저장" }, "ver-tag" + (v.auto ? "" : " manual"))]),
        h("span", { textContent: `${relativeTime(v.time, now)} · ${v.summary}` }, "muted small"),
        h("span", { textContent: `지금과 비교: ${diff}` }, "small"),
      ]),
      actions,
    ]);
  }
}
