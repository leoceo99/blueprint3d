/**
 * 예제 작업 공간 — 새 작업 공간 모듈을 만드는 법을 보여 주는 가장 작은 예.
 * 설정 ▸ 개발자 ▸ ‘예제 작업 공간 보이기’를 켜면 붙고, 끄면 떨어진다 (탭·숫자 단축키·명령 모두).
 * 앞으로 메쉬 편집·조립·렌더 같은 작업 공간이 이 모양으로 붙는다.
 */
import type { Command } from "../app/commands";
import { commands } from "../app/context";
import { esc } from "../app/dom";
import { toast } from "../app/notify";
import { workspaces, type Workspace } from "./registry";

let root: HTMLElement | null = null;

function render() {
  if (!root) return;
  const ws = workspaces();
  const mine = commands.list().filter((c) => c.id.startsWith("example."));
  root.innerHTML = `
    <div class="ex-card">
      <h2>예제 작업 공간</h2>
      <p>작업 공간은 <code>Workspace</code> 하나(이름·기호·순서·보이기·숨기기·명령)를 <code>registerWorkspace</code>로 붙이면 됩니다.
      위쪽 탭, 숫자 단축키, 명령 찾기(<kbd>Ctrl</kbd>+<kbd>K</kbd>)에 자동으로 들어가요.</p>
      <p class="muted">파일: <code>src/workspaces/example.ts</code> · 지금 붙어 있는 작업 공간: ${ws.map((w, i) => `${i + 1}. ${esc(w.title)}`).join(" · ")}</p>
      <p>이 작업 공간의 명령: ${mine.map((c) => `<code>${esc(c.title)}</code>`).join(", ")}</p>
      <button data-ex-say class="primary">예제 명령 실행</button>
    </div>`;
  root.querySelector<HTMLButtonElement>("[data-ex-say]")!.onclick = () => commands.run("example.hello");
}

const cmds: Command[] = [{ id: "example.hello", title: "예제: 인사하기", category: "예제 작업 공간", keywords: ["example", "hello"], run: () => toast("예제 작업 공간의 명령이 실행됐어요.") }];

export const exampleWorkspace: Workspace = {
  id: "example",
  title: "예제",
  icon: "◇",
  order: 900,
  hint: "새 작업 공간 모듈을 만드는 법 (개발자용)",
  show() {
    if (!root) {
      root = document.createElement("main");
      root.className = "workspace example-ws";
      document.querySelector("footer.statusbar")!.before(root);
    }
    root.hidden = false;
    render();
  },
  hide() {
    if (root) root.hidden = true;
  },
  commands: cmds,
};
