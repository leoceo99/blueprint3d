// 8단계 검증: 명령 시스템, 명령 찾기, 한글 입력 단축키, 실행 취소 기록 2.0, 작업 공간 모듈, 단축키 바꾸기, 패널 배치, 설정, 메뉴
const { URL, out, tmp, launch, finish, unzip, ROOT } = require('./lib.cjs');
const path = require('path');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', d => d.accept());
  const status = () => page.textContent('#buildStatus');
  const waitBuild = async () => { await page.waitForTimeout(500); await page.waitForFunction(() => /✓|⚠|도형을 그리면/.test(document.querySelector('#buildStatus')?.textContent || ''), null, { timeout: 120000 }); await page.waitForTimeout(300); };
  const tool = async () => { await page.waitForTimeout(80); return page.$$eval('[data-tool].active', b => b.map(x => x.dataset.tool).join(',')); };
  const B = (fn, arg) => page.evaluate(fn, arg);
  const board = async () => { await page.click('#board', { position: { x: 420, y: 330 } }); await page.keyboard.press('Escape'); };
  try {
    await page.goto(URL);
    await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase('blueprint3d'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
    await page.reload();
    await waitBuild();

    // ---- 8.7 main.ts 크기, 명령 수 ----
    const mainLines = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf8').split('\n').length;
    ok('main.ts ≤ 300 lines', mainLines <= 300, `${mainLines} lines`);
    const nCmd = await B(() => window.blueprint3d.commands.list().length);
    ok('commands registered', nCmd >= 70, `${nCmd}`);

    // ---- 8.1 버튼·메뉴·단축키가 같은 명령 ----
    const kbds = await page.$$eval('#ribbon [data-cmd] kbd', ks => ks.map(k => k.textContent).join(' '));
    ok('ribbon shortcut labels from commands', /V R C L S D/.test(kbds) && kbds.includes('⌃Z'), kbds);
    await page.click('[data-menu="file"]');
    const fileKbd = await page.$$eval('#menu-file [data-cmd] kbd', ks => ks.map(k => k.textContent).filter(Boolean));
    ok('file menu shortcut labels', fileKbd.includes('Ctrl+Alt+N') && fileKbd.includes('Ctrl+Shift+O'), fileKbd.join(' '));
    await page.keyboard.press('Escape'); await page.click('#coords');
    await page.click('[data-menu="edit"]');
    const editItems = await page.$$eval('#menu-edit button', bs => bs.map(b => `${b.querySelector('.mi-title').textContent}${b.disabled ? '(x)' : ''}`));
    ok('edit menu built from commands, disabled when unusable', editItems.includes('실행 취소(x)') && editItems.includes('선택한 도형·구속 삭제(x)'), editItems.slice(0, 5).join(', '));
    await page.screenshot({ path: out('s8-edit-menu.png') });
    await page.click('[data-menu="view"]'); // 다른 메뉴로 바로
    const viewItems = await page.$$eval('#menu-view button', bs => bs.map(b => `${b.classList.contains('checked') ? '✓' : ''}${b.querySelector('.mi-title').textContent}`));
    ok('view menu: workspaces + checked toggles', viewItems.includes('✓2D 설계 화면으로') && viewItems.includes('✓격자 스냅'), viewItems.slice(0, 6).join(', '));
    await page.click('#menu-view button[data-cmd="snap.grid"]');
    await page.waitForTimeout(80);
    ok('menu item runs command (snap off)', !(await page.$eval('#snapGridBtn', b => b.classList.contains('on'))));
    await page.keyboard.press('g');
    await page.waitForTimeout(80);
    ok('G toggles back', await page.$eval('#snapGridBtn', b => b.classList.contains('on')));

    // ---- 한글 입력 상태에서도 단축키 (자판 위치) ----
    await B(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㄱ', code: 'KeyR', bubbles: true, cancelable: true })));
    ok('Korean IME: ㄱ(R key) → rectangle tool', (await tool()) === 'rect', await tool());
    await B(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㅍ', code: 'KeyV', bubbles: true, cancelable: true })));
    ok('Korean IME: ㅍ(V key) → select tool', (await tool()) === 'select');

    // ---- 8.2 명령 찾기 ----
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.pal-input');
    await page.keyboard.type('ㅇ');
    await page.keyboard.type('ㄱ');
    await page.waitForTimeout(150);
    let rows = await page.$$eval('.pal-row .pal-title', r => r.map(x => x.textContent));
    ok('palette: choseong ㅇㄱ finds 원 그리기?', rows.length > 0, rows.slice(0, 3).join(' | '));
    await page.fill('.pal-input', 'circle');
    await page.waitForTimeout(100);
    rows = await page.$$eval('.pal-row .pal-title', r => r.map(x => x.textContent));
    ok('palette: English alias', rows[0] === '원 그리기', rows.slice(0, 3).join(' | '));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    ok('palette: Enter runs, closes', (await tool()) === 'circle' && !(await page.isVisible('.pal-input')));
    await page.keyboard.press('Control+k');
    await page.fill('.pal-input', '삭제');
    await page.waitForTimeout(100);
    const delRow = await page.$eval('.pal-row', r => ({ t: r.textContent, off: r.classList.contains('off') }));
    ok('palette: disabled command greyed', delRow.off, delRow.t);
    await page.keyboard.press('Enter');
    ok('palette: Enter on disabled keeps open', await page.isVisible('.pal-input'));
    await page.fill('.pal-input', '');
    await page.waitForTimeout(100);
    const first = await page.$eval('.pal-row', r => r.textContent);
    ok('palette: recent first', /원 그리기/.test(first) && /최근/.test(first), first);
    await page.screenshot({ path: out('s8-palette.png') });
    await page.keyboard.press('Escape');
    ok('palette: Esc closes', !(await page.isVisible('.pal-input')));
    await page.click('#paletteBtn');
    ok('palette button opens', await page.isVisible('.pal-input'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');

    // ---- 8.3 실행 취소 기록 2.0 ----
    await B(() => window.blueprint3d.store.history.clear());
    await page.fill('#name', '기록 시험'); await page.press('#name', 'Enter');
    await page.waitForTimeout(100);
    await page.keyboard.press('1');
    // 도형 그리기: 사각형 도구로 끌기
    await page.keyboard.press('r');
    const bb = await page.$eval('#board', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.mouse.move(bb.x + bb.w * 0.2, bb.y + bb.h * 0.75);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.w * 0.27, bb.y + bb.h * 0.82, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('v');
    await B(() => window.blueprint3d.commands.run('mode.revolve'));
    await B(() => window.blueprint3d.commands.run('mode.auto'));
    await page.waitForTimeout(200);
    let labels = await B(() => window.blueprint3d.store.history.entries.map(e => e.label));
    ok('history labels per command', labels.join(',') === '이름 바꾸기,사각형 그리기,회전체로,돌출·교집합으로', labels.join(','));
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    ok('undo toast names the step', /실행 취소: 돌출·교집합으로/.test(await page.textContent('#toast')), await page.textContent('#toast'));
    await page.keyboard.press('Control+Alt+z');
    await page.waitForSelector('.hist-row');
    const hrows = await page.$$eval('.hist-row', r => r.map(x => `${x.className.split(' ').pop()}:${x.querySelector('.hist-label').textContent}`));
    ok('history window: rows + current + undone', hrows.length === 5 && hrows[3].startsWith('cur:') && hrows[4].startsWith('undone:'), hrows.join(' | '));
    await page.screenshot({ path: out('s8-history.png') });
    await page.click('.hist-row >> nth=0');
    await page.waitForTimeout(200);
    ok('jump to start', (await page.inputValue('#name')) !== '기록 시험' && (await B(() => window.blueprint3d.store.history.position)) === 0);
    await page.click('.hist-row >> nth=2');
    await page.waitForTimeout(200);
    const shapesFront = await B(() => Object.values(window.blueprint3d.store.project.views).flat().length);
    ok('jump forward to step 2', (await page.inputValue('#name')) === '기록 시험' && (await B(() => window.blueprint3d.store.history.position)) === 2, `${shapesFront} shapes`);
    await page.keyboard.press('Escape');
    // 끌기 한 번 = 기록 한 칸
    const before = await B(() => window.blueprint3d.store.history.entries.length);
    const sel = await B(() => { const p = window.blueprint3d.store.project; for (const v of ['front', 'top', 'side']) if (p.views[v].length) return v; });
    void sel;
    // 큰 문서에서 기록 크기
    const mem = await B(() => {
      const s = window.blueprint3d.store;
      s.update((p) => { p.views.top = Array.from({ length: 1500 }, (_, i) => ({ id: 'b' + i, kind: 'rect', hole: false, x: i * 2, y: 0, w: 1, h: 1 })); }, '큰 문서');
      const b0 = s.history.bytes;
      for (let i = 0; i < 100; i++) s.update((p) => { p.views.top[i].w = 2 + i; }, '치수');
      return { doc: JSON.stringify(s.project).length, added: s.history.bytes - b0 };
    });
    ok('large doc: 100 edits cost ≪ document size', mem.added < mem.doc / 4, `${mem.added} B for 100 edits vs doc ${mem.doc} B`);
    await B(() => window.blueprint3d.store.undo());
    ok('undo in large doc works', (await B(() => window.blueprint3d.store.project.views.top[99].w)) === 1 && (await B(() => window.blueprint3d.store.project.views.top[98].w)) === 100);
    void before;
    await page.keyboard.press('Control+Alt+n'); await waitBuild();

    // ---- 8.4 작업 공간 모듈 ----
    await page.click('#settingsBtn');
    await page.check('#devExample');
    await page.waitForTimeout(200);
    await page.click('#settings button[value="cancel"]');
    let tabs = await page.$$eval('.ws-tabs button', b => b.map(x => x.textContent));
    ok('example workspace attached (tab)', tabs.length === 4 && tabs[3].includes('예제'), tabs.join(' | '));
    await page.keyboard.press('4');
    await page.waitForTimeout(200);
    ok('key 4 → example workspace', await page.isVisible('.ex-card') && !(await page.isVisible('#ws-main')));
    await page.screenshot({ path: out('s8-example.png') });
    await page.click('[data-ex-say]');
    ok('example command runs', /예제 작업 공간의 명령/.test(await page.textContent('#toast')));
    await page.keyboard.press('1');
    ok('back to design', await page.isVisible('#ws-main') && !(await page.isVisible('.ex-card')));
    await page.click('#settingsBtn'); await page.uncheck('#devExample'); await page.click('#settings button[value="cancel"]');
    tabs = await page.$$eval('.ws-tabs button', b => b.map(x => x.textContent));
    ok('example workspace detached', tabs.length === 3 && !(await B(() => !!window.blueprint3d.commands.get('ws.example'))) && !(await B(() => !!window.blueprint3d.commands.get('example.hello'))), tabs.join(' | '));
    await page.keyboard.press('4');
    ok('key 4 does nothing after detach', await page.isVisible('#ws-main'));
    // 코드로 붙였다 떼기 (플러그인처럼)
    const plug = await B(() => {
      const el = document.createElement('main'); el.className = 'workspace'; el.hidden = true; el.textContent = 'plugin'; document.querySelector('footer').before(el);
      const off = window.blueprint3d.registerWorkspace({ id: 'plug', title: '플러그인', icon: '★', order: 50, show: () => (el.hidden = false), hide: () => (el.hidden = true), commands: [{ id: 'plug.x', title: '플러그인 명령', category: 'x', run: () => {} }] });
      const n = document.querySelectorAll('.ws-tabs button').length;
      off();
      return { n, after: document.querySelectorAll('.ws-tabs button').length, cmd: !!window.blueprint3d.commands.get('plug.x') };
    });
    ok('register/unregister from code', plug.n === 4 && plug.after === 3 && !plug.cmd, JSON.stringify(plug));
    await page.keyboard.press('2'); await page.waitForTimeout(200);
    ok('digits still switch (2 → 3D)', await page.isVisible('#stage-3d'));
    await page.keyboard.press('1');

    // ---- 8.6 단축키 바꾸기 ----
    await page.keyboard.press('Control+,');
    await page.waitForSelector('#settings[open]');
    await page.fill('#keyFilter', '사각형');
    await page.waitForTimeout(100);
    await page.click('.key-row:has(.key-title:text-is("사각형 그리기")) button:text-is("바꾸기")');
    await page.keyboard.press('q');
    await page.waitForTimeout(100);
    const chip = await page.$eval('.key-row:has(.key-title:text-is("사각형 그리기")) .key-chips', e => e.textContent);
    ok('rebind rect → Q (settings)', chip === 'Q', chip);
    await page.screenshot({ path: out('s8-settings-keys.png') });
    await page.click('#settings button[value="cancel"]');
    const rectKbd = await page.$eval('[data-cmd="tool.rect"] kbd', k => k.textContent);
    ok('ribbon shows new key', rectKbd === 'Q', rectKbd);
    await board();
    await page.keyboard.press('q');
    ok('Q → rectangle', (await tool()) === 'rect');
    await page.keyboard.press('v');
    await page.keyboard.press('r');
    ok('R no longer rectangle', (await tool()) === 'select');
    // 겹치는 키: 사각형에 V → 선택 도구에서 V가 빠짐
    await page.keyboard.press('Control+,');
    await page.fill('#keyFilter', '사각형');
    await page.click('.key-row:has(.key-title:text-is("사각형 그리기")) button:text-is("바꾸기")');
    await page.keyboard.press('v');
    await page.waitForTimeout(100);
    ok('conflict toast', /‘선택 · 이동’에서는 뺐어요/.test(await page.textContent('#toast')), await page.textContent('#toast'));
    await page.click('#settings button[value="cancel"]');
    ok('select lost V', (await page.$eval('[data-cmd="tool.select"] kbd', k => k.textContent)) === '' && (await B(() => window.blueprint3d.commands.keysOf('tool.select').length)) === 0);
    await page.reload(); await waitBuild();
    ok('custom keys persist after reload', (await page.$eval('[data-cmd="tool.rect"] kbd', k => k.textContent)) === 'V');
    await page.keyboard.press('Control+,');
    await page.click('#keysReset');
    await page.waitForTimeout(100);
    await page.click('#settings button[value="cancel"]');
    ok('reset all shortcuts', (await page.$eval('[data-cmd="tool.rect"] kbd', k => k.textContent)) === 'R' && (await page.$eval('[data-cmd="tool.select"] kbd', k => k.textContent)) === 'V');

    // ---- 8.6 테마 ----
    await page.keyboard.press('Control+,');
    await page.check('input[name="theme"][value="dark"]');
    await page.waitForTimeout(150);
    const dark = await B(() => ({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }));
    ok('dark theme applies', dark.t === 'dark' && dark.bg === 'rgb(13, 20, 28)', JSON.stringify(dark));
    await page.screenshot({ path: out('s8-settings-dark.png') });
    await page.click('#settings button[value="cancel"]');
    await page.screenshot({ path: out('s8-dark.png') });
    await page.reload(); await waitBuild();
    ok('theme persists', (await B(() => document.documentElement.dataset.theme)) === 'dark');
    await B(() => window.blueprint3d.commands.run('theme.system'));
    ok('theme back to system', (await B(() => document.documentElement.dataset.theme)) === undefined);

    // ---- 8.5 패널 배치 ----
    const lw0 = await page.$eval('.panel.left', e => e.getBoundingClientRect().width);
    const sp = await page.$eval('.splitter.left', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x + 90, sp.y, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(200);
    const lw1 = await page.$eval('.panel.left', e => e.getBoundingClientRect().width);
    ok('drag splitter widens left panel', Math.abs(lw1 - lw0 - 90) < 6, `${lw0} → ${lw1}`);
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(150);
    ok('Ctrl+B collapses left panel', !(await page.isVisible('.panel.left')));
    await B(() => window.blueprint3d.commands.run('layout.swap'));
    await page.waitForTimeout(150);
    await page.screenshot({ path: out('s8-layout.png') });
    await page.reload(); await waitBuild();
    const lay = await page.evaluate(() => ({ leftHidden: document.querySelector('.panel.left').hidden, swapped: document.querySelector('#ws-main').classList.contains('swapped'), rightX: document.querySelector('.panel.right').getBoundingClientRect().x }));
    ok('layout persists after reload (collapsed + swapped)', lay.leftHidden && lay.swapped && lay.rightX < 50, JSON.stringify(lay));
    await page.click('.splitter.left');
    await page.waitForTimeout(150);
    const lw2 = await page.$eval('.panel.left', e => e.getBoundingClientRect().width);
    ok('click collapsed splitter reopens with saved width', await page.isVisible('.panel.left') && Math.abs(lw2 - lw1) < 6, `${lw2}`);
    await B(() => window.blueprint3d.commands.run('layout.reset'));
    await page.waitForTimeout(150);
    ok('layout reset', (await page.$eval('.panel.left', e => Math.round(e.getBoundingClientRect().width))) === 230 && !(await page.$eval('#ws-main', e => e.classList.contains('swapped'))));
    ok('3D still builds after layout changes', /✓|도형을 그리면/.test(await status()), await status());
    await page.screenshot({ path: out('s8-final.png') });
  } catch (e) { results.push('FAIL (stopped) ' + String(e).split('\n')[0]); }
  finish(results, errs);
  await browser.close();
})();
