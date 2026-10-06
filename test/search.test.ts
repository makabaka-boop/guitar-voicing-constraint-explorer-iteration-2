import { describe, expect, it } from 'vitest';
import {
  bestFingering,
  compareShape,
  evaluateShape,
  pcOfMidi,
  searchChords,
  validateInput,
  type Barre,
  type ChordResult,
  type ExclusionReason,
  type Fingering,
} from '../src/search';

/**
 * 参考实现：独立、直白的笛卡尔积全枚举（不剪枝、不共享状态），
 * 搜索核心必须与它在小样本上逐字段对拍。
 * 注意：参考实现刻意放宽了弦数限制（支持 3 弦），仅用于测试。
 */
function referenceSearch(opts: {
  tuning: number[];
  targets: number[];
  maxFret: number;
  minStrings?: number;
  maxFingers?: number;
  maxSpan?: number;
  limit?: number;
}) {
  const { tuning, maxFret } = opts;
  const minStrings = opts.minStrings ?? 3;
  const maxFingers = opts.maxFingers ?? 4;
  const maxSpan = opts.maxSpan ?? 4;
  const limit = opts.limit ?? 20;
  const targetSet = new Set(opts.targets);

  const choices: number[] = [
    -1,
    ...Array.from({ length: maxFret + 1 }, (_, f) => f),
  ];

  let combos: number[][] = [[]];
  for (let s = 0; s < tuning.length; s++) {
    combos = combos.flatMap((prefix) => choices.map((c) => [...prefix, c]));
  }

  const excluded: Record<ExclusionReason, number> = {
    min_strings: 0,
    outside_target: 0,
    cover_target: 0,
    max_fingers: 0,
    span: 0,
  };
  const valid: ChordResult[] = [];

  for (const shape of combos) {
    const ringing = shape.filter((f) => f !== -1);
    if (ringing.length < minStrings) {
      excluded.min_strings++;
      continue;
    }
    const midi = shape.map((f, s) => (f === -1 ? null : tuning[s] + f));
    const pcs = midi.filter((m): m is number => m !== null).map(pcOfMidi);

    if (pcs.some((p) => !targetSet.has(p))) {
      excluded.outside_target++;
      continue;
    }
    if (![...targetSet].every((t) => pcs.includes(t))) {
      excluded.cover_target++;
      continue;
    }

    const pressed = ringing.filter((f) => f > 0);
    const fingers = pressed.length;
    if (fingers > maxFingers) {
      excluded.max_fingers++;
      continue;
    }
    const span = pressed.length === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
    if (span > maxSpan) {
      excluded.span++;
      continue;
    }

    valid.push({
      shape,
      span,
      fretSum: ringing.reduce((a, f) => a + f, 0),
      fingers,
      ringing: ringing.length,
      midi,
    });
  }

  valid.sort((a, b) => {
    if (a.span !== b.span) return a.span - b.span;
    if (a.fretSum !== b.fretSum) return a.fretSum - b.fretSum;
    return compareShape(a.shape, b.shape);
  });

  return {
    results: valid.slice(0, limit),
    total: combos.length,
    valid: valid.length,
    excluded,
    truncated: valid.length > limit,
  };
}

const TUNINGS_3 = {
  /** G-B-E（前三根弦，MIDI 67/71/76），40/44/49 = 低 3 个八度。 */
  gbeHigh: [67, 71, 76],
  gbeLow: [40, 44, 49],
  /** E-A-D（低三根弦 E2/A2/D2） */
  ead: [40, 45, 50],
};

const REASON_KEYS: ExclusionReason[] = [
  'min_strings',
  'outside_target',
  'cover_target',
  'max_fingers',
  'span',
];

