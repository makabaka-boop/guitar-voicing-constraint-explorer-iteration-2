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
  searchTransitions,
  validateInput,
  type ChordResult,
  type SearchOutput,
  type Shape,
  type ShapeEvaluation,
  type TransitionCandidate,
  type TransitionOutput,
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
  // 双和弦切换预演：anchor 为起点形状快照；tr 为当前预演结果（失效时撤销为 null）。
  anchor: null as Shape | null,
  nextTargets: new Set<number>([4, 8, 11]),
  tr: null as TransitionOutput | null,
  trSelected: 0,
  viewing: false,
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
  presetSel.id = 'preset-select';
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
  countSel.id = 'string-count-select';
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
  rootSel.id = 'root-select';
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
  grid.id = 'main-pc-grid';
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
  fretSel.id = 'max-fret-select';
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
    // 首次得到合法结果时，自动把起点锚定为排名第一的形状，便于立即预演切换。
    if (state.anchor === null && state.output.results.length > 0) {
      state.anchor = state.output.results[0].shape.slice();
    }
  }
  // 自定义形状长度跟随弦数
  if (state.custom.length !== state.tuning.length) {
    state.custom = state.tuning.map((_, s) => state.custom[s] ?? -1);
  }
  refreshTransition();
  renderRight();
}

/**
 * 重新计算（或撤销）双和弦切换预演。
 * 预演只在以下条件全部成立时存在：
 *  - 单和弦输入合法、anchor 与当前弦数一致且品位在最大品位内；
 *  - anchor 在当前定弦、目标音级、最大品位与横按模式下仍合法
 *    （合法性由 evaluateShape 判定，而不是由预演列表自行假设）；
 *  - 下一和弦目标音级数量为 2..5。
 * 任一条件因定弦、模式或输入编辑而被破坏时，撤销预演（state.tr = null），
 * 单和弦功能不受影响。
 */
function refreshTransition(): void {
  state.viewing = false;
  const anchor = state.anchor;
  if (!state.output || !anchor || anchor.length !== state.tuning.length) {
    state.tr = null;
    return;
  }
  if (!anchor.every((f) => Number.isInteger(f) && f >= -1 && f <= state.maxFret)) {
    state.tr = null;
    return;
  }
  const anchorEv = evaluateShape(anchor, state.tuning, [...state.targets], {
    allowBarre: state.allowBarre,
  });
  if (!anchorEv.valid || state.nextTargets.size < 2 || state.nextTargets.size > 5) {
    state.tr = null;
    return;
  }
  state.tr = searchTransitions({
    tuning: state.tuning,
    current: anchor,
    nextTargets: [...state.nextTargets],
    maxFret: state.maxFret,
    allowBarre: state.allowBarre,
  });
  state.trSelected = Math.min(state.trSelected, Math.max(0, state.tr.candidates.length - 1));
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
  renderTransitionPanel();
  renderExclusionsPanel();
}

function renderFretboardPanel(): HTMLElement {
  const panel = div('panel');
  panel.appendChild(h2('指板预览'));

  const tabs = div('tabs');
  const tabPreview = document.createElement('button');
  tabPreview.type = 'button';
  tabPreview.className = 'ghost' + (state.mode === 'preview' && !state.viewing ? ' on' : '');
  tabPreview.textContent = '预览结果';
  tabPreview.addEventListener('click', () => {
    state.mode = 'preview';
    state.viewing = false;
    renderRight();
  });
  // 仅在预演有效时可切换到切换预览。
  const tabTransition = document.createElement('button');
  tabTransition.type = 'button';
  tabTransition.className = 'ghost' + (state.mode === 'preview' && state.viewing ? ' on' : '');
  tabTransition.textContent = '双和弦切换预览';
  tabTransition.disabled = !state.tr || state.tr.candidates.length === 0;
  tabTransition.addEventListener('click', () => {
    state.mode = 'preview';
    state.viewing = true;
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
    state.viewing = false;
    renderRight();
  });
  tabs.append(tabPreview, tabTransition, tabCustom);
  panel.appendChild(tabs);

  const board = div('fretboard-wrap');
  panel.appendChild(board);

  if (state.mode === 'custom') {
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
    return panel;
  }

  if (state.viewing) {
    const cand = state.tr?.candidates[state.trSelected];
    if (cand) {
      // 横按结论直接取自枚举结果（cand.result.barre），SVG 不另行重算。
      renderFretboard(board, {
        tuning: state.tuning,
        maxFret: state.maxFret,
        shape: cand.result.shape,
        targetPcs: [...state.nextTargets],
        editable: false,
        preferFlat: state.preferFlat,
        barre: cand.result.barre ?? null,
        changes: cand.changes,
      });
      panel.appendChild(renderEvalTransition(cand));
      return panel;
    }
    // 预演在查看途中被撤销（定弦/模式/输入编辑）：退回单和弦预览。
    state.viewing = false;
  }

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

  return panel;
}

