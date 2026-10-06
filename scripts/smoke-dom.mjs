/**
 * DOM 冒烟测试：把 vite build 的产物加载进 jsdom，
 * 验证控件渲染、搜索结果列表、指板 SVG 与点击交互都能工作（无需浏览器）。
 * 运行：npm run build 后 node scripts/smoke-dom.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const jsFile = readdirSync(path.join(dist, 'assets')).find((f) => f.endsWith('.js'));
const code = readFileSync(path.join(dist, 'assets', jsFile), 'utf8');

const errors = [];
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/g, ''), {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
dom.window.addEventListener('error', (e) => errors.push(e.message));
dom.window.eval(code);

const doc = dom.window.document;
const assert = (cond, msg) => {
  if (!cond) {
    console.error('✗', msg);
    process.exitCode = 1;
  } else {
    console.log('✓', msg);
  }
};

// 1. 控件渲染
assert(doc.querySelectorAll('#main-pc-grid .pc-btn').length === 12, '12 个音级按钮');
assert(doc.querySelector('.string-row') !== null, '开放弦输入行存在');
assert(doc.querySelectorAll('select').length >= 3, '预设/弦数/品位下拉存在');

// 默认 E 大三：目标 C? 不，目标是 E G# B（4,7,11）
const onPcs = [...doc.querySelectorAll('#main-pc-grid .pc-btn.on')].map((b) => b.textContent);
assert(JSON.stringify(onPcs) === JSON.stringify(['E', 'G#', 'B']), `默认目标音级 E/G#/B，实际 ${onPcs}`);

// 2. 结果列表
const items = () => doc.querySelectorAll('.result-item:not(.transition-item)');
assert(items().length > 0 && items().length <= 20, `结果数量 1..20（${items().length}）`);
const firstChips = [...items()[0].querySelectorAll('.chip')].map((c) => c.textContent);
assert(firstChips.length === 6, `六弦形状 6 个品位格（${firstChips.join(' ')}）`);

// 3. 指板 SVG
const svg = doc.querySelector('.fretboard-wrap svg');
assert(svg !== null, '指板 SVG 已渲染');
assert(svg.querySelectorAll('line.fb-string').length === 6, '6 根弦');
assert(svg.querySelectorAll('circle.fb-marker').length > 0, '存在按弦/开放标记');

// 4. 合法评估框
const evalTitle = doc.querySelector('.eval-box .eval-title')?.textContent ?? '';
assert(evalTitle.includes('合法形状 #1'), `选中结果显示合法（${evalTitle}）`);

// 5. 点击第 3 个结果 -> 选中态与评估更新
items()[2].click();
assert(items()[2].classList.contains('active'), '点击结果后高亮');
assert(doc.querySelector('.eval-title').textContent.includes('#3'), '评估更新为 #3');

// 6. 排除统计
const excCounts = [...doc.querySelectorAll('.exc-row .exc-count')].map((e) => e.textContent);
assert(excCounts.length === 5, `5 类排除原因（${excCounts.join(' / ')}）`);

// 6.5 单横按模式：开关 -> 横按标注、SVG 横按标记、评估与排除文案共用同一结论
const clickQualityMajor = () =>
  [...doc.querySelectorAll('button')].find((b) => b.textContent === '大三').click();
assert(doc.querySelector('.fb-barre') === null, '默认模式无横按标记');
assert(doc.querySelector('#barre-toggle') !== null, '存在单横按模式开关');
// 切到 F 大三（根音 F + 大三）：横按形状才进入前 20
const rootSel = doc.querySelector('#root-select');
rootSel.value = '5';
rootSel.dispatchEvent(new dom.window.Event('change'));
clickQualityMajor();
const barreCb = doc.querySelector('#barre-toggle');
barreCb.checked = true;
barreCb.dispatchEvent(new dom.window.Event('change'));
const excNames = [...doc.querySelectorAll('.exc-row span:first-child')].map((e) => e.textContent);
assert(excNames.some((t) => t.includes('最优指法')), '横按模式排除原因文案切换');
assert(
  [...doc.querySelectorAll('.result-item:not(.transition-item)')].some((it) =>
    it.querySelector('.result-meta').textContent.includes('横'),
  ),
  '结果列表出现带横按标注的项',
);
// 选一个「仅横按合法」的结果（默认模式下超 4 指）作为切换锚点：
// 切到 F 小三，其前 20 名中 [1,3,x,1,1,1]（1 品横按高音四弦）默认模式超指，
// 横按模式合法。按品位向量在列表中点击，页面与 SVG 共用同一份指法结论。
const clickQuality = (name) =>
  [...doc.querySelectorAll('button')].find((b) => b.textContent === name).click();
clickQuality('小三');
const barreOnlyKey = '13x111';
const barreOnlyItem = [...doc.querySelectorAll('.result-item:not(.transition-item)')].find((it) =>
  [...it.querySelectorAll('.chip')].map((c) => c.textContent).join('') === barreOnlyKey,
);
assert(barreOnlyItem !== undefined, 'Fm 前 20 名中存在仅横按合法的形状 [1,3,x,1,1,1]');
// 核心侧核对：该形状默认模式确实非法、横按模式 4 指合法。
{
  const STD = [40, 45, 50, 55, 59, 64];
  const shape = [1, 3, -1, 1, 1, 1];
  assert(dom.window.__fret.evaluateShape(shape, STD, [0, 5, 8]).valid === false, 'Fm 横按形状默认模式非法');
  const ev = dom.window.__fret.evaluateShape(shape, STD, [0, 5, 8], { allowBarre: true });
  assert(ev.valid === true && ev.fingers === 3, 'Fm 横按形状横按模式 3 指合法');
}
barreOnlyItem.click();
assert(doc.querySelector('.fb-barre') !== null, '选中仅横按合法结果后指板显示横按标记');
assert(doc.querySelector('.eval-box').textContent.includes('横按'), '评估框说明横按指法');
// 关闭横按模式并恢复 E 大三，供后续步骤使用
const barreCb2 = doc.querySelector('#barre-toggle');
barreCb2.checked = false;
barreCb2.dispatchEvent(new dom.window.Event('change'));
assert(doc.querySelector('.fb-barre') === null, '关闭横按模式后无横按标记');
// 横按专属锚点失效：上一个锚点是仅横按合法的 F 形状，关闭模式后预演必须撤销
assert(
  doc.querySelector('.transition-panel .transition-banner.bad')?.textContent.includes('不合法') ?? false,
  '关闭横按模式后横按锚点不再合法：切换预演撤销并提示',
);
const rootSel2 = doc.querySelector('#root-select');
rootSel2.value = '4';
rootSel2.dispatchEvent(new dom.window.Event('change'));
clickQualityMajor();
const onPcs2 = [...doc.querySelectorAll('#main-pc-grid .pc-btn.on')].map((b) => b.textContent);
assert(JSON.stringify(onPcs2) === JSON.stringify(['E', 'G#', 'B']), '恢复 E 大三目标音级');

// 6.7 双和弦切换预演：面板、下一目标网格、候选与逐弦变化、点击预览
const trPanel = doc.querySelector('.transition-panel');
assert(trPanel !== null, '双和弦切换预演面板存在');
assert(doc.querySelectorAll('#next-pc-grid .pc-btn').length === 12, '下一和弦 12 个音级按钮');
// 当前锚点已在关闭横按时失效，重新点击第一个单和弦结果锚定（E 形状）。
items()[0].click();
assert(
  doc.querySelector('.transition-panel .transition-banner.ok') !== null,
  '锚定合法形状后提示起点合法',
);
const trItems = () => doc.querySelectorAll('.transition-item');
assert(trItems().length > 0 && trItems().length <= 20, `切换候选数量 1..20（${trItems().length}）`);
// 每个候选都有与弦数等长的逐弦变化格
trItems().forEach((it, i) => {
  const cells = it.querySelectorAll('.tr-cell');
  if (cells.length !== 6) {
    console.error(`✗ 候选 #${i + 1} 逐弦变化格数为 ${cells.length}`);
    process.exitCode = 1;
  }
});
assert(trItems()[0].querySelectorAll('.tr-cell').length === 6, '每个候选 6 个逐弦变化格');
// 起点等于锚点形状时，第一名应是零切换代价（自身形状）
assert(
  trItems()[0].querySelector('.result-meta').textContent.includes('闷变0 移动0'),
  `首候选零切换代价（${trItems()[0].querySelector('.result-meta').textContent}）`,
);
// 点击候选 -> 进入切换预览：指板出现逐弦变化徽标与下一形状标记
trItems()[1].click();
assert(trItems()[1].classList.contains('active'), '候选点击后高亮');
assert(doc.querySelectorAll('.fb-change').length === 6, '指板显示 6 个逐弦变化徽标');
assert(doc.querySelector('.eval-title').textContent.includes('下一和弦候选 #2'), '评估框为切换候选 #2');
// 返回当前和弦预览
[...doc.querySelectorAll('button')].find((b) => b.textContent === '返回当前和弦预览').click();
assert(doc.querySelector('.eval-title').textContent.includes('合法形状'), '返回当前和弦预览');

// 修改下一和弦目标（切到 A 大三 {9,1,4}）：候选随之重算
const nextGrid = doc.querySelectorAll('#next-pc-grid .pc-btn');
// 当前下一目标为 E/G#/B = 4/8/11；点掉 8(G#)、11(B)，点上 9(A)、1(C#)
nextGrid[8].click();
nextGrid[11].click();
nextGrid[9].click();
nextGrid[1].click();
const trItems2 = doc.querySelectorAll('.transition-item');
assert(trItems2.length > 0, '更换下一和弦目标后仍有候选');

// 定弦编辑使锚点失效：把所有开放弦 +1（锚点形状不再是当前定弦的同一和弦）
// 直接把第一根开放弦的 MIDI 输入改为 41，再点结果区之外触发 input。
{
  const firstMidi = doc.querySelector('.string-row input[type="number"]');
  firstMidi.value = '41';
  firstMidi.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const bad = doc.querySelector('.transition-panel .transition-banner.bad');
  assert(bad !== null && bad.textContent.includes('预演已撤销'), `改定弦后锚点失效、预演撤销（${bad?.textContent ?? ''}）`);
  assert(doc.querySelectorAll('.result-item:not(.transition-item)').length > 0, '单和弦结果仍正常显示');
  assert(doc.querySelectorAll('.transition-item').length === 0, '预演撤销后无切换候选');
  // 恢复定弦并重新锚定，供后续步骤
  firstMidi.value = '40';
  firstMidi.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  items()[0].click();
  assert(doc.querySelector('.transition-panel .transition-banner.ok') !== null, '恢复定弦并重新锚定后预演恢复');
}

// 7. 自定义模式：进入后点击指板格子（按第 2 根弦第 3 品）
[...doc.querySelectorAll('.tabs button')].find((b) => b.textContent.includes('自定义')).click();
// 重渲染后指板节点会被替换，需重新查询
const liveSvg = () => doc.querySelector('.fretboard-wrap svg');
const rects = () => [...liveSvg().querySelectorAll('rect.fb-clickable')];
assert(rects().length > 0, '编辑模式有点击热区');
// 热区顺序：每弦 (maxFret+1) 个（琴枕上方热区 + 各品），弦1 品3：
const maxFret = 5;
rects()[1 * (maxFret + 1) + 3].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const customTitle = doc.querySelector('.eval-title').textContent;
assert(customTitle.includes('合法') || customTitle.includes('被排除'), `点击后评估刷新（${customTitle}）`);

// 8. 改成不可能的目标（E/G#/B 中关掉两个，只剩 1 个）-> 显示错误且无结果
doc.querySelectorAll('#main-pc-grid .pc-btn')[11].click(); // 关闭 B
doc.querySelectorAll('#main-pc-grid .pc-btn')[8].click(); // 关闭 G#（重新渲染后重新查询）
const errBox = doc.querySelector('.error-box')?.textContent ?? '';
assert(errBox.includes('2 至 5'), `单目标时显示校验错误（${errBox.trim()}）`);

// 9. 切到 4 弦贝斯预设后弦数变为 4
const presetSel = doc.querySelector('#preset-select');
presetSel.value = '5'; // 四弦贝斯
presetSel.dispatchEvent(new dom.window.Event('change'));
assert(doc.querySelectorAll('.string-row').length === 4, '切换贝斯预设后为 4 根弦');
assert(doc.querySelectorAll('line.fb-string').length === 4, '指板变为 4 根弦');

// 10. 无合法下一形状时明确显示空结果：
// 贝斯开放音 E A D G = {4,9,2,7}。最大品位调到 3，把主目标清空后选 E5 {4,7}
// （0..3 品可达）；下一目标选 {0,1}，其中音级 1 在贝斯 0..3 品不可达 -> 零合法形状。
const fretSel = doc.querySelector('#max-fret-select');
fretSel.value = '3';
fretSel.dispatchEvent(new dom.window.Event('change'));
[...doc.querySelectorAll('#main-pc-grid .pc-btn.on')].forEach((b) => b.click());
doc.querySelectorAll('#main-pc-grid .pc-btn')[4].click(); // E
doc.querySelectorAll('#main-pc-grid .pc-btn')[7].click(); // G
const bassItems = doc.querySelectorAll('.result-item:not(.transition-item)');
assert(bassItems.length > 0, `贝斯 E5 有单和弦结果（${bassItems.length}）`);
bassItems[0].click();
const ng = doc.querySelectorAll('#next-pc-grid .pc-btn');
[...ng].forEach((b) => { if (b.classList.contains('on')) b.click(); });
ng[0].click(); // C
ng[1].click(); // C# —— 贝斯 0..3 品不可达
const emptyBanner = doc.querySelector('.transition-panel .transition-banner.bad')?.textContent ?? '';
assert(
  emptyBanner.includes('没有合法') && doc.querySelectorAll('.transition-item').length === 0,
  `下一和弦无合法形状时明确显示空结果（${emptyBanner}）`,
);

assert(errors.length === 0, `无未捕获错误（${errors.join('; ')}）`);
console.log(process.exitCode ? '\n冒烟测试失败' : '\n全部冒烟断言通过');