describe('三弦小样本全枚举对拍', () => {
  const cases: { tuning: number[]; targets: number[]; maxFret: number }[] = [
    { tuning: TUNINGS_3.gbeHigh, targets: [4, 7, 11], maxFret: 3 }, // E 大三和弦
    { tuning: TUNINGS_3.gbeHigh, targets: [0, 4, 7], maxFret: 5 }, // C
    { tuning: TUNINGS_3.gbeLow, targets: [9, 0, 4], maxFret: 4 }, // A
    { tuning: TUNINGS_3.ead, targets: [2, 6, 9], maxFret: 6 }, // D
    { tuning: TUNINGS_3.gbeHigh, targets: [2, 5, 9], maxFret: 7 }, // Em
    { tuning: TUNINGS_3.gbeLow, targets: [7, 11, 2], maxFret: 9 }, // G，最大品位边界
    { tuning: TUNINGS_3.ead, targets: [0, 3], maxFret: 3 }, // 只有两个目标音级
    { tuning: TUNINGS_3.gbeHigh, targets: [1, 3, 6, 8, 10], maxFret: 4 }, // 五个目标音级（全降号）
  ];

  for (const c of cases) {
    it(`tuning=[${c.tuning}] targets={${c.targets}} maxFret=${c.maxFret}`, () => {
      const got = searchChords({ ...c, minStrings: 1 });
      const want = referenceSearch({ ...c, minStrings: 1 });

      expect(got.total).toBe(want.total);
      expect(got.total).toBe((c.maxFret + 2) ** 3);
      expect(got.valid).toBe(want.valid);
      expect(got.truncated).toBe(want.truncated);
      for (const k of REASON_KEYS) {
        expect(got.excluded[k], `excluded.${k}`).toBe(want.excluded[k]);
      }
      // 所有方案恰好归入「合法」或某一排除原因之一，不漏不重。
      const accounted = got.valid + REASON_KEYS.reduce((a, k) => a + got.excluded[k], 0);
      expect(accounted).toBe(got.total);

      expect(got.results.length).toBe(want.results.length);
      got.results.forEach((r, i) => {
        const w = want.results[i];
        expect(r.shape, `#${i} shape`).toEqual(w.shape);
        expect(r.span, `#${i} span`).toBe(w.span);
        expect(r.fretSum, `#${i} fretSum`).toBe(w.fretSum);
        expect(r.fingers, `#${i} fingers`).toBe(w.fingers);
        expect(r.ringing, `#${i} ringing`).toBe(w.ringing);
        expect(r.midi, `#${i} midi`).toEqual(w.midi);
      });
    });
  }

  it('默认约束（>=3 响弦、<=4 指、跨度<=4）也与参考实现一致', () => {
    const c = { tuning: TUNINGS_3.gbeHigh, targets: [4, 7, 11], maxFret: 5 };
    const got = searchChords(c);
    const want = referenceSearch(c);
    expect({
      results: got.results,
      valid: got.valid,
      excluded: got.excluded,
      truncated: got.truncated,
      total: got.total,
    }).toEqual({
      results: want.results,
      valid: want.valid,
      excluded: want.excluded,
      truncated: want.truncated,
      total: want.total,
    });
  });
});

