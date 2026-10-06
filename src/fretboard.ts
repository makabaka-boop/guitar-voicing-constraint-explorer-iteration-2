/**
 * 指板 SVG 渲染与点击编辑。
 * 布局：弦纵向延伸（x 轴按弦分列，低音弦在左），品位沿 y 轴向下。
 */
import { midiName, pcOfMidi, pcName, type Barre } from './search';

export interface FretboardOptions {
  tuning: number[];
  maxFret: number;
  /** 当前形状；点击编辑时由 onToggle 修改。 */
  shape: number[];
  /** 目标音级：在指板上给出微弱提示标记。 */
  targetPcs: number[];
  /** 是否可点击编辑（自定义形状模式）。 */
  editable: boolean;
  preferFlat: boolean;
  /** 该形状最优指法的横按结论；提供时绘制横按标记（与搜索/评估共用同一结论）。 */
  barre?: Barre | null;
  onToggle?: (stringIndex: number, fret: number) => void;
}

const MARGIN = { top: 46, right: 18, bottom: 24, left: 18 };
const FRET_W = 74; // 每格（每根弦一列）的宽度
const FRET_H = 46; // 每品的高度

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function renderFretboard(container: HTMLElement, opts: FretboardOptions): void {
  container.replaceChildren();
  const { tuning, maxFret, shape, targetPcs, editable, preferFlat, barre, onToggle } = opts;
  const n = tuning.length;

  const width = MARGIN.left + MARGIN.right + (n - 1) * FRET_W;
  const height = MARGIN.top + MARGIN.bottom + maxFret * FRET_H;
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': '指板预览',
  });

  const colX = (s: number) => MARGIN.left + s * FRET_W;
  const fretY = (f: number) => MARGIN.top + f * FRET_H; // 品 f 与 f+1 之间的格从 fretY(f) 到 fretY(f+1)
  const markerY = (f: number) => fretY(f) + FRET_H / 2;

  // ---- 品丝与琴枕 ----
  // 琴枕（0 品上沿）
  svg.appendChild(
    el('line', {
      class: 'fb-nut',
      x1: MARGIN.left - 10,
      x2: colX(n - 1) + 10,
      y1: fretY(0),
      y2: fretY(0),
    }),
  );
  for (let f = 1; f <= maxFret; f++) {
    svg.appendChild(
      el('line', {
        class: 'fb-fretwire',
        x1: MARGIN.left - 10,
        x2: colX(n - 1) + 10,
        y1: fretY(f),
        y2: fretY(f),
      }),
    );
  }
  // 品号（画在右侧空隙）
  for (let f = 1; f <= maxFret; f++) {
    const t = el('text', { x: colX(n - 1) + 14, y: markerY(f) + 3.5, class: 'fb-fret-num' });
    t.textContent = String(f);
    svg.appendChild(t);
  }
  // 0 品标记提示文字
  const zeroText = el('text', { x: colX(n - 1) + 14, y: markerY(0) + 3.5, class: 'fb-open-label' });
  zeroText.textContent = '0';
  svg.appendChild(zeroText);

  // ---- 弦（低音弦在左且更粗） ----
  for (let s = 0; s < n; s++) {
    const thickness = Math.max(0.8, 2.6 - s * 0.35);
    svg.appendChild(
      el('line', {
        class: 'fb-string',
        x1: colX(s),
        x2: colX(s),
        y1: fretY(0) - 14,
        y2: fretY(maxFret),
        'stroke-width': thickness.toFixed(2),
        opacity: shape[s] === -1 ? 0.35 : 0.9,
      }),
    );
  }

  // ---- 品位圆点 inlay（3/5/7/9 品，置于弦列中间） ----
  const midX = (colX(0) + colX(n - 1)) / 2;
  for (const f of [3, 5, 7, 9]) {
    if (f > maxFret) continue;
    svg.appendChild(el('circle', { class: 'fb-inlay', cx: midX, cy: markerY(f), r: 4 }));
  }

  // ---- 目标音级微弱提示：每弦每品若音级命中目标，画空心圆 ----
  const targetSet = new Set(targetPcs);
  for (let s = 0; s < n; s++) {
    for (let f = 1; f <= maxFret; f++) {
      if (shape[s] === f) continue;
      if (!targetSet.has(pcOfMidi(tuning[s] + f))) continue;
      svg.appendChild(
        el('circle', {
          class: 'fb-target-hint',
          cx: colX(s),
          cy: markerY(f),
          r: 13,
        }),
      );
    }
    // 0 品开放音级命中目标的提示
    if (shape[s] !== 0 && targetSet.has(pcOfMidi(tuning[s]))) {
      svg.appendChild(
        el('circle', {
          class: 'fb-target-hint',
          cx: colX(s),
          cy: fretY(0) - 20,
          r: 9,
        }),
      );
    }
  }

  // ---- 横按标记：一条覆盖 [from, to] 弦列的圆角横杠（画在按弦圆点之下） ----
  if (barre) {
    svg.appendChild(
      el('rect', {
        class: 'fb-barre',
        x: colX(barre.from) - 13,
        y: markerY(barre.fret) - 13,
        width: (barre.to - barre.from) * FRET_W + 26,
        height: 26,
        rx: 13,
      }),
    );
  }

  // ---- 当前形状的手指/开放/闷音标记 ----
  for (let s = 0; s < n; s++) {
    const v = shape[s];
    if (v === -1) {
      // 闷音：琴枕上方 X
      const cx = colX(s);
      const cy = fretY(0) - 20;
      const r = 7;
      svg.appendChild(
        el('line', { class: 'fb-marker muted', x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r }),
      );
      svg.appendChild(
        el('line', { class: 'fb-marker muted', x1: cx + r, y1: cy - r, x2: cx - r, y2: cy + r }),
      );
    } else if (v === 0) {
      svg.appendChild(
        el('circle', { class: 'fb-marker open', cx: colX(s), cy: fretY(0) - 20, r: 8, fill: 'none', stroke: '#cfe0f2', 'stroke-width': 2 }),
      );
    } else {
      svg.appendChild(
        el('circle', { class: 'fb-marker pressed', cx: colX(s), cy: markerY(v), r: 13 }),
      );
      const label = el('text', { x: colX(s), y: markerY(v) + 0.5, class: 'fb-note-label' });
      label.textContent = pcName(pcOfMidi(tuning[s] + v), preferFlat);
      svg.appendChild(label);
    }
  }

  // ---- 每弦开放弦音名（列顶） ----
  for (let s = 0; s < n; s++) {
    const t = el('text', { x: colX(s), y: 14, class: 'fb-open-label' });
    t.textContent = midiName(tuning[s], preferFlat);
    svg.appendChild(t);
  }

  // ---- 点击层（编辑模式） ----
  if (editable && onToggle) {
    for (let s = 0; s < n; s++) {
      // 0 品 / 闷音切换区（琴枕上方）
      const topHit = el('rect', {
        x: colX(s) - FRET_W / 2,
        y: 0,
        width: FRET_W,
        height: MARGIN.top,
        fill: 'transparent',
        class: 'fb-clickable',
      });
      topHit.addEventListener('click', () => onToggle(s, 0));
      svg.appendChild(topHit);
      // 各品
      for (let f = 1; f <= maxFret; f++) {
        const hit = el('rect', {
          x: colX(s) - FRET_W / 2,
          y: fretY(f - 1),
          width: FRET_W,
          height: FRET_H,
          fill: 'transparent',
          class: 'fb-clickable',
        });
        hit.addEventListener('click', () => onToggle(s, f));
        svg.appendChild(hit);
      }
    }
  }

  container.appendChild(svg);
}
