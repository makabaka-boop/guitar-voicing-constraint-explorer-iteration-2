import { describe, expect, it } from 'vitest';
import {
  bestFingering,
  compareShape,
  pcOfMidi,
  searchChords,
  searchTransitions,
  type Barre,
  type ChordResult,
  type Fingering,
  type Shape,
  type TransitionResult,
} from '../src/search';

/**
 * 独立参考实现：直白的笛卡尔积全枚举（不剪枝、不共享状态），
 * 切换排序键为 闷音状态变化弦数 -> 两次均发声弦品位移动量之和
 * -> 跨度 -> 品位总和 -> 形状向量字典序（闷音排在品位之后）。
 * searchTransitions 必须与它在小指板上逐字段对拍。
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
          if (seg.some((f) => f < bf)) continue;
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

function referenceTransitions(opts: {
  tuning: number[];
  from: number[];
  targets: number[];
  maxFret: number;
  minStrings?: number;
  maxFingers?: number;
  maxSpan?: number;
  limit?: number;
  allowBarre?: boolean;
}): { results: TransitionResult[]; total: number; valid: number; truncated: boolean } {
  const { tuning, maxFret, from } = opts;
  const minStrings = opts.minStrings ?? 3;
  const maxFingers = opts.maxFingers ?? 4;
  const maxSpan = opts.maxSpan ?? 4;
  const limit = opts.limit ?? 20;
  const allowBarre = opts.allowBarre ?? false;
  const targetSet = new Set(opts.targets);

  const choices: number[] = [-1, ...Array.from({ length: maxFret + 1 }, (_, f) => f)];
  let combos: number[][] = [[]];
  for (let s = 0; s < tuning.length; s++) {
    combos = combos.flatMap((prefix) => choices.map((c) => [...prefix, c]));
  }

  const rows: TransitionResult[] = [];
  for (const shape of combos) {
    const ringing = shape.filter((f) => f !== -1);
    if (ringing.length < minStrings) continue;
    const midi = shape.map((f, s) => (f === -1 ? null : tuning[s] + f));
    const pcs = midi.filter((m): m is number => m !== null).map(pcOfMidi);
    if (pcs.some((p) => !targetSet.has(p))) continue;
    if (![...targetSet].every((t) => pcs.includes(t))) continue;

    const pressed = ringing.filter((f) => f > 0);
    const span = pressed.length === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
    const fretSum = ringing.reduce((a, f) => a + f, 0);
    let fingers: number;
    let barre: Barre | null = null;
    if (allowBarre) {
      // 横按模式：跨度是横按枚举的前置规则，随后是最优指法手指数闸门。
      if (span > maxSpan) continue;
      const fing = referenceBestFingering(shape, true);
      if (fing.fingers > maxFingers) continue;
      fingers = fing.fingers;
      barre = fing.barre;
    } else {
      if (pressed.length > maxFingers) continue;
      if (span > maxSpan) continue;
      fingers = pressed.length;
    }

    const changes = from.map((f, s) => {
      const to = shape[s];
      if (f === -1 && to === -1) return { from: f, to, kind: 'keep_muted' as const, delta: 0 };
      if (f === -1) return { from: f, to, kind: 'unmute' as const, delta: 0 };
      if (to === -1) return { from: f, to, kind: 'mute' as const, delta: 0 };
      const delta = Math.abs(to - f);
      if (delta === 0) return { from: f, to, kind: 'stay' as const, delta };
      return { from: f, to, kind: 'move' as const, delta };
    });
    const muteChanges = changes.filter((c) => c.kind === 'mute' || c.kind === 'unmute').length;
    const movement = changes.reduce((a, c) => a + c.delta, 0);
    const result: ChordResult = { shape, span, fretSum, fingers, ringing: ringing.length, midi };
    if (allowBarre) result.barre = barre;
    rows.push({ result, muteChanges, movement, changes });
  }

  rows.sort((a, b) => {
    if (a.muteChanges !== b.muteChanges) return a.muteChanges - b.muteChanges;
    if (a.movement !== b.movement) return a.movement - b.movement;
    if (a.result.span !== b.result.span) return a.result.span - b.result.span;
    if (a.result.fretSum !== b.result.fretSum) return a.result.fretSum - b.result.fretSum;
    return compareShape(a.result.shape, b.result.shape);
  });

  return {
    results: rows.slice(0, limit),
    total: combos.length,
    valid: rows.length,
    truncated: rows.length > limit,
  };
}

/** 逐字段对拍两行切换结果。 */
function expectRows(got: TransitionResult[], want: TransitionResult[]): void {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => {
    const w = want[i];
    const tag = `#${i} [${g.result.shape}]`;
    expect(g.result.shape, `${tag} shape`).toEqual(w.result.shape);
    expect(g.muteChanges, `${tag} muteChanges`).toBe(w.muteChanges);
    expect(g.movement, `${tag} movement`).toBe(w.movement);
    expect(g.changes, `${tag} changes`).toEqual(w.changes);
    expect(g.result.span, `${tag} span`).toBe(w.result.span);
    expect(g.result.fretSum, `${tag} fretSum`).toBe(w.result.fretSum);
    expect(g.result.fingers, `${tag} fingers`).toBe(w.result.fingers);
    expect(g.result.ringing, `${tag} ringing`).toBe(w.result.ringing);
    expect(g.result.midi, `${tag} midi`).toEqual(w.result.midi);
    expect(g.result.barre ?? null, `${tag} barre`).toEqual(w.result.barre ?? null);
  });
}

