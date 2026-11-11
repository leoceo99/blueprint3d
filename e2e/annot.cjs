// 14.4·14.5: 치수 공차(끼워맞춤 H7 → 허용차 계산), 표면 거칠기·기하공차·데이텀 기호 놓기·고치기, 실행 취소
const { out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // 저장 위치 고르기 창 대신 내려받기로 (헤드리스에서는 창이 닫히지 않음)
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const run = (id) => B((i) => window.blueprint3d.commands.run(i), id);
  const edits = () => B(() => { const s = window.blueprint3d.store; const d = s.doc.drawings.find((x) => x.id === s.doc.view.drawing); return JSON.parse(JSON.stringify(d?.edits ?? {})); });
  const texts = () => B(() => (window.blueprint3d.app.lastSheet?.dims ?? []).map((d) => d.text));
  const scr = (p) => B(([x, y]) => {
    const svg = document.querySelector('#sheetHost svg');
    const H = svg.viewBox.baseVal.height;
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = H - y;
    const q = pt.matrixTransform(svg.getScreenCTM());
    return [q.x, q.y];
  }, p);
  const clickPaper = async (p) => { const [x, y] = await scr(p); await page.mouse.click(x, y); };
  const waitSheet = async (pred, arg) => { await page.waitForFunction(pred, arg, { timeout: 30000 }); await page.waitForTimeout(300); };
  const blur = () => B(() => document.activeElement && document.activeElement.blur());
  /** 정면도의 긴 가로 외형선 가운데 (기호를 붙일 면) */
  const edgeMid = () => B(() => {
    const sh = window.blueprint3d.app.lastSheet;
    const b = sh.views.front.box;
    const ls = sh.prims.filter((p) => p.layer === 'VISIBLE' && p.t === 'line' && Math.abs(p.a[1] - p.b[1]) < 1e-6 && p.a[0] >= b[0] - 0.1 && p.b[0] <= b[2] + 0.1 && p.a[1] >= b[1] - 0.1 && p.a[1] <= b[3] + 0.1);
    ls.sort((p, q) => Math.abs(q.b[0] - q.a[0]) - Math.abs(p.b[0] - p.a[0]) || q.a[1] - p.a[1]);
    const l = ls[0];
    return [(l.a[0] + l.b[0]) / 2, l.a[1]];
  });
  try {
    await fresh(page);
    await waitBuild(page);
    await run('sample.2');
    await waitBuild(page);
    await page.keyboard.press('3');
    await waitSheet(() => document.querySelectorAll('#sheetHost svg g.dim').length > 2);

    // ---- 공차: 자동 길이 치수(50) 고르기 → 끼워맞춤 (길이는 축 h7부터) → H7 ----
    const dia = await B(() => {
      const d = window.blueprint3d.app.lastSheet.dims.find((x) => x.def.kind === 'linear' && x.text === '50');
      return d && { id: d.id, box: d.box, text: d.text };
    });
    await clickPaper([(dia.box[0] + dia.box[2]) / 2, (dia.box[1] + dia.box[3]) / 2]);
    await page.waitForSelector('#dimPropsWrap:not([hidden]) [data-tk]', { timeout: 10000 });
    ok('치수를 누르면 ‘고른 치수’ 칸 (공차 고르기)', true, dia.text);
    await page.selectOption('#dimProps [data-tk]', 'fit');
    await waitSheet((id) => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.id === id && d.text === '50 h7 (0/−0.025)'), dia.id);
    let e = await edits();
    ok('끼워맞춤 h7 → 50 h7 (0/−0.025) (ISO 286, 30~50 mm IT7 = 25 µm)', e.moved?.[dia.id]?.tol?.code === 'h7');
    await page.fill('#dimProps [data-tv="code"]', 'H7');
    await page.press('#dimProps [data-tv="code"]', 'Enter');
    await waitSheet((id) => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.id === id && d.text === '50 H7 (+0.025/0)'), dia.id);
    ok('기호 바꾸기 h7 → H7', (await edits()).moved?.[dia.id]?.tol?.code === 'H7');
    await page.waitForSelector('#dimProps .fit-dev');
    const fd = await page.textContent('#dimProps .fit-dev');
    ok('칸에 계산한 허용차 표시', /H7 → \+0\.025 \/ 0/.test(fd), fd);
    await page.selectOption('#dimProps [data-tk]', 'sym');
    await waitSheet((id) => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.id === id && d.text === '50 ±0.1'), dia.id);
    ok('± 공차', (await edits()).moved?.[dia.id]?.tol?.kind === 'sym');

    // ---- 표면 거칠기 ----
    await blur();
    await page.keyboard.press('r');
    await page.waitForTimeout(800);
    const m = await edgeMid();
    await clickPaper(m);
    await clickPaper([m[0] + 6, m[1] + 6]);
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.text === 'Ra 3.2'));
    e = await edits();
    const rough = (e.dims ?? []).find((d) => d.kind === 'rough');
    ok('거칠기 도구: 면 → 자리 → √ Ra 3.2 (제거 가공)', rough && rough.ra === '3.2' && rough.mode === 'remove', JSON.stringify(rough));
    await page.waitForSelector('#dimProps [data-f="ra"]');
    await page.selectOption('#dimProps [data-f="ra"]', '1.6');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.text === 'Ra 1.6'));
    ok('고른 거칠기 값 바꾸기 → 1.6', (await edits()).dims.find((d) => d.kind === 'rough').ra === '1.6');

    // ---- 데이텀 ----
    await blur();
    await page.keyboard.press('a');
    await page.waitForTimeout(800);
    await clickPaper(m);
    await clickPaper([m[0] - 10, m[1] + 10]);
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.def.kind === 'datum'));
    ok('데이텀 A', (await edits()).dims.some((d) => d.kind === 'datum' && d.label === 'A'));

    // ---- 기하공차: 놓기 전에 값 정하기 (직각도, 데이텀 A) ----
    await blur();
    await page.keyboard.press('g');
    await page.waitForSelector('#dimPropsWrap:not([hidden]) [data-f="sym"]');
    await page.selectOption('#dimProps [data-f="sym"]', 'perp');
    await page.fill('#dimProps [data-f="value"]', '0.02');
    await page.press('#dimProps [data-f="value"]', 'Enter');
    await page.fill('#dimProps [data-f="datums"]', 'a');
    await page.press('#dimProps [data-f="datums"]', 'Enter');
    await blur();
    const fb = await B(() => window.blueprint3d.app.lastSheet.views.front.box);
    // 정면도 왼쪽 세로 외형선
    const lv = await B((b) => {
      const sh = window.blueprint3d.app.lastSheet;
      const ls = sh.prims.filter((p) => p.layer === 'VISIBLE' && p.t === 'line' && Math.abs(p.a[0] - p.b[0]) < 1e-6 && Math.abs(p.a[0] - b[0]) < 0.5);
      const l = ls[0];
      return [l.a[0], (l.a[1] + l.b[1]) / 2];
    }, fb);
    await clickPaper(lv);
    await clickPaper([lv[0] - 12, lv[1] + 8]);
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.dims ?? []).some((d) => d.def.kind === 'gdt'));
    const g = (await edits()).dims.find((d) => d.kind === 'gdt');
    ok('기하공차: 직각도 0.02 | A (놓기 전에 고른 값)', g && g.sym === 'perp' && g.value === '0.02' && JSON.stringify(g.datums) === '["A"]', JSON.stringify(g));
    await page.screenshot({ path: out('sheet-annot.png') });

    // ---- 끌어 옮기기 + 실행 취소 ----
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');
    await page.waitForTimeout(800);
    const gb = await B(() => window.blueprint3d.app.lastSheet.dims.find((d) => d.def.kind === 'gdt').box);
    const [gx, gy] = await scr([gb[0] + 2, (gb[1] + gb[3]) / 2]);
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx - 40, gy - 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const g2 = (await edits()).dims.find((d) => d.kind === 'gdt');
    ok('기호 끌어 옮기기 (꺾인 곳)', g2.knee[0] < g.knee[0] - 3, `${JSON.stringify(g.knee)} → ${JSON.stringify(g2.knee)}`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(800);
    ok('실행 취소 두 번 → 기하공차 사라짐', !(await edits()).dims.some((d) => d.kind === 'gdt'));

    // ---- 14.6 표제란 양식 · 도면 번호 · 부품표 · 장 번호 ----
    await page.selectOption('[data-sheet="template"]', 'full');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => t.text === '검도'));
    await page.fill('[data-sheet="dwgNo"]', 'B3D-0001');
    await page.press('[data-sheet="dwgNo"]', 'Tab');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => t.text === 'B3D-0001'));
    ok('상세 양식 + 도면 번호', await page.isVisible('[data-sheet="checkedBy"]'));
    await page.selectOption('[data-sheet="bom"]', 'on');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => t.text === '번호'));
    const tx = await B(() => window.blueprint3d.app.lastSheet.texts.map((t) => t.text));
    // 표제란에도 ‘부품명·재질·수량·무게’가 있으므로 부품표까지 두 번씩
    ok('부품표 (번호·부품명·재질·수량·무게)', tx.includes('번호') && ['부품명', '재질', '수량', '무게'].every((h) => tx.filter((t) => t === h).length >= 2));
    await run('doc.addDrawing');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => t.text === '2 / 2'));
    ok('도면을 하나 더 → 장 번호 2 / 2', true);

    // ---- 14.7 모든 도면 → PDF 한 파일 (2쪽) ----
    await page.click('[data-menu="sheetexp"]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#expPdfAll')]);
    const pdf = require('fs').readFileSync(await dl.path()).toString('latin1');
    const pages = (pdf.match(/\/Type \/Page\b/g) || []).length;
    ok('모든 도면 PDF: 두 쪽 · 한글 글꼴(Adobe-Korea1) · 레이어', pages === 2 && /\/Count 2/.test(pdf) && /HYGoThic-Medium/.test(pdf) && /Korea1/.test(pdf) && /\/OCProperties/.test(pdf), `${dl.suggestedFilename()} ${pdf.length}B pages=${pages}`);
  } catch (err) {
    results.push('FAIL exception — ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
    await page.screenshot({ path: out('annot-error.png') }).catch(() => {});
  }
  finish(results, errs);
  await browser.close();
})();