describe('搜索约束语义', () => {
  it('所有结果都满足响弦 >=3、音级合法且覆盖目标', () => {
    const out = searchChords({ tuning: [64, 60, 64, 59], targets: [7, 11, 2], maxFret: 7 });
    const targetSet = new Set([7, 11, 2]);
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.ringing).toBeGreaterThanOrEqual(3);
      const pcs = r.midi.filter((m): m is number => m !== null).map(pcOfMidi);
      expect(pcs.every((p) => targetSet.has(p))).toBe(true);
      for (const t of targetSet) expect(pcs).toContain(t);
      expect(r.fingers).toBeLessThanOrEqual(4);
      expect(r.span).toBeLessThanOrEqual(4);
    }
  });

  it('排序：跨度升序，其次品位总和，其次向量字典序（闷音在品位之后）', () => {
    const out = searchChords({ tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 9 });
    expect(out.results.length).toBeGreaterThan(1);
    for (let i = 1; i < out.results.length; i++) {
      const a = out.results[i - 1];
      const b = out.results[i];
      // 跨度优先，其次品位总和。
      if (a.span !== b.span) {
        expect(a.span).toBeLessThan(b.span);
      } else if (a.fretSum !== b.fretSum) {
        expect(a.fretSum).toBeLessThan(b.fretSum);
      } else {
        // 前两键相同：形状向量必须非递减。
        expect(compareShape(a.shape, b.shape)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('最多返回 20 个，并报告 truncated；放宽限制可看全量', () => {
    const out = searchChords({ tuning: [40, 45, 50, 55, 59, 64], targets: [0, 4, 7], maxFret: 9 });
    expect(out.results.length).toBeLessThanOrEqual(20);
    expect(out.truncated).toBe(out.valid > 20);
    if (out.truncated) expect(out.results.length).toBe(20);

    const all = searchChords({ tuning: [40, 45, 50, 55, 59, 64], targets: [0, 4, 7], maxFret: 9, limit: 10_000 });
    expect(all.results.length).toBe(all.valid);
    expect(all.truncated).toBe(false);
  });

  it('闷音排在品位之后：同形状把某弦 x 换成 0 品后字典序更靠前', () => {
    expect(compareShape([-1, 0, 0], [0, 0, 0])).toBe(1);
    expect(compareShape([0, -1, 0], [0, 0, 0])).toBe(1);
    expect(compareShape([2, -1], [2, 0])).toBe(1);
    expect(compareShape([2, 3], [2, 4])).toBe(-1);
    expect(compareShape([2, 3], [2, 3])).toBe(0);
  });

  it('无按弦时跨度算 0；开放弦恰好覆盖目标时存在零按弦方案', () => {
    // E2 A2 D3 G3 开放音级 = {4,9,2,7}，恰好为目标：全开放形状合法。
    const out = searchChords({ tuning: [40, 45, 50, 55], targets: [4, 9, 2, 7], maxFret: 5 });
    const allOpen = out.results.find(
      (r) => r.fingers === 0 && r.ringing === 4 && r.shape.every((f) => f === 0),
    );
    expect(allOpen).toBeDefined();
    expect(allOpen!.span).toBe(0);
    expect(allOpen!.fretSum).toBe(0);

    // 含目标音级 C(0) 时开放弦无法覆盖，不存在零按弦方案，
    // 且所有按弦方案跨度按最大最小品位差计算。
    const out2 = searchChords({ tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 5 });
    expect(out2.results.every((r) => r.fingers > 0)).toBe(true);
    for (const r of out2.results) {
      const pressed = r.shape.filter((f): f is number => f > 0);
      expect(r.span).toBe(Math.max(...pressed) - Math.min(...pressed));
    }
  });

  it('排除原因计数完备：合法 + 各排除 = 总枚举数', () => {
    for (const [tuning, maxFret] of [
      [[40, 45, 50, 55], 3],
      [[40, 45, 50, 55, 59, 64], 6],
    ] as const) {
      const out = searchChords({ tuning: [...tuning], targets: [0, 4, 7], maxFret });
      const excludedSum = REASON_KEYS.reduce((a, k) => a + out.excluded[k], 0);
      expect(out.valid + excludedSum).toBe(out.total);
      expect(out.total).toBe((maxFret + 2) ** tuning.length);
    }
  });
});

describe('移调不变性', () => {
  /** 把所有开放弦与目标音级同时平移 k 半音（弦间音程不变）。 */
  const transposeInput = (
    input: { tuning: number[]; targets: number[]; maxFret: number },
    k: number,
  ) => ({
    tuning: input.tuning.map((m) => m + k),
    targets: input.targets.map((t) => (t + k + 1200) % 12),
    maxFret: input.maxFret,
  });

  it('定弦与目标同时移调：同一品位向量的合法性不变，结果逐向量相同', () => {
    const base = { tuning: [40, 45, 50, 55, 59, 64], targets: [4, 7, 11], maxFret: 9 };
    for (const k of [-4, -1, 1, 3, 7, 12]) {
      const a = searchChords({ ...base, limit: 100_000 });
      const b = searchChords({ ...transposeInput(base, k), limit: 100_000 });

      // 品位向量、排序、各项统计全部一致：合法性只取决于「相对开放弦的偏移」。
      expect(b.valid).toBe(a.valid);
      expect(b.total).toBe(a.total);
      expect(b.excluded).toEqual(a.excluded);
      expect(b.results.map((r) => r.shape)).toEqual(a.results.map((r) => r.shape));
      b.results.forEach((rb, i) => {
        const ra = a.results[i];
        expect(rb.span).toBe(ra.span);
        expect(rb.fretSum).toBe(ra.fretSum);
        expect(rb.fingers).toBe(ra.fingers);
        expect(rb.ringing).toBe(ra.ringing);
        // 发出的实际音高整体平移 k 半音（八度也跟着走）。
        expect(rb.midi).toEqual(ra.midi.map((m) => (m === null ? null : m + k)));
      });
    }
  });

  it('不同目标音级集合与品位范围下移调同样保持形状不变', () => {
    for (const base of [
      { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 6 },
      { tuning: [38, 45, 50, 55, 59], targets: [0, 3, 6, 10], maxFret: 4 },
      { tuning: [40, 45, 50, 55, 59, 64], targets: [1, 5, 8], maxFret: 3 },
    ]) {
      const a = searchChords({ ...base, limit: 100_000 });
      const b = searchChords({ ...transposeInput(base, 5), limit: 100_000 });
      expect(b.results.map((r) => r.shape)).toEqual(a.results.map((r) => r.shape));
      // 每个结果发声音级确实是原音级 +k。
      for (const r of b.results) {
        const pcs = r.midi.filter((m): m is number => m !== null).map(pcOfMidi);
        const expected = new Set(base.targets.map((t) => (t + 5) % 12));
        for (const p of pcs) expect(expected.has(p)).toBe(true);
      }
    }
  });
});

describe('输入校验', () => {
  it('接受任务给定范围内的输入', () => {
    expect(
      validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 3 }),
    ).toEqual([]);
    expect(
      validateInput({ tuning: [38, 45, 50, 55, 59, 64], targets: [1, 2], maxFret: 9 }),
    ).toEqual([]);
  });

  it('拒绝越界的弦数、目标音级数与最大品位', () => {
    expect(validateInput({ tuning: [40, 45, 50], targets: [0, 4], maxFret: 5 }).some((i) => i.field === 'tuning')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55, 55, 55, 55], targets: [0, 4], maxFret: 5 }).some((i) => i.field === 'tuning')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0], maxFret: 5 }).some((i) => i.field === 'targets')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 1, 2, 3, 4, 5], maxFret: 5 }).some((i) => i.field === 'targets')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4], maxFret: 2 }).some((i) => i.field === 'maxFret')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4], maxFret: 10 }).some((i) => i.field === 'maxFret')).toBe(true);
  });

  it('目标音级去重后计数；非法 MIDI/音级被拒绝', () => {
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4, 4, 7], maxFret: 5 })).toEqual([]);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 12], maxFret: 5 }).some((i) => i.field === 'targets')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 200, 55], targets: [0, 4], maxFret: 5 }).some((i) => i.field === 'tuning')).toBe(true);
    expect(validateInput({ tuning: [28, 33, 38, 43], targets: [0, 4], maxFret: 5 })).toEqual([]);
  });
});

