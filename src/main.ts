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
  type TransitionOutput,
  type TransitionResult,
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

/** 双和弦切换预演状态：起点形状快照 + 下一和弦目标音级 + 求解输出。 */
interface TransitionState {
  /** 起点形状（激活时的快照，不随后续编辑改变）。 */
  from: Shape;
  /** 起点来源描述（如「结果 #3」「自定义形状」）。 */
  fromLabel: string;
  /** 下一和弦目标音级。 */
  targets: Set<number>;
  /** 下一和弦快速设置的根音。 */
  rootPc: number;
  output: TransitionOutput | null;
  error: string | null;
  /** 选中的下一形状下标。 */
  selected: number;
}

const state = {
  tuning: [40, 45, 50, 55, 59, 64],
  targets: new Set<number>([4, 8, 11]), // E 大三
  maxFret: 5,
  preferFlat: false,
  allowBarre: false,
  rootPc: 4,
  output: null as SearchOutput | null,
  selected: 0,
  mode: 'preview' as 'preview' | 'custom' | 'transition',
  custom: [-1, -1, -1, -1, -1, -1] as Shape,
  transition: null as TransitionState | null,
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
  syncTransition();
  renderRight();
}

/* ------------------------------ 双和弦切换预演 ------------------------------ */

/** 激活切换预演：以 from 为起点，下一和弦目标默认沿用当前目标音级。 */
function startTransition(from: Shape, fromLabel: string): void {
  state.transition = {
    from: from.slice(),
    fromLabel,
    targets: new Set(state.targets),
    rootPc: state.rootPc,
    output: null,
    error: null,
    selected: 0,
  };
  state.mode = 'transition';
  runTransition();
  renderRight();
}

/** 退出切换预演，回到单和弦功能。 */
function exitTransition(nextMode: 'preview' | 'custom' = 'preview'): void {
  state.transition = null;
  state.mode = nextMode;
}

/** 求解切换预演（下一和弦目标或约束变化后重算）。 */
function runTransition(): void {
  const t = state.transition;
  if (!t) return;
  const issues = validateInput({
    tuning: state.tuning,
    targets: [...t.targets],
    maxFret: state.maxFret,
  });
  if (issues.length > 0) {
    t.error = issues.map((i) => `• ${i.message}`).join('\n');
    t.output = null;
  } else {
    t.error = null;
    t.output = searchTransitions({
      tuning: state.tuning,
      from: t.from,
      targets: [...t.targets],
      maxFret: state.maxFret,
      allowBarre: state.allowBarre,
    });
    t.selected = Math.min(t.selected, Math.max(0, t.output.results.length - 1));
  }
}

/**
 * 每次单和弦输入变化后调用：起点形状必须仍是当前定弦、模式与
 * 输入下的合法形状；不再合法时撤销切换预演（单和弦功能不受影响），
 * 仍合法则按新约束重算切换结果。
 */