/** 切换候选的合法性/代价评估框（横按与逐弦变化均直接取自候选结论）。 */
function renderEvalTransition(cand: TransitionCandidate): HTMLElement {
  const r = cand.result;
  const box = div('eval-box ok');
  const title = div('eval-title');
  title.textContent = `→ 下一和弦候选 #${state.trSelected + 1}（${statsLine(r)}）`;
  box.appendChild(title);
  const detail = div('eval-detail');
  const notes = r.midi
    .map((m) => (m === null ? 'x' : midiName(m, state.preferFlat)))
    .join('  ');
  const lines = [
    `低音 → 高音：<b>${notes}</b>`,
    `切换代价：闷音状态变化 <b>${cand.mutedChanges}</b> 弦 · 共同发声弦品位移动量之和 <b>${cand.fretMove}</b>`,
    `下一形状排序兜底：跨度 ${r.span} · 总和 ${r.fretSum} · 形状向量 [${r.shape
      .map((f) => (f === -1 ? 'x' : f))
      .join(',')}]`,
  ];
  if (state.allowBarre) lines.push(barreLine(r.barre ?? null, r.fingers));
  lines.push('排序：闷音变化弦数 → 共同发声品位移动量 → 跨度 → 品位总和 → 形状向量');
  detail.innerHTML = lines.join('<br/>');
  box.appendChild(detail);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'ghost';
  back.style.marginTop = '8px';
  back.textContent = '返回当前和弦预览';
  back.addEventListener('click', () => {
    state.viewing = false;
    renderRight();
  });
  box.appendChild(back);
  return box;
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
    item.className =
      'result-item' +
      (state.mode === 'preview' && !state.viewing && i === state.selected ? ' active' : '') +
      (state.anchor && shapeEq(state.anchor, r.shape) ? ' anchor' : '');
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
      (r.barre ? ` 横${r.barre.fret}品` : '') +
      (state.anchor && shapeEq(state.anchor, r.shape) ? ' · 切换起点' : '');
    item.append(rank, chips, meta);
    item.addEventListener('click', () => {
      state.selected = i;
      state.mode = 'preview';
      state.viewing = false;
      // 点击结果即把切换起点锚定为该形状快照。
      state.anchor = r.shape.slice();
      refreshTransition();
      renderRight();
    });
    panel.appendChild(item);
  });
  right.appendChild(panel);
}

function shapeEq(a: Shape, b: Shape): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/* ----------------------------- 双和弦切换预演面板 ----------------------------- */

