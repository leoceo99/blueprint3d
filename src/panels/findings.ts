/** 오른쪽 패널: 설계 검사 (규칙 검사 + AI 검토 결과), AI 설계 검토 실행 */
import { getApiKey } from "../aiKey";
import { boundsOf } from "../core/geometry2d";
import { runChecks } from "../core/checks";
import { buildSheet } from "../core/sheet";
import type { Finding } from "../core/types";
import { store } from "../store";
import { ui } from "../ui/state";
import { waitForBuild } from "../app/build";
import { app, commands, invalidatePanels, on, onPanels, requestRender } from "../app/context";
import { $, esc } from "../app/dom";
import { toast } from "../app/notify";
import { showWorkspace } from "../workspaces/registry";
import { activeSheetInfo } from "../workspaces/sheet";

export function initFindings() {
  onPanels(renderFindings);
  on("built", updateFindings);
}

/** 규칙 검사를 다시 돌리고 AI 결과와 합친다 */
export function updateFindings() {
  app.ruleFindings = runChecks(store.project, app.lastBuild, app.buildError);
  const ai = app.ai;
  const aiList = ai && !ai.loading ? ai.findings.filter((f) => refsStillValid(f)) : [];
  const order = { error: 0, warning: 1, info: 2 };
  ui.findings = [...app.ruleFindings, ...aiList].sort((a, b) => order[a.severity] - order[b.severity]);
}

function refsStillValid(f: Finding) {
  return f.refs.every((r) => !r.shapeId || store.project.views[r.view].some((s) => s.id === r.shapeId));
}

function renderFindings() {
  const list = $("#findings");
  list.innerHTML = "";
  const n = { error: 0, warning: 0, info: 0 };
  ui.findings.forEach((f) => n[f.severity]++);
  $("#checkCounts").innerHTML =
    `<span><i class="sev error">!</i>${n.error}</span><span><i class="sev warning">!</i>${n.warning}</span><span><i class="sev info">i</i>${n.info}</span>`;

  const sum = $("#aiSummary");
  const ai = app.ai;
  if (ai) {
    sum.hidden = false;
    if (ai.loading) sum.innerHTML = `<div class="loading"><div class="spinner"></div>AI가 도면을 검토하고 있어요… (보통 20초~1분)</div>`;
    else if (ai.error) sum.innerHTML = `<b>AI 검토 실패</b><br/>${esc(ai.error)}`;
    else
      sum.innerHTML =
        `<b>✦ AI 총평</b> ${esc(ai.summary)}` +
        (ai.version !== store.version ? `<br/><span class="stale">도면이 바뀌었어요. 다시 검토하면 최신 결과를 볼 수 있습니다.</span>` : "");
  } else sum.hidden = true;

  if (!ui.findings.length) {
    list.innerHTML = `<div class="all-good">✓ 규칙 검사에서 문제가 없습니다.${ai || document.body.classList.contains("no-exp") ? "" : " 더 깊은 검토는 ‘AI 설계 검토’를 눌러 보세요."}</div>`;
    return;
  }
  for (const f of ui.findings) {
    const el = document.createElement("div");
    el.className = `finding ${f.severity}`;
    el.innerHTML =
      `<div class="f-head"><i class="sev ${f.severity}">${f.severity === "info" ? "i" : "!"}</i><span>${esc(f.title)}</span></div>` +
      `<div class="f-tags"><span class="tag ${f.source === "ai" ? "ai" : ""}">${f.source === "ai" ? "✦ AI" : "규칙"}</span><span class="tag">${esc(f.category)}</span></div>` +
      `<div class="f-detail">${esc(f.detail)}</div>` +
      (f.suggestion ? `<div class="f-fix"><b>고치는 법</b> · ${esc(f.suggestion)}</div>` : "");
    el.onmouseenter = () => {
      ui.hoverFindingId = f.id;
      ui.emit();
    };
    el.onmouseleave = () => {
      ui.hoverFindingId = null;
      ui.emit();
    };
    el.onclick = () => focusFinding(f);
    list.appendChild(el);
  }
}

export function focusFinding(f: Finding) {
  const r = f.refs.find((x) => x.shapeId) ?? f.refs[0];
  if (!r) return;
  ui.activeView = r.view;
  if (r.shapeId) ui.sel = { view: r.view, id: r.shapeId };
  let u = r.u;
  let v = r.v;
  if ((u === undefined || v === undefined) && r.shapeId) {
    const s = store.project.views[r.view].find((x) => x.id === r.shapeId);
    if (s) {
      const b = boundsOf([{ ...s, hole: false }])!;
      u = (b[0] + b[2]) / 2;
      v = (b[1] + b[3]) / 2;
    }
  }
  if (u !== undefined && v !== undefined) ui.flash = { view: r.view, u, v, until: performance.now() + 1800 };
  ui.emit();
}

// ---------------- AI 설계 검토 (실험) ----------------
let aiAbort: AbortController | null = null;
export const aiBusy = () => !!app.ai?.loading;

/** 검토 시작 (이미 돌고 있으면 멈춤) */
export async function toggleAiReview() {
  if (!getApiKey()) {
    toast("먼저 Anthropic API 키를 입력하세요.");
    commands.run("app.settings");
    return;
  }
  if (app.ai?.loading) {
    aiAbort?.abort();
    return;
  }
  showWorkspace("design");
  aiAbort = new AbortController();
  const version = store.version;
  app.ai = { summary: "", findings: [], version, loading: true };
  $("#aiBtn").textContent = "■ 검토 중지";
  updateFindings();
  requestRender();
  try {
    await waitForBuild();
    const sheet = app.lastBuild ? buildSheet(app.lastBuild, { ...store.project, sheet: activeSheetInfo() }) : null;
    const [imageSheet, image3d] = await Promise.all([sheet ? svgToPng(sheet.svg) : null, app.viewer.capture()]);
    // AI SDK는 처음 검토할 때 내려받는다
    const { requestReview } = await import("../ai");
    const res = await requestReview(
      { project: store.project, build: app.lastBuild, ruleFindings: app.ruleFindings, imageSheet: imageSheet ?? undefined, image3d: image3d ?? undefined },
      aiAbort.signal,
    );
    app.ai = { summary: res.summary, findings: res.findings, version, loading: false };
    toast(`AI 검토 완료: ${res.findings.length}건`);
  } catch (e: any) {
    app.ai = { summary: "", findings: [], version, loading: false, error: e?.message ?? String(e) };
  } finally {
    aiAbort = null;
    $("#aiBtn").textContent = "✦ AI 설계 검토";
    updateFindings();
    invalidatePanels();
  }
}

async function svgToPng(svg: string): Promise<string | null> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const w = 1400;
    const h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 1000;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/png").split(",")[1];
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