const STD = [40, 45, 50, 55, 59, 64];

describe('双和弦切换预演：小指板全枚举对拍', () => {
  const cases: {
    tuning: number[];
    from: number[];
    targets: number[];
    maxFret: number;
    minStrings?: number;
    maxFingers?: number;
    maxSpan?: number;
    allowBarre?: boolean;
  }[] = [
    // 默认模式：3/4 弦、含闷音与高品位起点
    { tuning: [67, 71, 76], targets: [4, 7, 11], maxFret: 3, from: [0, 1, 0] },
    { tuning: [67, 71, 76], targets: [0, 4, 7], maxFret: 4, from: [-1, 2, 1], minStrings: 2 },
    { tuning: [40, 45, 50], targets: [2, 6, 9], maxFret: 4, from: [2, -1, -1], minStrings: 1 },
    { tuning: [40, 44, 49], targets: [9, 0, 4], maxFret: 5, from: [4, 4, 4] },
    { tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 3, from: [3, 2, 0, -1] },
    { tuning: [40, 45, 50, 55], targets: [4, 7, 11], maxFret: 3, from: [0, 0, 0, 0] },
    // 合法数超过 20：截断路径也被对拍覆盖
    { tuning: [40, 45, 50, 55], targets: [4, 7, 11], maxFret: 9, minStrings: 1, from: [7, 7, 5, 9] },
    // 单横按模式：手指数闸门收紧时横按枚举决定合法性
    { tuning: [67, 71, 76], targets: [4, 7, 11], maxFret: 4, from: [0, 1, 0], allowBarre: true, maxFingers: 2 },
    { tuning: [40, 45, 50], targets: [2, 6, 9], maxFret: 4, from: [-1, -1, 2], allowBarre: true, maxFingers: 1, minStrings: 2 },
    { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 3, from: [0, 0, 0, 0], allowBarre: true, maxFingers: 3, maxSpan: 2 },
    { tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 4, from: [1, -1, 2, 0], allowBarre: true, maxFingers: 2 },
    // 6 弦标准定弦两种模式各一
    { tuning: STD, targets: [4, 8, 11], maxFret: 5, from: [0, -1, -1, 1, 0, 0] },
    { tuning: STD, targets: [0, 5, 9], maxFret: 5, from: [0, 2, 2, 1, 0, 0], allowBarre: true },
  ];

  for (const c of cases) {
    const tag =
      `tuning=[${c.tuning}] from=[${c.from}] targets={${c.targets}} maxFret=${c.maxFret}` +
      (c.allowBarre ? ' 横按' : '');
    it(tag, () => {
      const got = searchTransitions(c);
      const want = referenceTransitions(c);
      expect(got.total, 'total').toBe(want.total);
      expect(got.total).toBe((c.maxFret + 2) ** c.tuning.length);
      expect(got.valid, 'valid').toBe(want.valid);
      expect(got.truncated, 'truncated').toBe(want.truncated);
      expect(got.from, 'from 快照').toEqual(c.from);
      expectRows(got.results, want.results);
    });
  }
});