function renderTransitionPanel(): void {
  if (!state.output) return;
  const panel = div('panel transition-panel');
  const head = div('results-head');
  const h = document.createElement('h2');
  h.textContent = '双和弦切换预演';
  head.appendChild(h);
  panel.appendChild(head);

  const help = div('help');
  help.textContent =
    '从上方结果点击选定当前和弦形状作为起点，再选下一和弦目标音级；' +
    '对全部合法下一形状排序：闷音状态变化弦数 → 共同发声弦品位移动量之和 → ' +
    '跨度 → 品位总和 → 形状向量。';
  panel.appendChild(help);

  // 起点形状
  const anchorRow = div('row-inline');
  anchorRow.style.margin = '8px 0';
  const anchorLabel = document.createElement('span');
  anchorLabel.className = 'stats';
  anchorLabel.textContent = '当前形状：';
  anchorRow.appendChild(anchorLabel);
  const anchorChips = div('shape-chips');
  anchorChips.classList.add('anchor-chips');
  const anchor = state.anchor;
  if (anchor) {
    anchor.forEach((f) => {
      const c = document.createElement('span');
      c.className = 'chip ' + (f === -1 ? 'x' : f === 0 ? 'f0' : 'pressed');
      c.textContent = f === -1 ? 'x' : String(f);
      anchorChips.appendChild(c);
    });
  } else {
    const none = document.createElement('span');
    none.className = 'stats';
    none.textContent = '尚未选择（点击搜索结果中的形状）';
    anchorChips.appendChild(none);
  }
  anchorRow.appendChild(anchorChips);
  panel.appendChild(anchorRow);

  // 起点合法性：由 evaluateShape 对当前定弦/目标/模式给出唯一结论。
  if (anchor) {
    let anchorMsg: string;
    let msgCls = 'help';
    if (anchor.length !== state.tuning.length || !anchor.every((f) => f >= -1 && f <= state.maxFret)) {
      anchorMsg = '当前形状因定弦弦数或最大品位变化已不再适用，切换预演已撤销；请从结果中重新点击一个形状作为起点。';
      msgCls = 'transition-banner bad';
    } else {
      const ev = evaluateShape(anchor, state.tuning, [...state.targets], {
        allowBarre: state.allowBarre,
      });
      if (ev.valid) {
        anchorMsg = '起点形状在当前定弦、约束与指法模式下合法，可预演切换。';
        msgCls = 'transition-banner ok';
      } else {
        anchorMsg = `当前形状在现有定弦/指法模式下已不合法（${ev.reason ? reasonLabel(ev.reason, state.allowBarre) : ''}），切换预演已撤销；单和弦搜索仍可正常使用。`;
        msgCls = 'transition-banner bad';
      }
    }
    const banner = div(msgCls);
    banner.textContent = anchorMsg;
    panel.appendChild(banner);
  }

  // 下一和弦目标音级
  const pcField = div('field');
  const pcLabel = div('field-label');
  pcLabel.textContent = '下一和弦目标音级（选 2–5 个）';
  pcField.appendChild(pcLabel);
  const grid = div('pc-grid');
  grid.id = 'next-pc-grid';
  for (let pc = 0; pc < 12; pc++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pc-btn' + (state.nextTargets.has(pc) ? ' on' : '');
    b.textContent = pcName(pc, state.preferFlat);
    b.addEventListener('click', () => {
      if (state.nextTargets.has(pc)) state.nextTargets.delete(pc);
      else state.nextTargets.add(pc);
      refreshTransition();
      renderRight();
    });
    grid.appendChild(b);
  }
  pcField.appendChild(grid);
  const hint = div('count-hint');
  const k = state.nextTargets.size;
  hint.textContent = `已选 ${k} 个下一和弦目标音级（需要 2–5 个）`;
  if (k < 2 || k > 5) hint.classList.add('warn');
  pcField.appendChild(hint);
  panel.appendChild(pcField);

  // 预演结果或撤销原因
  if (state.tr) {
    const tr = state.tr;
    const stat = div('stats');
    stat.textContent = tr.truncated
      ? `合法下一形状 ${tr.valid} 个，仅显示切换代价最小的前 20；枚举 ${tr.total} 个方案`
      : `合法下一形状 ${tr.valid} / 枚举 ${tr.total} 个方案`;
    panel.appendChild(stat);

    if (tr.candidates.length === 0) {
      const empty = div('transition-banner bad');
      empty.textContent = '没有合法的下一和弦形状（空结果）。可调整下一和弦目标音级或放宽最大品位。';
      panel.appendChild(empty);
    } else {
      const list = div('transition-list');
      tr.candidates.forEach((cand, i) => {
        list.appendChild(renderTransitionItem(cand, i));
      });
      panel.appendChild(list);
    }
  } else if (anchor && anchor.length === state.tuning.length && anchor.every((f) => f >= -1 && f <= state.maxFret)) {
    // 锚点结构仍适用但预演撤销：下一目标数量不对，或锚点在当前模式下不再合法
    // （具体原因横幅已在上方由 evaluateShape 给出）。这里补充输入侧提示。
    if (state.nextTargets.size < 2 || state.nextTargets.size > 5) {
      const why = div('transition-banner bad');
      why.textContent = `下一和弦目标音级需选 2–5 个（当前 ${state.nextTargets.size} 个），切换预演暂不可用。`;
      panel.appendChild(why);
    }
  } else {
    const why = div('transition-banner bad');
    why.textContent = '切换预演未激活：请在上方结果中点击一个当前仍合法的形状作为起点。';
    panel.appendChild(why);
  }

  right.appendChild(panel);
}

function renderTransitionItem(cand: TransitionCandidate, i: number): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className =
    'result-item transition-item' + (state.viewing && i === state.trSelected ? ' active' : '');
  const rank = document.createElement('span');
  rank.className = 'result-rank';
  rank.textContent = `#${i + 1}`;

  const body = div('transition-body');
  // 下一形状品位
  const chips = div('shape-chips');
  cand.result.shape.forEach((f) => {
    const c = document.createElement('span');
    c.className = 'chip ' + (f === -1 ? 'x' : f === 0 ? 'f0' : 'pressed');
    c.textContent = f === -1 ? 'x' : String(f);
    chips.appendChild(c);
  });
  body.appendChild(chips);

  // 逐弦变化：起点 → 下一，颜色按 闷音变化 / 共同发声移动 / 不动 区分
  const changes = div('transition-changes');
  cand.changes.forEach((ch) => {
    const cell = document.createElement('span');
    cell.className =
      'tr-cell ' + (ch.mutedChange ? 'mute' : ch.fretMove > 0 ? 'move' : 'hold');
    const fv = (f: number) => (f === -1 ? 'x' : String(f));
    cell.textContent = `${fv(ch.from)}→${fv(ch.to)}`;
    changes.appendChild(cell);
  });
  body.appendChild(changes);

  const meta = document.createElement('span');
  meta.className = 'result-meta';
  meta.textContent =
    `闷变${cand.mutedChanges} 移动${cand.fretMove}` +
    ` 跨${cand.result.span} Σ${cand.result.fretSum} 指${cand.result.fingers}` +
    (cand.result.barre ? ` 横${cand.result.barre.fret}品` : '');

  item.append(rank, body, meta);
  item.addEventListener('click', () => {
    state.trSelected = i;
    state.mode = 'preview';
    state.viewing = true;
    renderRight();
  });
  return item;
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
      searchTransitions: typeof searchTransitions;
      evaluateShape: typeof evaluateShape;
      bestFingering: typeof bestFingering;
      pcOfMidi: typeof pcOfMidi;
    };
  }
}
window.__fret = { searchChords, searchTransitions, evaluateShape, bestFingering, pcOfMidi };