/* ------------------------------ 单横按指法模式 ------------------------------ */

/**
 * 独立参考实现：直白地枚举全部横按区间 [from, to] × 横按品位 bf，
 * 不剪枝、不共享状态；bestFingering 必须与它在小指板上逐项对拍。
 */
function referenceBestFingering(shape: number[], allowBarre: boolean): Fingering {
  const plain = shape.filter((f) => f > 0).length;
  const cands: Fingering[] = [{ fingers: plain, barre: null }];
  if (allowBarre) {
    const maxF = Math.max(0, ...shape);
    for (let bf = 1; bf <= maxF; bf++) {
      for (let from = 0; from < shape.length; from++) {
        for (let to = from; to < shape.length; to++) {
          const seg = shape.slice(from, to + 1);
          // 段内不得有闷音、空弦或低于横按品位的弦。
          if (seg.some((f) => f < bf)) continue;
          // 段内至少两弦最终品位恰为横按品位。
          if (seg.filter((f) => f === bf).length < 2) continue;
          const higher = seg.filter((f) => f > bf).length;
          const outside = shape.filter((f, i) => f > 0 && (i < from || i > to)).length;
          cands.push({ fingers: 1 + higher + outside, barre: { fret: bf, from, to } });
        }
      }
    }
  }
  cands.sort((a, b) => {
    if (a.fingers !== b.fingers) return a.fingers - b.fingers;
    if (a.barre === null && b.barre === null) return 0;
    if (a.barre === null) return -1;
    if (b.barre === null) return 1;
    if (a.barre.fret !== b.barre.fret) return a.barre.fret - b.barre.fret;
    if (a.barre.from !== b.barre.from) return a.barre.from - b.barre.from;
    return a.barre.to - b.barre.to;
  });
  return cands[0];
}

