// 10단계: 길이 단위 mm ↔ inch — 단추로 바꾸기, 모양 그대로, inch 입력, 식 안 단위, 구속 값, 도면 표제란, 되돌리기, 저장, 새 문서 기본 단위
const { out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const proj = () => B(() => JSON.parse(JSON.stringify(window.blueprint3d.store.project)));
  const geom = (p) => JSON.stringify([p.thickness, ...['front', 'top', 'side'].map((v) => p.views[v].map(({ exprs, ...s }) => s))]);
  const toast = () => page.textContent('#toast');
  const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
  try {
    await fresh(page);
    await waitBuild(page);
    await page.keyboard.press('Control+Alt+n'); await waitBuild(page);
    await B(() => window.blueprint3d.store.update((p) => {
      p.params = [{ name: 'L', expr: '60' }, { name: 'n', expr: '4' }];
      p.views.top = [
        { id: 'plate', kind: 'rect', hole: false, x: 0, y: 0, w: 80, h: 40, exprs: { w: '80', h: '40' } },
        { id: 'h', kind: 'circle', hole: true, cx: 30, cy: 20, r: 3, exprs: { cx: 'L/2', d: '6' } },
        { id: 'c2', kind: 'circle', hole: true, cx: 50, cy: 25, r: 2 },
      ];
      p.thickness = 8;
    }, '준비'));
    await waitBuild(page);
    const p0 = await proj();
    ok('처음은 mm (단추·상태 표시줄)', (await page.textContent('#unitBtn')) === 'mm');

    // ---- 단추로 inch ----
    await page.click('#unitBtn'); await page.waitForTimeout(300);
    let p1 = await proj();
    ok('inch로 바뀜 + 알림', p1.units === 'inch' && (await page.textContent('#unitBtn')) === 'inch' && /inch로 바꿨어요/.test(await toast()), await toast());
    ok('모양(mm 값)은 그대로', geom(p1) === geom(p0));
    ok('식은 값이 같게 고쳐 씀 (80 → 80 mm, L/2 → (L/2) mm)', p1.views.top[0].exprs.w === '80 mm' && p1.views.top[1].exprs.cx === '(L/2) mm', JSON.stringify([p1.views.top[0].exprs, p1.views.top[1].exprs]));
    const grid = await page.$$eval('#grid option', (o) => o.map((x) => x.textContent));
    ok('격자 목록이 inch (0.1" 1/8" …)', grid.includes('0.1"') && grid.includes('1/8"'), grid.join(' '));

    // ---- 속성 패널: inch로 보이고 inch로 입력 ----
    await page.click('[data-focus="top"]'); await page.waitForTimeout(300);
    // 사각형 가운데를 눌러 고르기
    const [cx, cy] = await B(() => { const [x, y] = window.blueprint3d.board.panes.top.toScreen(40, 30); const r = document.querySelector('#board').getBoundingClientRect(); return [r.x + x, r.y + y]; });
    await page.click('[data-tool="select"]');
    await page.mouse.click(cx, cy); await page.waitForTimeout(300);
    const wField = await page.$$eval('#props .expr-field input', (xs) => xs.map((x) => x.value));
    ok('가로 칸이 inch 문서에서 "80 mm" (값 유지 식)', wField.includes('80 mm'), wField.join(' | '));
    const statusTxt = await page.textContent('#props');
    ok('속성 제목에 inch 값 (3.15×1.57)', /3\.15×1\.57/.test(statusTxt), statusTxt.slice(0, 60));
    // 가로 칸에 맨 숫자 4 → 4 inch
    const inputs = await page.$$('#props .expr-field input');
    let wi = null;
    for (const i of inputs) if ((await i.inputValue()) === '80 mm') wi = i;
    await wi.fill('4'); await wi.press('Enter'); await page.waitForTimeout(300);
    let pl = (await proj()).views.top[0];
    ok('맨 숫자 4 = 4 inch = 101.6 mm', near(pl.w, 101.6) && pl.exprs.w === '4', `${pl.w} ${pl.exprs.w}`);
    await page.mouse.click(cx, cy); await page.waitForTimeout(300);
    for (const i of await page.$$('#props .expr-field input')) if ((await i.inputValue()) === '4') { await i.fill('50 mm + 1 in'); await i.press('Enter'); }
    await page.waitForTimeout(300);
    pl = (await proj()).views.top[0];
    ok('식 안 단위: 50 mm + 1 in = 75.4 mm', near(pl.w, 75.4), String(pl.w));

    // ---- 구속 값도 inch ----
    await page.keyboard.press('Escape');
    await page.click('[data-cmd="cons.distanceX"]');
    const scr = (u, v) => B(([u, v]) => { const [x, y] = window.blueprint3d.board.panes.top.toScreen(u, v); const r = document.querySelector('#board').getBoundingClientRect(); return [r.x + x, r.y + y]; }, [u, v]);
    let [x, y] = await scr(0, 0); await page.mouse.click(x, y); await page.waitForTimeout(120);
    [x, y] = await scr(50, 25); await page.mouse.click(x, y); await page.waitForTimeout(200);
    const ed = '.dyn-input:visible';
    const shown = await page.inputValue(ed).catch(() => '');
    ok('치수 구속 값 칸이 inch로 (50 mm = 1.969)', shown === '1.969', shown + ' | ' + (await toast()));
    await page.fill(ed, '1'); await page.press(ed, 'Enter'); await page.waitForTimeout(250);
    const pc = await proj();
    const c2 = pc.views.top.find((s) => s.id === 'c2');
    ok('구속 값 1 = 1 inch → 판 왼쪽에서 구멍까지 25.4 mm', near(c2.cx - pc.views.top[0].x, 25.4), `${c2.cx} - ${pc.views.top[0].x}`);
    await page.keyboard.press('Escape');

    // ---- 상태 표시줄 좌표 단위 ----
    await page.mouse.move(cx, cy); await page.waitForTimeout(150);
    ok('좌표 표시가 in', / in$/.test((await page.textContent('#coords')).trim()), await page.textContent('#coords'));

    // ---- 도면: 표제란 inch ----
    await page.keyboard.press('3'); await page.waitForTimeout(1500);
    const svg = await page.innerHTML('#sheetHost');
    ok('도면 표제란 “3각법 · inch”', svg.includes('3각법 · inch'));
    await page.screenshot({ path: out('units-sheet-inch.png') });
    await page.keyboard.press('2'); await page.waitForTimeout(400);

    // ---- 실행 취소로 mm, 다시 실행 inch ----
    const labels = await B(() => window.blueprint3d.store.history.entries.map((e) => e.label));
    ok('실행 취소 기록에 “길이 단위: inch”', labels.includes('길이 단위: inch'), labels.slice(0, 8).join(','));

    // ---- 다시 mm: 식이 원래 글자로 ----
    await page.click('#unitBtn'); await page.waitForTimeout(300);
    const p2 = await proj();
    ok('mm로 돌아오면 식이 원래대로 (L/2)', !p2.units && p2.views.top[1].exprs.cx === 'L/2', JSON.stringify(p2.views.top[1].exprs));
    ok('mm 왕복 뒤에도 모양 그대로', near(p2.views.top[0].w, 75.4) && near(p2.views.top[1].cx, 30) && near(p2.views.top[2].cx - p2.views.top[0].x, 25.4));
    ok('구속 값은 mm 값 그대로 (25.4)', near(p2.constraints.top[0].value, 25.4));
    await page.click('#unitBtn'); await page.waitForTimeout(300);

    // ---- 저장 → 새로 고침 ----
    await page.waitForTimeout(1200);
    await page.reload(); await waitBuild(page);
    ok('새로 고침 뒤에도 inch', (await proj()).units === 'inch' && (await page.textContent('#unitBtn')) === 'inch');

    // ---- 설정: 새 문서 단위 ----
    await B(() => window.blueprint3d.commands.run('app.settings'));
    await page.waitForTimeout(300);
    await page.selectOption('#setUnits', 'inch');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.keyboard.press('Control+Alt+n'); await waitBuild(page);
    ok('설정이 inch면 새 문서도 inch', (await proj()).units === 'inch');
    await B(() => window.blueprint3d.commands.run('units.mm')); await page.waitForTimeout(200);
    ok('명령 “길이 단위: mm”', !(await proj()).units);
    await page.screenshot({ path: out('units-board.png') });
  } catch (e) {
    results.push('FAIL (stopped) ' + String(e).split('\n')[0]);
  }
  finish(results, errs);
  await browser.close();
})();