describe('切换排序键语义', () => {
  it('手算例：闷音变化数优先于移动量，同闷变按移动量升序', () => {
    // E A D G 开放弦、目标 {E,G,B}、3 品内共 5 个合法形状（手工推出，见下）。
    const out = searchTransitions({
      tuning: [40, 45, 50, 55],
      targets: [4, 7, 11],
      maxFret: 3,
      minStrings: 1,
      from: [0, 0, 0, 0],
    });
    expect(out.valid).toBe(5);
    expect(out.truncated).toBe(false);
    const got = out.results.map((r) => ({
      shape: r.result.shape,
      mute: r.muteChanges,
      move: r.movement,
    }));
    expect(got).toEqual([
      // 闷变 0：移动量 4 < 7
      { shape: [0, 2, 2, 0], mute: 0, move: 4 },
      { shape: [3, 2, 2, 0], mute: 0, move: 7 },
      // 闷变 1：移动量 2 < 4 < 7；移动量 2 的形状仍排在全部闷变 0 之后
      { shape: [0, 2, -1, 0], mute: 1, move: 2 },
      { shape: [-1, 2, 2, 0], mute: 1, move: 4 },
      { shape: [3, 2, 2, -1], mute: 1, move: 7 },
    ]);
    // 第 1 名的逐弦变化明细：两根弦 0->2，其余不动。
    expect(out.results[0].changes).toEqual([
      { from: 0, to: 0, kind: 'stay', delta: 0 },
      { from: 0, to: 2, kind: 'move', delta: 2 },
      { from: 0, to: 2, kind: 'move', delta: 2 },
      { from: 0, to: 0, kind: 'stay', delta: 0 },
    ]);
    // 第 3 名：一根弦被闷掉。
    expect(out.results[2].changes).toEqual([
      { from: 0, to: 0, kind: 'stay', delta: 0 },
      { from: 0, to: 2, kind: 'move', delta: 2 },
      { from: 0, to: -1, kind: 'mute', delta: 0 },
      { from: 0, to: 0, kind: 'stay', delta: 0 },
    ]);
  });

  it('起点形状本身合法时恒为切换 #1（闷变 0、移动量 0）', () => {
    const from = [0, -1, -1, 1, 0, 0];
    const out = searchTransitions({ tuning: STD, targets: [4, 8, 11], maxFret: 5, from });
    expect(out.results.length).toBeGreaterThan(1);
    expect(out.results[0].result.shape).toEqual(from);
    expect(out.results[0].muteChanges).toBe(0);
    expect(out.results[0].movement).toBe(0);
    expect(out.results[0].changes.every((c) => c.kind === 'stay' || c.kind === 'keep_muted')).toBe(true);
  });

  it('排序键单调：闷变 → 移动量 → 跨度 → 品位总和 → 形状向量', () => {
    const out = searchTransitions({ tuning: STD, targets: [4, 8, 11], maxFret: 5, from: [0, -1, -1, 1, 0, 0] });
    expect(out.results.length).toBeGreaterThan(1);
    for (let i = 1; i < out.results.length; i++) {
      const a = out.results[i - 1];
      const b = out.results[i];
      if (a.muteChanges !== b.muteChanges) {
        expect(a.muteChanges).toBeLessThan(b.muteChanges);
      } else if (a.movement !== b.movement) {
        expect(a.movement).toBeLessThan(b.movement);
      } else if (a.result.span !== b.result.span) {
        expect(a.result.span).toBeLessThan(b.result.span);
      } else if (a.result.fretSum !== b.result.fretSum) {
        expect(a.result.fretSum).toBeLessThan(b.result.fretSum);
      } else {
        expect(compareShape(a.result.shape, b.result.shape)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('limit 截断与 truncated 标记；前缀与全量一致', () => {
    const input = { tuning: [40, 45, 50, 55], targets: [4, 7, 11], maxFret: 9, minStrings: 1, from: [0, 0, 0, 0] };
    const t5 = searchTransitions({ ...input, limit: 5 });
    expect(t5.results.length).toBe(5);
    expect(t5.valid).toBe(25);
    expect(t5.truncated).toBe(true);
    const tall = searchTransitions({ ...input, limit: 1000 });
    expect(tall.results.length).toBe(25);
    expect(tall.truncated).toBe(false);
    expect(t5.results.map((r) => r.result.shape)).toEqual(
      tall.results.slice(0, 5).map((r) => r.result.shape),
    );
  });
});

describe('不截取旧搜索前 20 名再重排', () => {
  // 4 弦 9 品共 25 个合法形状：旧榜第 21–25 名在旧规则下根本进不了前 20。
  const input = { tuning: [40, 45, 50, 55], targets: [4, 7, 11], maxFret: 9, minStrings: 1 };

  it('切换前 20 含有单和弦榜 20 名之外的形状', () => {
    const plain = searchChords({ ...input, limit: 1000 });
    expect(plain.valid).toBe(25);
    const rankOf = (shape: Shape) =>
      plain.results.findIndex((r) => compareShape(r.shape, shape) === 0);

    // 起点取单和弦榜最后一名 [7,7,5,9]（第 25 名）。
    const from = plain.results[24].shape;
    expect(from).toEqual([7, 7, 5, 9]);

    const out = searchTransitions({ ...input, from });
    expect(out.results.length).toBe(20);
    expect(out.truncated).toBe(true);

    // 切换 #1 即起点本身：它在单和弦榜排第 25，旧榜前 20 重排不可能得到它。
    expect(out.results[0].result.shape).toEqual([7, 7, 5, 9]);
    expect(rankOf(out.results[0].result.shape)).toBe(24);

    // 切换前 20 中至少有 5 个形状来自单和弦榜 20 名之外。
    const beyond = out.results.filter((r) => rankOf(r.result.shape) >= 20);
    expect(beyond.length).toBeGreaterThanOrEqual(5);

    // 切换结果集合与全量合法形状一致（仅顺序不同），一个不少。
    const all = searchTransitions({ ...input, from, limit: 1000 });
    const key = (s: Shape) => s.join(',');
    expect(new Set(all.results.map((r) => key(r.result.shape)))).toEqual(
      new Set(plain.results.map((r) => key(r.shape))),
    );
  });
});

describe('切换预演的横按约束', () => {
  const F_MAJOR = [1, 3, 3, 2, 1, 1];
  const from = [0, 2, 2, 1, 0, 0]; // E 大三开放形状

  it('横按模式下切换结果的指法结论与 bestFingering 逐项一致', () => {
    const out = searchTransitions({
      tuning: STD,
      targets: [0, 5, 9],
      maxFret: 5,
      from,
      allowBarre: true,
      limit: 100000,
    });
    expect(out.results.some((r) => r.result.barre)).toBe(true);
    for (const r of out.results) {
      // 列表与 SVG 共用的同一份结论：直接来自搜索引擎，不再重算。
      expect(bestFingering(r.result.shape, true)).toEqual({
        fingers: r.result.fingers,
        barre: r.result.barre ?? null,
      });
      expect(r.result.fingers).toBeLessThanOrEqual(4);
      if (r.result.barre) {
        const seg = r.result.shape.slice(r.result.barre.from, r.result.barre.to + 1);
        expect(seg.every((f) => f >= r.result.barre!.fret)).toBe(true);
        expect(seg.filter((f) => f === r.result.barre!.fret).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('F 大三全横按形状成为切换 #1；默认模式缺席且不携带 barre 字段', () => {
    const on = searchTransitions({
      tuning: STD,
      targets: [0, 5, 9],
      maxFret: 5,
      from,
      allowBarre: true,
      limit: 100000,
    });
    const hit = on.results.find((r) => compareShape(r.result.shape, F_MAJOR) === 0);
    expect(hit).toBeDefined();
    expect(hit!.result.barre).toEqual({ fret: 1, from: 0, to: 5 });
    expect(hit!.result.fingers).toBe(4);
    // 从 E 开放形状到 F 横按：全部弦保持发声，移动量 6，恰为切换 #1。
    expect(hit!.muteChanges).toBe(0);
    expect(hit!.movement).toBe(6);
    expect(on.results[0].result.shape).toEqual(F_MAJOR);

    // 默认模式：同一形状逐弦计指 6 > 4，被现有指法判定排除。
    const off = searchTransitions({ tuning: STD, targets: [0, 5, 9], maxFret: 5, from, limit: 100000 });
    expect(off.results.some((r) => compareShape(r.result.shape, F_MAJOR) === 0)).toBe(false);
    expect(off.results.every((r) => !('barre' in r.result))).toBe(true);
    expect(off.valid).toBeLessThan(on.valid);
  });
});

describe('切换预演输入校验与空结果', () => {
  const base = { tuning: [40, 45, 50], targets: [4, 7, 11], maxFret: 3 };

  it('from 形状非法时抛错', () => {
    expect(() => searchTransitions({ ...base, from: [0, 0] })).toThrow('长度');
    expect(() => searchTransitions({ ...base, from: [0, 0, 4] })).toThrow('品位');
    expect(() => searchTransitions({ ...base, from: [0, 0, -2] })).toThrow('品位');
    expect(() => searchTransitions({ ...base, from: [0, 0, 1.5] })).toThrow('品位');
  });

  it('无合法下一形状时返回空结果', () => {
    // 3 品内只有 A 弦（C 3 品）与 B 弦（C/C# 1/2 品）能出 {C,C#}，响弦最多 2 < 3。
    const out = searchTransitions({
      tuning: STD,
      targets: [0, 1],
      maxFret: 3,
      from: [0, -1, -1, 1, 0, 0],
    });
    expect(out.valid).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe((3 + 2) ** 6);
    expect(out.from).toEqual([0, -1, -1, 1, 0, 0]);
  });
});