describe('单横按指法：最优指法求解', () => {
  it('3/4 弦小指板全形状对拍：手指数与横按结论逐项一致', () => {
    const values = [-1, 0, 1, 2, 3];
    for (const n of [3, 4]) {
      let combos: number[][] = [[]];
      for (let s = 0; s < n; s++) combos = combos.flatMap((p) => values.map((v) => [...p, v]));
      for (const shape of combos) {
        const got = bestFingering(shape, true);
        const want = referenceBestFingering(shape, true);
        expect(got.fingers, `[${shape}] fingers`).toBe(want.fingers);
        expect(got.barre, `[${shape}] barre`).toEqual(want.barre);
        // 无横按兼容：关闭横按时恒为逐弦计指、不带横按。
        expect(bestFingering(shape, false), `[${shape}] 关闭横按`).toEqual({
          fingers: shape.filter((f) => f > 0).length,
          barre: null,
        });
      }
    }
  });

  it('经典横按形状：全横按与部分横按', () => {
    // F 大三（标准定弦 1 品全横按）：6 根按弦 -> 横按 1 指 + 3 根高音弦各 1 指。
    expect(bestFingering([1, 3, 3, 2, 1, 1], true)).toEqual({
      fingers: 4,
      barre: { fret: 1, from: 0, to: 5 },
    });
    expect(bestFingering([1, 3, 3, 2, 1, 1], false)).toEqual({ fingers: 6, barre: null });
    // 部分横按：2 品横按弦 2–3（下标 1–2），3 品以下的 1 品弦另占一指。
    expect(bestFingering([-1, 2, 2, 1, 0, 0], true)).toEqual({
      fingers: 2,
      barre: { fret: 2, from: 1, to: 2 },
    });
    // 横按段可以包含按更高品位的弦（那些弦另占手指）。
    expect(bestFingering([3, 1, 3, 1], true)).toEqual({
      fingers: 3,
      barre: { fret: 1, from: 0, to: 3 },
    });
  });

  it('闷音、空弦与更低品位的弦阻断横按区间', () => {
    // 同品两弦被闷音隔开：任何含两者的区间都含闷音，横按不成立。
    expect(bestFingering([2, -1, 2], true)).toEqual({ fingers: 2, barre: null });
    // 被空弦隔开同样不成立。
    expect(bestFingering([2, 0, 2], true)).toEqual({ fingers: 2, barre: null });
    // 段内出现低于横按品位的弦：3 品横按段不能跨过 1 品弦。
    expect(bestFingering([3, 1, 3], true)).toEqual({ fingers: 3, barre: null });
    // 阻断只限制区间：闷音两侧各自成段时取更优（起始弦小者）。
    expect(bestFingering([2, 2, -1, 2, 2], true)).toEqual({
      fingers: 3,
      barre: { fret: 2, from: 0, to: 1 },
    });
  });

  it('并列指法裁决：横按品位、起始弦、结束弦下标依次升序', () => {
    // 横按品位并列时：起始弦下标小者优先（[0,1] 与 [3,4] 同为 4 指）。
    expect(bestFingering([2, 2, 1, 2, 2], true)).toEqual({
      fingers: 4,
      barre: { fret: 2, from: 0, to: 1 },
    });
    // 品位与起始弦并列时：结束弦下标小者优先（[0,1] 与 [0,2] 同为 2 指）。
    expect(bestFingering([2, 2, 3], true)).toEqual({
      fingers: 2,
      barre: { fret: 2, from: 0, to: 1 },
    });
    // 手指数并列时：横按品位低者优先（2 品段与 3 品段同为 3 指）。
    expect(bestFingering([2, 2, 3, 3], true)).toEqual({
      fingers: 3,
      barre: { fret: 2, from: 0, to: 1 },
    });
  });
});