function syncTransition(): void {
  const t = state.transition;
  if (!t) return;
  const usable =
    !state.error &&
    t.from.length === state.tuning.length &&
    t.from.every((f) => f >= -1 && f <= state.maxFret) &&
    evaluateShape(t.from, state.tuning, [...state.targets], {
      allowBarre: state.allowBarre,
    }).valid;
  if (!usable) {
    // 起点不再合法：撤销预演并回到单和弦预览。
    exitTransition('preview');
    return;
  }
  runTransition();
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
  if (state.transition && state.mode === 'transition') renderTransitionPanel();
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
    exitTransition('preview');
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
    exitTransition('custom');
    renderRight();
  });
  tabs.append(tabPreview, tabCustom);
  if (state.transition) {
    const tabTransition = document.createElement('button');
    tabTransition.type = 'button';
    tabTransition.className = 'ghost' + (state.mode === 'transition' ? ' on' : '');
    tabTransition.textContent = '切换预演';
    tabTransition.addEventListener('click', () => {
      state.mode = 'transition';
      renderRight();
    });
    tabs.appendChild(tabTransition);
  }
  panel.appendChild(tabs);

  const board = div('fretboard-wrap');
  panel.appendChild(board);

  if (state.mode === 'transition' && state.transition) {
    // 切换预演：起点形状画为空心标记，当前选中下一形状为实体标记；
    // 横按结论直接取搜索结果，不在此处重算。
    const t = state.transition;
    const sel = t.output?.results[t.selected] ?? null;
    renderFretboard(board, {
      tuning: state.tuning,
      maxFret: state.maxFret,
      shape: sel ? sel.result.shape : t.from,
      targetPcs: [...t.targets],
      editable: false,
      preferFlat: state.preferFlat,
      barre: sel ? (sel.result.barre ?? null) : null,
      ghostShape: t.from,
    });
    panel.appendChild(renderEvalTransition(t, sel));
  } else if (state.mode === 'preview') {
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

/** 品位值显示：闷音为 x。 */
function fmtFret(f: number): string {
  return f === -1 ? 'x' : String(f);
}

/** 形状品位格（与结果列表一致的 chips）。 */
function shapeChips(shape: Shape): HTMLElement {
  const chips = div('shape-chips');
  shape.forEach((f) => {
    const c = document.createElement('span');
    c.className = 'chip ' + (f === -1 ? 'x' : f === 0 ? 'f0' : 'pressed');
    c.textContent = fmtFret(f);
    chips.appendChild(c);
  });
  return chips;
}

/** 「以此为起点预演切换」按钮。 */
function startTransitionButton(from: Shape, fromLabel: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost transition-start';
  b.textContent = '⇄ 以此为起点预演切换';
  b.addEventListener('click', () => startTransition(from, fromLabel));
  return b;
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
  box.appendChild(startTransitionButton(r.shape, `结果 #${state.selected + 1}`));
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
  if (ev.valid) box.appendChild(startTransitionButton(state.custom, '自定义形状'));
  return box;
}

function pcSuffix(fret: number): string {
  return fret === 0 ? '(开)' : '';
}

/** 切换预演的评估框：当前选中下一形状的切换代价与逐弦变化。 */
function renderEvalTransition(t: TransitionState, sel: TransitionResult | null): HTMLElement {
  if (!sel) {
    const box = div('eval-box bad');
    const title = div('eval-title');
    title.textContent = '✗ 没有可切换到的合法下一形状';
    box.appendChild(title);
    const detail = div('eval-detail');
    detail.textContent = t.error ?? '当前约束下下一和弦没有合法形状，请调整目标音级或约束。';
    box.appendChild(detail);
    return box;
  }
  const r = sel.result;
  const box = div('eval-box ok');
  const title = div('eval-title');
  title.textContent =
    `✓ 切换目标 #${t.selected + 1}（闷音变化 ${sel.muteChanges} · 移动量 ${sel.movement} · ${statsLine(r)}）`;
  box.appendChild(title);
  const detail = div('eval-detail');
  const notes = r.midi
    .map((m) => (m === null ? 'x' : midiName(m, state.preferFlat)))
    .join('  ');
  const lines = [
    `低音 → 高音：<b>${notes}</b>`,
    `逐弦变化：${sel.changes.map((c) => `${fmtFret(c.from)}→${fmtFret(c.to)}`).join('  ')}`,
    `排序键：(闷音变化 ${sel.muteChanges}, 移动量 ${sel.movement}, 跨度 ${r.span}, 总和 ${r.fretSum}, ` +
      `形状向量 [${r.shape.map(fmtFret).join(',')}])`,
  ];
  if (state.allowBarre) lines.push(barreLine(r.barre ?? null, r.fingers));
  detail.innerHTML = lines.join('<br/>');
  box.appendChild(detail);
  return box;
}

/** 切换预演面板：起点形状、下一和弦目标音级输入与切换结果列表。 */
function renderTransitionPanel(): void {
  const t = state.transition;
  if (!t) return;
  const panel = div('panel transition-panel');

  const head = div('results-head');
  head.appendChild(h2('双和弦切换预演'));
  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'ghost transition-exit';
  exitBtn.textContent = '退出预演';
  exitBtn.addEventListener('click', () => {
    exitTransition('preview');
    renderRight();
  });
  head.appendChild(exitBtn);
  panel.appendChild(head);

  // 起点形状（快照）
  const fromRow = div('transition-from');
  const fromLabel = document.createElement('span');
  fromLabel.className = 'stats';
  fromLabel.textContent = `起点：${t.fromLabel}`;
  fromRow.append(fromLabel, shapeChips(t.from));
  panel.appendChild(fromRow);

  // 下一和弦目标音级
  const pcField = div('field');
  const pcLabel = div('field-label');
  pcLabel.textContent = '下一和弦目标音级（选 2–5 个）';
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
  rootSel.value = String(t.rootPc);
  rootSel.addEventListener('change', () => {
    t.rootPc = Number(rootSel.value);
  });
  rootRow.appendChild(rootSel);
  for (const q of QUALITIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = q.label;
    b.addEventListener('click', () => {
      t.targets = new Set(q.offs.map((o) => (t.rootPc + o) % 12));
      runTransition();
      renderRight();
    });
    rootRow.appendChild(b);
  }
  pcField.appendChild(rootRow);

  const grid = div('pc-grid');
  for (let pc = 0; pc < 12; pc++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pc-btn tpc-btn' + (t.targets.has(pc) ? ' on' : '');
    b.textContent = pcName(pc, state.preferFlat);
    b.addEventListener('click', () => {
      if (t.targets.has(pc)) t.targets.delete(pc);
      else t.targets.add(pc);
      runTransition();
      renderRight();
    });
    grid.appendChild(b);
  }
  pcField.appendChild(grid);

  const hint = div('count-hint');
  const k = t.targets.size;
  hint.textContent = `已选 ${k} 个目标音级（需要 2–5 个）`;
  if (k < 2 || k > 5) hint.classList.add('warn');
  pcField.appendChild(hint);
  panel.appendChild(pcField);

  if (t.error) {
    const err = div('error-box');
    err.textContent = t.error;
    panel.appendChild(err);
  } else if (t.output) {
    const stats = div('stats transition-stats');
    stats.textContent = t.output.truncated
      ? `合法下一形状 ${t.output.valid} 个，仅显示前 20；排序：闷音变化 → 移动量 → 跨度 → 品位总和 → 形状向量`
      : `合法下一形状 ${t.output.valid} 个；排序：闷音变化 → 移动量 → 跨度 → 品位总和 → 形状向量`;
    panel.appendChild(stats);
    if (t.output.results.length === 0) {
      const empty = div('help transition-empty');
      empty.textContent =
        '没有满足全部约束的下一和弦形状：切换结果为空。可放宽最大品位、调整下一和弦目标音级或约束。';
      panel.appendChild(empty);
    }
    t.output.results.forEach((row, i) => {
      panel.appendChild(renderTransitionItem(t, row, i));
    });
  }
  right.appendChild(panel);
}

/** 一个候选下一形状：品位格 + 切换代价 + 逐弦变化。 */
function renderTransitionItem(t: TransitionState, row: TransitionResult, i: number): HTMLElement {
  const r = row.result;
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'result-item transition-item' + (i === t.selected ? ' active' : '');

  const line1 = div('transition-line');
  const rank = document.createElement('span');
  rank.className = 'result-rank';
  rank.textContent = `#${i + 1}`;
  const meta = document.createElement('span');
  meta.className = 'result-meta';
  meta.textContent =
    `闷变${row.muteChanges} 移${row.movement} 跨${r.span} Σ${r.fretSum} 指${r.fingers} 响${r.ringing}` +
    (r.barre ? ` 横${r.barre.fret}品` : '');
  line1.append(rank, shapeChips(r.shape), meta);
  item.appendChild(line1);

  const line2 = div('change-row');
  for (const c of row.changes) {
    const chip = document.createElement('span');
    chip.className = `change-chip kind-${c.kind}`;
    chip.textContent = `${fmtFret(c.from)}→${fmtFret(c.to)}`;
    line2.appendChild(chip);
  }
  item.appendChild(line2);

  item.addEventListener('click', () => {
    t.selected = i;
    renderRight();
  });
  return item;
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
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent =
      `跨${r.span} Σ${r.fretSum} 指${r.fingers} 响${r.ringing}` +
      (r.barre ? ` 横${r.barre.fret}品` : '');
    item.append(rank, shapeChips(r.shape), meta);
    item.addEventListener('click', () => {
      state.selected = i;
      // 回到单和弦预览；进行中的切换预演一并退出。
      exitTransition('preview');
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
      searchTransitions: typeof searchTransitions;
      evaluateShape: typeof evaluateShape;
      bestFingering: typeof bestFingering;
      pcOfMidi: typeof pcOfMidi;
    };
  }
}
window.__fret = { searchChords, searchTransitions, evaluateShape, bestFingering, pcOfMidi };
