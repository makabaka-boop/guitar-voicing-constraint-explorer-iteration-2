import './style.css';
import { renderFretboard } from './fretboard';
import {
  EXCLUSION_REASONS,
  bestFingering,
  evaluateShape,
  midiName,
  pcName,
  pcOfMidi,
  reasonDescription,
  reasonLabel,
  searchChords,
  validateInput,
  type ChordResult,
  type SearchOutput,
  type Shape,
  type ShapeEvaluation,
} from './search';

/* ---------------------------------- 状态 ---------------------------------- */

interface TuningPreset {
  label: string;
  tuning: number[];
}

const PRESETS: TuningPreset[] = [
  { label: '标准吉他 E A D G B E', tuning: [40, 45, 50, 55, 59, 64] },
  { label: '降全音 D G C F A D', tuning: [38, 43, 48, 53, 57, 62] },
  { label: 'Drop D（D A D G B E）', tuning: [38, 45, 50, 55, 59, 64] },
  { label: 'DADGAD', tuning: [38, 45, 50, 55, 57, 62] },
  { label: '开放 G（D G D G B D）', tuning: [38, 43, 50, 55, 59, 62] },
  { label: '四弦贝斯 E A D G', tuning: [28, 33, 38, 43] },
  { label: '五弦贝斯 B E A D G', tuning: [23, 28, 33, 38, 43] },
  { label: '尤克里里 G C E A（复弦定弦）', tuning: [67, 60, 64, 69] },
  { label: '曼陀林 G D A E', tuning: [67, 74, 81, 88] },
];

const QUALITIES: { label: string; offs: number[] }[] = [
  { label: '大三', offs: [0, 4, 7] },
  { label: '小三', offs: [0, 3, 7] },
  { label: '五度', offs: [0, 7] },
  { label: 'sus4', offs: [0, 5, 7] },
  { label: 'dim', offs: [0, 3, 6] },
  { label: 'maj7', offs: [0, 4, 7, 11] },
  { label: '属七', offs: [0, 4, 7, 10] },
  { label: 'm7', offs: [0, 3, 7, 10] },
  { label: 'add9', offs: [0, 4, 7, 2] },
  { label: '9', offs: [0, 4, 7, 10, 2] },
];

const state = {
  tuning: [40, 45, 50, 55, 59, 64],
  targets: new Set<number>([4, 8, 11]), // E 大三
  maxFret: 5,
  preferFlat: false,
  allowBarre: false,
  rootPc: 4,
  output: null as SearchOutput | null,
  selected: 0,
  mode: 'preview' as 'preview' | 'custom',
  custom: [-1, -1, -1, -1, -1, -1] as Shape,
  error: null as string | null,
};

/* --------------------------------- 左：控制 -------------------------------- */

const app = document.querySelector<HTMLDivElement>('#app')!;
const left = document.createElement('section');
left.className = 'panel';
const right = document.createElement('section');
app.append(left, right);

