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
assert(doc.querySelectorAll('.pc-btn').length === 12, '12 个音级按钮');
assert(doc.querySelector('.string-row') !== null, '开放弦输入行存在');
assert(doc.querySelectorAll('select').length >= 3, '预设/弦数/品位下拉存在');

// 默认 E 大三：目标 C? 不，目标是 E G# B（4,7,11）
const onPcs = [...doc.querySelectorAll('.pc-btn.on')].map((b) => b.textContent);
assert(JSON.stringify(onPcs) === JSON.stringify(['E', 'G#', 'B']), `默认目标音级 E/G#/B，实际 ${onPcs}`);

// 2. 结果列表
const items = () => doc.querySelectorAll('.result-item');
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
const rootSel = doc.querySelectorAll('select')[2];
rootSel.value = '5';
rootSel.dispatchEvent(new dom.window.Event('change'));
clickQualityMajor();
const barreCb = doc.querySelector('#barre-toggle');
barreCb.checked = true;
barreCb.dispatchEvent(new dom.window.Event('change'));
const excNames = [...doc.querySelectorAll('.exc-row span:first-child')].map((e) => e.textContent);
assert(excNames.some((t) => t.includes('最优指法')), '横按模式排除原因文案切换');
const barreItem = [...doc.querySelectorAll('.result-item')].find((it) =>
  it.querySelector('.result-meta').textContent.includes('横'),
);
assert(barreItem !== undefined, '结果列表出现带横按标注的项');
barreItem.click();
assert(doc.querySelector('.fb-barre') !== null, '选中横按结果后指板显示横按标记');
assert(doc.querySelector('.eval-box').textContent.includes('横按'), '评估框说明横按指法');
// 关闭横按模式并恢复 E 大三，供后续步骤使用
const barreCb2 = doc.querySelector('#barre-toggle');
barreCb2.checked = false;
barreCb2.dispatchEvent(new dom.window.Event('change'));
assert(doc.querySelector('.fb-barre') === null, '关闭横按模式后无横按标记');
const rootSel2 = doc.querySelectorAll('select')[2];
rootSel2.value = '4';
rootSel2.dispatchEvent(new dom.window.Event('change'));
clickQualityMajor();
const onPcs2 = [...doc.querySelectorAll('.pc-btn.on')].map((b) => b.textContent);
assert(JSON.stringify(onPcs2) === JSON.stringify(['E', 'G#', 'B']), '恢复 E 大三目标音级');

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

// 7.5 双和弦切换预演：激活、切换标记、逐弦变化、空结果与状态清理
[...doc.querySelectorAll('.tabs button')].find((b) => b.textContent.includes('预览')).click();
doc.querySelectorAll('.result-item')[0].click(); // 选中单和弦 #1
doc.querySelector('.transition-start').click(); // 以此为起点预演切换
assert(doc.querySelector('.transition-panel') !== null, '切换预演面板出现');
const tItems = () => doc.querySelectorAll('.transition-item');
assert(tItems().length > 0 && tItems().length <= 20, `切换结果数量 1..20（${tItems().length}）`);
// 起点形状本身合法 -> 切换 #1 是原地不动（闷变 0、移动量 0）
const firstMeta = tItems()[0].querySelector('.result-meta').textContent;
assert(firstMeta.includes('闷变0') && firstMeta.includes('移0'), `切换 #1 为零代价（${firstMeta}）`);
const firstChangeChips = [...tItems()[0].querySelectorAll('.change-chip')];
assert(firstChangeChips.length === 6 && firstChangeChips[0].textContent === '0→0', '逐弦变化 chips 逐弦对应');
// 切换标记：指板上的起点空心标记
assert(doc.querySelectorAll('.fb-ghost').length > 0, '指板显示起点切换标记（fb-ghost）');
// 点击一个含品位移动的候选 -> 移动连线与评估更新
const moveItem = [...tItems()].find((it) => it.querySelector('.change-chip.kind-move'));
moveItem.click();
assert(doc.querySelectorAll('.fb-shift').length > 0, '品位移动弦显示移动连线（fb-shift）');
assert(doc.querySelector('.eval-title').textContent.includes('切换目标 #'), '切换评估框更新');
// 空结果：3 品内 {C,C#} 无法弹响 3 根弦
const fretSel3 = doc.querySelectorAll('select')[3];
fretSel3.value = '3';
fretSel3.dispatchEvent(new dom.window.Event('change'));
assert(doc.querySelector('.transition-panel') !== null, '最大品位收紧后预演仍保留（起点仍合法）');
const clickTpc = (i) => doc.querySelectorAll('.tpc-btn')[i].click();
clickTpc(4); // 关 E
clickTpc(8); // 关 G#
clickTpc(11); // 关 B
clickTpc(0); // 开 C
clickTpc(1); // 开 C#
const emptyBox = doc.querySelector('.transition-empty');
assert(emptyBox !== null && emptyBox.textContent.includes('空'), '无合法下一形状时明确显示空结果');
assert(
  doc.querySelector('.eval-box.bad .eval-title').textContent.includes('没有可切换到的合法下一形状'),
  '评估框同步显示空结果',
);
const fretSel4 = doc.querySelectorAll('select')[3];
fretSel4.value = '5';
fretSel4.dispatchEvent(new dom.window.Event('change'));
// 状态清理：当前目标音级编辑使起点不再合法 -> 撤销预演、保留单和弦功能
doc.querySelectorAll('.pc-btn')[11].click(); // 关闭 B：起点形状含 B 音级 -> 不再合法
assert(doc.querySelector('.transition-panel') === null, '起点失效后切换预演被撤销');
assert(doc.querySelectorAll('.result-item').length > 0, '撤销后单和弦结果列表仍在');
assert(doc.querySelector('.eval-title').textContent.includes('合法形状'), '撤销后回到单和弦预览');
doc.querySelectorAll('.pc-btn')[11].click(); // 恢复 B
// 退出按钮：重新激活后退出
doc.querySelector('.transition-start').click();
assert(doc.querySelector('.transition-panel') !== null, '重新激活切换预演');
doc.querySelector('.transition-exit').click();
assert(doc.querySelector('.transition-panel') === null, '退出预演按钮清理状态');
assert(doc.querySelector('.eval-title').textContent.includes('合法形状'), '退出后回到单和弦预览');

// 8. 改成不可能的目标（E/G#/B 中关掉两个，只剩 1 个）-> 显示错误且无结果
doc.querySelectorAll('.pc-btn')[11].click(); // 关闭 B
doc.querySelectorAll('.pc-btn')[8].click(); // 关闭 G#（重新渲染后重新查询）
const errBox = doc.querySelector('.error-box')?.textContent ?? '';
assert(errBox.includes('2 至 5'), `单目标时显示校验错误（${errBox.trim()}）`);

// 9. 切到 4 弦贝斯预设后弦数变为 4
const presetSel = doc.querySelector('select');
presetSel.value = '5'; // 四弦贝斯
presetSel.dispatchEvent(new dom.window.Event('change'));
assert(doc.querySelectorAll('.string-row').length === 4, '切换贝斯预设后为 4 根弦');
assert(doc.querySelectorAll('line.fb-string').length === 4, '指板变为 4 根弦');

assert(errors.length === 0, `无未捕获错误（${errors.join('; ')}）`);
console.log(process.exitCode ? '\n冒烟测试失败' : '\n全部冒烟断言通过');