/** 横按模式的独立参考搜索：跨度为前置规则，手指数来自 referenceBestFingering。 */
function referenceSearchBarre(opts: {
  tuning: number[];
  targets: number[];
  maxFret: number;
  minStrings?: number;
  maxFingers?: number;
  maxSpan?: number;
  limit?: number;
}) {
  const { tuning, maxFret } = opts;
  const minStrings = opts.minStrings ?? 3;
  const maxFingers = opts.maxFingers ?? 4;
  const maxSpan = opts.maxSpan ?? 4;
  const limit = opts.limit ?? 20;
  const targetSet = new Set(opts.targets);

  const choices: number[] = [-1, ...Array.from({ length: maxFret + 1 }, (_, f) => f)];
  let combos: number[][] = [[]];
  for (let s = 0; s < tuning.length; s++) {
    combos = combos.flatMap((prefix) => choices.map((c) => [...prefix, c]));
  }

  const excluded: Record<ExclusionReason, number> = {
    min_strings: 0,
    outside_target: 0,
    cover_target: 0,
    max_fingers: 0,
    span: 0,
  };
  const valid: (ChordResult & { barre: Barre | null })[] = [];

  for (const shape of combos) {
    const ringing = shape.filter((f) => f !== -1);
    if (ringing.length < minStrings) {
      excluded.min_strings++;
      continue;
    }
    const midi = shape.map((f, s) => (f === -1 ? null : tuning[s] + f));
    const pcs = midi.filter((m): m is number => m !== null).map(pcOfMidi);
    if (pcs.some((p) => !targetSet.has(p))) {
      excluded.outside_target++;
      continue;
    }
    if (![...targetSet].every((t) => pcs.includes(t))) {
      excluded.cover_target++;
      continue;
    }
    // 横按模式：跨度是横按枚举的前置规则，随后才是手指数闸门。
    const pressed = ringing.filter((f) => f > 0);
    const span = pressed.length === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
    if (span > maxSpan) {
      excluded.span++;
      continue;
    }
    const fing = referenceBestFingering(shape, true);
    if (fing.fingers > maxFingers) {
      excluded.max_fingers++;
      continue;
    }
    valid.push({
      shape,
      span,
      fretSum: ringing.reduce((a, f) => a + f, 0),
      fingers: fing.fingers,
      ringing: ringing.length,
      midi,
      barre: fing.barre,
    });
  }

  valid.sort((a, b) => {
    if (a.span !== b.span) return a.span - b.span;
    if (a.fretSum !== b.fretSum) return a.fretSum - b.fretSum;
    return compareShape(a.shape, b.shape);
  });

  return {
    results: valid.slice(0, limit),
    total: combos.length,
    valid: valid.length,
    excluded,
    truncated: valid.length > limit,
  };
}