function buildControls(): void {
  left.innerHTML = '';
  left.appendChild(h2('定弦'));

  // 预设 + 弦数
  const presetField = div('field');
  presetField.appendChild(label('定弦预设'));
  const presetRow = div('row-inline');
  const presetSel = document.createElement('select');
  for (const [i, p] of PRESETS.entries()) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.label;
    presetSel.appendChild(o);
  }
  presetSel.value = '0';
  presetSel.addEventListener('change', () => {
    const p = PRESETS[Number(presetSel.value)];
    state.tuning = p.tuning.slice();
    buildControls();
    run();
  });
  presetRow.appendChild(presetSel);

  const countSel = document.createElement('select');
  for (const c of [4, 5, 6]) {
    const o = document.createElement('option');
    o.value = String(c);
    o.textContent = `${c} 弦`;
    countSel.appendChild(o);
  }
  countSel.value = String(state.tuning.length);
  countSel.addEventListener('change', () => {
    const n = Number(countSel.value);
    // 保留低弦；新弦用相邻五度填充，长度为 n
    const fallback = [40, 45, 50, 55, 59, 64];
    const cur = state.tuning;
    const next: number[] = [];
    for (let i = 0; i < n; i++) next.push(cur[i] ?? fallback[i] ?? 64);
    state.tuning = next;
    buildControls();
    run();
  });
  presetRow.appendChild(countSel);
  presetField.appendChild(presetRow);
  left.appendChild(presetField);

  // 每弦 MIDI
  const stringsField = div('field');
  stringsField.appendChild(label('各弦开放 MIDI（低音弦 → 高音弦）'));
  state.tuning.forEach((midi, s) => {
    const row = div('string-row');
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `弦 ${s + 1}`;
    const name = document.createElement('span');
    name.className = 'open-name';
    name.textContent = `= ${midiName(midi, state.preferFlat)}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '21';
    input.max = '108';
    input.value = String(midi);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isInteger(v)) {
        state.tuning[s] = v;
        name.textContent = `= ${midiName(v, state.preferFlat)}`;
        run();
      }
    });
    row.append(idx, name, input);
    stringsField.appendChild(row);
  });
  left.appendChild(stringsField);

  // 目标音级
  const pcField = div('field');
  const pcLabel = div('field-label');
  pcLabel.textContent = '目标音级（选 2–5 个，只允许弹响这些音级）';
  pcField.appendChild(pcLabel);

  const rootRow = div('row-inline');
  rootRow.style.marginBottom = '8px';
  rootRow.appendChild(document.createTextNode('快速设置：根音'));
  const rootSel = document.createElement('select');
  for (let pc = 0; pc < 12; pc++) {
    const o = document.createElement('option');
    o.value = String(pc);
    o.textContent = pcName(pc, state.preferFlat);
    rootSel.appendChild(o);
  }
  rootSel.value = String(state.rootPc);
  rootSel.addEventListener('change', () => {
    state.rootPc = Number(rootSel.value);
  });
  rootRow.appendChild(rootSel);
  for (const q of QUALITIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = q.label;
    b.addEventListener('click', () => {
      state.targets = new Set(q.offs.map((o) => (state.rootPc + o) % 12));
      buildControls();
      run();
    });
    rootRow.appendChild(b);
  }
  pcField.appendChild(rootRow);

  const grid = div('pc-grid');
  for (let pc = 0; pc < 12; pc++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pc-btn' + (state.targets.has(pc) ? ' on' : '');
    b.textContent = pcName(pc, state.preferFlat);
    b.addEventListener('click', () => {
      if (state.targets.has(pc)) state.targets.delete(pc);
      else state.targets.add(pc);
      buildControls();
      run();
    });
    grid.appendChild(b);
  }
  pcField.appendChild(grid);

  const hint = div('count-hint');
  const k = state.targets.size;
  hint.textContent = `已选 ${k} 个目标音级（需要 2–5 个）`;
  if (k < 2 || k > 5) hint.classList.add('warn');
  pcField.appendChild(hint);
  left.appendChild(pcField);

  // 最大品位
  const fretField = div('field');
  fretField.appendChild(label('最大品位（3–9）'));
  const fretRow = div('row-inline');
  const fretSel = document.createElement('select');
  for (let f = 3; f <= 9; f++) {
    const o = document.createElement('option');
    o.value = String(f);
    o.textContent = `${f} 品`;
    fretSel.appendChild(o);
  }
  fretSel.value = String(state.maxFret);
  fretSel.addEventListener('change', () => {
    state.maxFret = Number(fretSel.value);
    if (state.mode === 'custom') {
      state.custom = state.custom.map((f) => (f > state.maxFret ? -1 : f));
    }
    run();
  });
  fretRow.appendChild(fretSel);

  const flatLabel = document.createElement('label');
  flatLabel.style.display = 'flex';
  flatLabel.style.alignItems = 'center';
  flatLabel.style.gap = '5px';
  flatLabel.style.color = 'var(--muted)';
  flatLabel.style.fontSize = '12px';
  const flatCb = document.createElement('input');
  flatCb.type = 'checkbox';
  flatCb.checked = state.preferFlat;
  flatCb.addEventListener('change', () => {
    state.preferFlat = flatCb.checked;
    buildControls();
    renderRight();
  });
  flatLabel.append(flatCb, document.createTextNode('优先显示降号音名'));
  fretRow.appendChild(flatLabel);

  const barreLabel = document.createElement('label');
  barreLabel.style.display = 'flex';
  barreLabel.style.alignItems = 'center';
  barreLabel.style.gap = '5px';
  barreLabel.style.color = 'var(--muted)';
  barreLabel.style.fontSize = '12px';
  const barreCb = document.createElement('input');
  barreCb.type = 'checkbox';
  barreCb.id = 'barre-toggle';
  barreCb.checked = state.allowBarre;
  barreCb.addEventListener('change', () => {
    state.allowBarre = barreCb.checked;
    buildControls();
    run();
  });
  barreLabel.append(barreCb, document.createTextNode('单横按指法模式'));
  fretRow.appendChild(barreLabel);
  fretField.appendChild(fretRow);
  left.appendChild(fretField);

  // 约束说明
  const rules = div('help');
  rules.innerHTML = state.allowBarre
    ? '固定约束：弹响 ≥ 3 根 · 最优指法 ≤ 4 指（一枚横按算 1 指，覆盖一段相邻琴弦）· ' +
      '非零品位跨度 ≤ 4（无按弦算 0）· 每弦闷音 x 或 0–最大品'
    : '固定约束：弹响 ≥ 3 根 · 按弦 ≤ 4 指（不计横按）· ' +
      '非零品位跨度 ≤ 4（无按弦算 0）· 每弦闷音 x 或 0–最大品';
  left.appendChild(rules);
}

function h2(text: string): HTMLHeadingElement {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}
function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
function label(text: string): HTMLLabelElement {
  const l = document.createElement('label');
  l.textContent = text;
  return l;
}

/* --------------------------------- 搜索运行 -------------------------------- */

function run(): void {
  const issues = validateInput({
    tuning: state.tuning,
    targets: [...state.targets],
    maxFret: state.maxFret,
  });
  if (issues.length > 0) {
    state.error = issues.map((i) => `• ${i.message}`).join('\n');
    state.output = null;
  } else {
    state.error = null;
    state.output = searchChords({
      tuning: state.tuning,
      targets: [...state.targets],
      maxFret: state.maxFret,
      allowBarre: state.allowBarre,
    });
    state.selected = Math.min(state.selected, Math.max(0, state.output.results.length - 1));
  }
  // 自定义形状长度跟随弦数
  if (state.custom.length !== state.tuning.length) {
    state.custom = state.tuning.map((_, s) => state.custom[s] ?? -1);
  }
  renderRight();
}

/* -------------------------------- 右：结果+指板 ------------------------------- */

function renderRight(): void {
  right.innerHTML = '';

  if (state.error) {
    const err = div('error-box');
    err.textContent = state.error;
    right.appendChild(err);
  }

  right.appendChild(renderFretboardPanel());
  renderResultsPanel();
  renderExclusionsPanel();
}

function renderFretboardPanel(): HTMLElement {
  const panel = div('panel');
  panel.appendChild(h2('指板预览'));

  const tabs = div('tabs');
  const tabPreview = document.createElement('button');
  tabPreview.type = 'button';
  tabPreview.className = 'ghost' + (state.mode === 'preview' ? ' on' : '');
  tabPreview.textContent = '预览结果';
  tabPreview.addEventListener('click', () => {
    state.mode = 'preview';
    renderRight();
  });
  const tabCustom = document.createElement('button');
  tabCustom.type = 'button';
  tabCustom.className = 'ghost' + (state.mode === 'custom' ? ' on' : '');
  tabCustom.textContent = '自定义形状（点击指板）';
  tabCustom.addEventListener('click', () => {
    // 进入自定义时从当前选中结果复制，便于在其基础上修改
    if (state.output && state.output.results[state.selected]) {
      state.custom = state.output.results[state.selected].shape.slice();
    }
    state.mode = 'custom';
    renderRight();
  });
  tabs.append(tabPreview, tabCustom);
  panel.appendChild(tabs);

  const board = div('fretboard-wrap');
  panel.appendChild(board);

  if (state.mode === 'preview') {
    const r = state.output?.results[state.selected];
    if (r) {
      renderFretboard(board, {
        tuning: state.tuning,
        maxFret: state.maxFret,
        shape: r.shape,
        targetPcs: [...state.targets],
        editable: false,
        preferFlat: state.preferFlat,
        barre: r.barre ?? null,
      });
      panel.appendChild(renderEvalOk(r));
    } else {
      renderEmptyBoard(board);
    }
  } else {
    // 自定义形状与评估共用同一次指法结论（含横按）
    const ev = evaluateShape(state.custom, state.tuning, [...state.targets], {
      allowBarre: state.allowBarre,
    });
    renderFretboard(board, {
      tuning: state.tuning,
      maxFret: state.maxFret,
      shape: state.custom,
      targetPcs: [...state.targets],
      editable: true,
      preferFlat: state.preferFlat,
      barre: ev.barre ?? null,
      onToggle: (s, fret) => {
        const cur = state.custom[s];
        if (fret === 0) {
          // 琴枕上方：闷音 x ↔ 开放 0
          state.custom[s] = cur === -1 ? 0 : cur > 0 ? 0 : -1;
        } else {
          // 品丝格：再点同一品取消为闷音
          state.custom[s] = cur === fret ? -1 : fret;
        }
        renderRight();
      },
    });
    panel.appendChild(renderEvalCustom(ev));
    const help = div('help');
    help.textContent = '点击格子按下/取消该品；点击琴枕上方区域在开放 0 与闷音 x 之间切换。';
    panel.appendChild(help);
  }

  return panel;
}

function renderEmptyBoard(board: HTMLElement): void {
  renderFretboard(board, {
    tuning: state.tuning,
    maxFret: state.maxFret,
    shape: state.tuning.map(() => -1),
    targetPcs: [...state.targets],
    editable: false,
    preferFlat: state.preferFlat,
  });
}

function statsLine(r: { span: number; fretSum: number; fingers: number; ringing: number }): string {
  return `跨度 ${r.span} · 品位总和 ${r.fretSum} · 手指 ${r.fingers} · 响弦 ${r.ringing}`;
}

/** 横按结论的一行描述（仅横按模式下调用）。 */
function barreLine(barre: { fret: number; from: number; to: number } | null, fingers: number): string {
  return barre
    ? `指法：${barre.fret} 品单指横按弦 ${barre.from + 1}–${barre.to + 1}，共 ${fingers} 指`
    : `指法：无需横按，共 ${fingers} 指`;
}

function renderEvalOk(r: ChordResult): HTMLElement {
  const box = div('eval-box ok');
  const title = div('eval-title');
  title.textContent = `✓ 合法形状 #${state.selected + 1}（${statsLine(r)}）`;
  box.appendChild(title);
  const detail = div('eval-detail');
  const notes = r.midi
    .map((m) => (m === null ? 'x' : midiName(m, state.preferFlat)))
    .join('  ');
  const lines = [
    `低音 → 高音：<b>${notes}</b>`,
    `排序键：(跨度 ${r.span}, 总和 ${r.fretSum}, 形状向量 [${r.shape
      .map((f) => (f === -1 ? 'x' : f))
      .join(',')}])，闷音 x 在字典序中排在所有品位之后`,
  ];
  if (state.allowBarre) lines.push(barreLine(r.barre ?? null, r.fingers));
  detail.innerHTML = lines.join('<br/>');
  box.appendChild(detail);
  return box;
}

function renderEvalCustom(ev: ShapeEvaluation): HTMLElement {
  const box = div('eval-box ' + (ev.valid ? 'ok' : 'bad'));
  const title = div('eval-title');
  title.textContent = ev.valid
    ? `✓ 该形状合法（${statsLine(ev)}）`
    : `✗ 被排除：${ev.reason ? reasonLabel(ev.reason, state.allowBarre) : ''}`;
  box.appendChild(title);
  const detail = div('eval-detail');
  const lines: string[] = [];
  lines.push(`<b>跨度 ${ev.span} · 品位总和 ${ev.fretSum} · 手指 ${ev.fingers} · 响弦 ${ev.ringing}</b>`);

  const notes = ev.midi
    .map((m, s) => (m === null ? 'x' : midiName(m, state.preferFlat) + pcSuffix(state.custom[s])))
    .join('  ');
  lines.push(`低音 → 高音：${notes}`);

  if (state.allowBarre) lines.push(barreLine(ev.barre ?? null, ev.fingers));
  if (ev.outsidePcs.length > 0) {
    lines.push(
      `出现目标外音级：${ev.outsidePcs.map((p) => pcName(p, state.preferFlat)).join('、')}`,
    );
  }
  if (ev.missingPcs.length > 0) {
    lines.push(
      `尚缺目标音级：${ev.missingPcs.map((p) => pcName(p, state.preferFlat)).join('、')}`,
    );
  }
  if (ev.reason) lines.push(reasonDescription(ev.reason, state.allowBarre));
  lines.push(
    state.allowBarre
      ? '判定按 响弦 → 目标外音 → 覆盖 → 跨度 → 最优指法手指数 顺序，只报告命中的第一条。'
      : '判定按 响弦 → 目标外音 → 覆盖 → 手指数 → 跨度 顺序，只报告命中的第一条。',
  );
  detail.innerHTML = lines.join('<br/>');
  box.appendChild(detail);
  return box;
}

function pcSuffix(fret: number): string {
  return fret === 0 ? '(开)' : '';
}

function renderResultsPanel(): void {
  if (!state.output) return;
  const panel = div('panel');
  const head = div('results-head');
  head.appendChild(h2(`搜索结果（前 ${state.output.results.length} 个）`));
  const stats = document.createElement('span');
  stats.className = 'stats';
  stats.textContent = state.output.truncated
    ? `合法 ${state.output.valid} 个，仅显示前 20；枚举 ${state.output.total} 个方案`
    : `合法 ${state.output.valid} / 枚举 ${state.output.total} 个方案`;
  head.appendChild(stats);
  panel.appendChild(head);

  if (state.output.results.length === 0) {
    const empty = div('help');
    empty.textContent = '没有满足全部约束的形状。可放宽最大品位、调整目标音级，或在自定义模式查看具体排除原因。';
    panel.appendChild(empty);
    right.appendChild(panel);
    return;
  }

  state.output.results.forEach((r, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'result-item' + (state.mode === 'preview' && i === state.selected ? ' active' : '');
    const rank = document.createElement('span');
    rank.className = 'result-rank';
    rank.textContent = `#${i + 1}`;
    const chips = div('shape-chips');
    r.shape.forEach((f) => {
      const c = document.createElement('span');
      c.className = 'chip ' + (f === -1 ? 'x' : f === 0 ? 'f0' : 'pressed');
      c.textContent = f === -1 ? 'x' : String(f);
      chips.appendChild(c);
    });
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent =
      `跨${r.span} Σ${r.fretSum} 指${r.fingers} 响${r.ringing}` +
      (r.barre ? ` 横${r.barre.fret}品` : '');
    item.append(rank, chips, meta);
    item.addEventListener('click', () => {
      state.selected = i;
      state.mode = 'preview';
      renderRight();
    });
    panel.appendChild(item);
  });
  right.appendChild(panel);
}

function renderExclusionsPanel(): void {
  if (!state.output) return;
  const panel = div('panel exclusions');
  const h = document.createElement('h3');
  h.textContent = `排除原因统计（其余 ${state.output.valid.toLocaleString()} 个合法；方案互不重复计数）`;
  panel.appendChild(h);
  for (const reason of EXCLUSION_REASONS) {
    const row = div('exc-row');
    const name = document.createElement('span');
    name.textContent = reasonLabel(reason, state.allowBarre);
    const count = document.createElement('span');
    count.className = 'exc-count';
    count.textContent = `${state.output.excluded[reason].toLocaleString()} 个`;
    const desc = document.createElement('span');
    desc.className = 'exc-desc';
    desc.textContent = reasonDescription(reason, state.allowBarre);
    row.append(name, count, desc);
    panel.appendChild(row);
  }
  right.appendChild(panel);
}

/* ---------------------------------- 启动 ---------------------------------- */

buildControls();
run();

// 供控制台手工探索
declare global {
  interface Window {
    __fret: {
      searchChords: typeof searchChords;
      evaluateShape: typeof evaluateShape;
      bestFingering: typeof bestFingering;
      pcOfMidi: typeof pcOfMidi;
    };
  }
}
window.__fret = { searchChords, evaluateShape, bestFingering, pcOfMidi };