describe('单横按模式：搜索集成', () => {
  const STD = [40, 45, 50, 55, 59, 64];

  it('小样本全枚举对拍：结果、排除计数、横按结论逐项一致', () => {
    const cases: {
      tuning: number[];
      targets: number[];
      maxFret: number;
      minStrings?: number;
      maxFingers?: number;
      maxSpan?: number;
    }[] = [
      { tuning: TUNINGS_3.gbeHigh, targets: [4, 7, 11], maxFret: 3 },
      { tuning: TUNINGS_3.gbeHigh, targets: [4, 7, 11], maxFret: 4, maxFingers: 2 },
      { tuning: TUNINGS_3.ead, targets: [2, 6, 9], maxFret: 4, maxFingers: 1 },
      { tuning: TUNINGS_3.gbeLow, targets: [9, 0, 4], maxFret: 5, maxFingers: 2, minStrings: 2 },
      { tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 4, maxFingers: 2 },
      { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 3, maxFingers: 3, maxSpan: 2 },
    ];
    for (const c of cases) {
      const got = searchChords({ ...c, allowBarre: true });
      const want = referenceSearchBarre(c);
      const tag = `tuning=[${c.tuning}] targets={${c.targets}} maxFingers=${c.maxFingers ?? 4}`;
      expect(got.total, tag).toBe(want.total);
      expect(got.valid, tag).toBe(want.valid);
      expect(got.truncated, tag).toBe(want.truncated);
      for (const k of REASON_KEYS) {
        expect(got.excluded[k], `${tag} excluded.${k}`).toBe(want.excluded[k]);
      }
      const accounted = got.valid + REASON_KEYS.reduce((a, k) => a + got.excluded[k], 0);
      expect(accounted, tag).toBe(got.total);
      expect(got.results.length, tag).toBe(want.results.length);
      got.results.forEach((r, i) => {
        const w = want.results[i];
        expect(r.shape, `${tag} #${i} shape`).toEqual(w.shape);
        expect(r.span, `${tag} #${i} span`).toBe(w.span);
        expect(r.fretSum, `${tag} #${i} fretSum`).toBe(w.fretSum);
        expect(r.fingers, `${tag} #${i} fingers`).toBe(w.fingers);
        expect(r.ringing, `${tag} #${i} ringing`).toBe(w.ringing);
        expect(r.midi, `${tag} #${i} midi`).toEqual(w.midi);
        expect(r.barre ?? null, `${tag} #${i} barre`).toEqual(w.barre);
      });
    }
  });

  it('默认关闭：allowBarre 缺省与显式 false 输出完全一致', () => {
    const input = { tuning: STD, targets: [0, 5, 9], maxFret: 5 };
    const a = searchChords(input);
    const b = searchChords({ ...input, allowBarre: false });
    expect(a).toEqual(b);
    // 默认模式结果不携带 barre 字段，逐弦计指。
    expect(a.results.every((r) => !('barre' in r))).toBe(true);
  });

  it('无横按兼容：默认合法的形状全部保留、相对顺序不变、手指数只减不增', () => {
    for (const input of [
      { tuning: STD, targets: [4, 8, 11], maxFret: 5 },
      { tuning: STD, targets: [0, 5, 9], maxFret: 5 },
      { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 6 },
    ]) {
      const off = searchChords({ ...input, limit: 100_000 });
      const on = searchChords({ ...input, allowBarre: true, limit: 100_000 });
      // 横按模式只会放行更多形状。
      expect(on.valid).toBeGreaterThanOrEqual(off.valid);
      // 音级与响弦规则不受影响，前三类排除计数逐项相同。
      for (const k of ['min_strings', 'outside_target', 'cover_target'] as const) {
        expect(on.excluded[k]).toBe(off.excluded[k]);
      }
      // 默认合法形状在横按模式结果中按原相对顺序出现（子序列）。
      let cursor = 0;
      for (const r of off.results) {
        const idx = on.results.findIndex(
          (o, i) => i >= cursor && compareShape(o.shape, r.shape) === 0,
        );
        expect(idx, `形状 [${r.shape}] 应在横按模式下保留`).toBeGreaterThanOrEqual(cursor);
        cursor = idx + 1;
        const onR = on.results[idx];
        expect(onR.fingers).toBeLessThanOrEqual(r.fingers);
        expect(onR.span).toBe(r.span);
        expect(onR.fretSum).toBe(r.fretSum);
        expect(onR.ringing).toBe(r.ringing);
      }
    }
  });

  it('拯救逐弦计指超指的横按形状（F 大三全横按）', () => {
    const input = { tuning: STD, targets: [0, 5, 9], maxFret: 5 };
    const fShape = [1, 3, 3, 2, 1, 1];
    // 默认模式：6 根按弦超 4 指，被排除。
    expect(evaluateShape(fShape, STD, [0, 5, 9]).reason).toBe('max_fingers');
    const off = searchChords({ ...input, limit: 100_000 });
    expect(off.results.some((r) => compareShape(r.shape, fShape) === 0)).toBe(false);
    // 横按模式：1 品全横按 + 3 指 = 4 指，放行。
    const on = searchChords({ ...input, allowBarre: true, limit: 100_000 });
    const hit = on.results.find((r) => compareShape(r.shape, fShape) === 0);
    expect(hit).toBeDefined();
    expect(hit!.fingers).toBe(4);
    expect(hit!.barre).toEqual({ fret: 1, from: 0, to: 5 });
    expect(on.valid).toBeGreaterThan(off.valid);
    expect(on.excluded.max_fingers).toBeLessThan(off.excluded.max_fingers);
  });

  it('最优指法手指数闸门：横按后仍超 4 指的形状被排除', () => {
    // 任意横按段内同品弦数至多 2，最优指法仍需 5 指。
    const ev = evaluateShape([1, 2, 2, 3, 4, 4], STD, [3, 4, 5, 8, 10, 11], { allowBarre: true });
    expect(ev.valid).toBe(false);
    expect(ev.reason).toBe('max_fingers');
    expect(ev.fingers).toBe(5);
    // [1,2] 与 [1,5] 同为 5 指：并列时结束弦下标小者优先。
    expect(ev.barre).toEqual({ fret: 2, from: 1, to: 2 });
  });

  it('横按模式把跨度作为前置规则：同一形状两模式首报原因不同', () => {
    // 5 根按弦且跨度 5：默认模式首报 max_fingers，横按模式首报 span。
    const shape = [1, 2, 3, 5, 6, -1];
    expect(evaluateShape(shape, STD, [0, 5, 11]).reason).toBe('max_fingers');
    expect(evaluateShape(shape, STD, [0, 5, 11], { allowBarre: true }).reason).toBe('span');
  });

  it('排除计数完备、同一形状不因多种指法重复展示', () => {
    const on = searchChords({ tuning: STD, targets: [0, 5, 9], maxFret: 5, allowBarre: true, limit: 100_000 });
    const excludedSum = REASON_KEYS.reduce((a, k) => a + on.excluded[k], 0);
    expect(on.valid + excludedSum).toBe(on.total);
    const seen = new Set(on.results.map((r) => r.shape.join(',')));
    expect(seen.size).toBe(on.results.length);
  });

  it('排序键不变：跨度 → 品位总和 → 形状向量字典序', () => {
    const out = searchChords({ tuning: STD, targets: [0, 5, 9], maxFret: 5, allowBarre: true });
    expect(out.results.length).toBeGreaterThan(1);
    for (let i = 1; i < out.results.length; i++) {
      const a = out.results[i - 1];
      const b = out.results[i];
      if (a.span !== b.span) {
        expect(a.span).toBeLessThan(b.span);
      } else if (a.fretSum !== b.fretSum) {
        expect(a.fretSum).toBeLessThan(b.fretSum);
      } else {
        expect(compareShape(a.shape, b.shape)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('搜索结果、evaluateShape 与 bestFingering 共用同一指法结论', () => {
    const input = { tuning: STD, targets: [0, 5, 9], maxFret: 5 };
    const on = searchChords({ ...input, allowBarre: true, limit: 100_000 });
    expect(on.results.some((r) => r.barre)).toBe(true);
    for (const r of on.results) {
      // 与直接求解一致。
      expect(bestFingering(r.shape, true)).toEqual({ fingers: r.fingers, barre: r.barre ?? null });
      // 与单形状评估一致。
      const ev = evaluateShape(r.shape, input.tuning, input.targets, { allowBarre: true });
      expect(ev.valid).toBe(true);
      expect(ev.fingers).toBe(r.fingers);
      expect(ev.barre ?? null).toEqual(r.barre ?? null);
      // 横按结论本身满足规则：段内每弦 >= 横按品位，且至少两弦恰为横按品位。
      if (r.barre) {
        const seg = r.shape.slice(r.barre.from, r.barre.to + 1);
        expect(seg.every((f) => f >= r.barre!.fret)).toBe(true);
        expect(seg.filter((f) => f === r.barre!.fret).length).toBeGreaterThanOrEqual(2);
      }
      expect(r.fingers).toBeLessThanOrEqual(4);
    }
  });
});
