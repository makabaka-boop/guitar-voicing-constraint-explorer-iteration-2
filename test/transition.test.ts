import { describe, expect, it } from 'vitest';
import {
  compareShape,
  pcOfMidi,
  searchChords,
  searchTransitions,
  transitionChanges,
  type Barre,
  type ChordResult,
  type Fingering,
  type Shape,
  type TransitionCandidate,
} from '../src/search';

/**
 * 独立参考实现：直白的笛卡尔积全枚举下一和弦合法形状，
 * 再以切换代价排序（不剪枝、不与 src 共享代码），与 searchTransitions 对拍。
 */
function referenceFingering(shape: number[], allowBarre: boolean): Fingering {
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
  current: number[];
  nextTargets: number[];
  maxFret: number;
  minStrings?: number;
  maxFingers?: number;
  maxSpan?: number;
  allowBarre?: boolean;
  limit?: number;
}): {
  candidates: (TransitionCandidate & { result: ChordResult & { barre: Barre | null } })[];
  valid: number;
  total: number;
  truncated: boolean;
} {
  const { tuning, current, maxFret } = opts;
  const minStrings = opts.minStrings ?? 3;
  const maxFingers = opts.maxFingers ?? 4;
  const maxSpan = opts.maxSpan ?? 4;
  const allowBarre = opts.allowBarre ?? false;
  const limit = opts.limit ?? 20;
  const targetSet = new Set(opts.nextTargets);

  const choices: number[] = [-1, ...Array.from({ length: maxFret + 1 }, (_, f) => f)];
  let combos: number[][] = [[]];
  for (let s = 0; s < tuning.length; s++) {
    combos = combos.flatMap((prefix) => choices.map((c) => [...prefix, c]));
  }

  const valid: (ChordResult & { barre: Barre | null })[] = [];
  for (const shape of combos) {
    const ringing = shape.filter((f) => f !== -1);
    if (ringing.length < minStrings) continue;
    const midi = shape.map((f, s) => (f === -1 ? null : tuning[s] + f));
    const pcs = midi.filter((m): m is number => m !== null).map(pcOfMidi);
    if (pcs.some((p) => !targetSet.has(p))) continue;
    if (![...targetSet].every((t) => pcs.includes(t))) continue;
    const pressed = ringing.filter((f) => f > 0);
    const span = pressed.length === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
    const fing = referenceFingering(shape, allowBarre);
    if (allowBarre) {
      if (span > maxSpan) continue;
      if (fing.fingers > maxFingers) continue;
    } else {
      if (fing.fingers > maxFingers) continue;
      if (span > maxSpan) continue;
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

  const candidates = valid.map((result) => {
    let mutedChanges = 0;
    let fretMove = 0;
    const changes = current.map((f, s) => {
      const t = result.shape[s];
      const mutedChange = (f === -1) !== (t === -1);
      if (mutedChange) mutedChanges++;
      const sharedRinging = f !== -1 && t !== -1;
      const move = sharedRinging ? Math.abs(f - t) : 0;
      fretMove += move;
      return { from: f, to: t, mutedChange, sharedRinging, fretMove: move };
    });
    return { result, mutedChanges, fretMove, changes };
  });

  candidates.sort((a, b) => {
    if (a.mutedChanges !== b.mutedChanges) return a.mutedChanges - b.mutedChanges;
    if (a.fretMove !== b.fretMove) return a.fretMove - b.fretMove;
    if (a.result.span !== b.result.span) return a.result.span - b.result.span;
    if (a.result.fretSum !== b.result.fretSum) return a.result.fretSum - b.result.fretSum;
    return compareShape(a.result.shape, b.result.shape);
  });

  return {
    candidates: candidates.slice(0, limit),
    valid: candidates.length,
    total: combos.length,
    truncated: candidates.length > limit,
  };
}

const TUNINGS_3 = {
  gbeHigh: [67, 71, 76],
  gbeLow: [40, 44, 49],
  ead: [40, 45, 50],
};

describe('双和弦切换预演：小指板全枚举对拍', () => {
  const cases: {
    tuning: number[];
    current: number[];
    nextTargets: number[];
    maxFret: number;
    allowBarre?: boolean;
    maxFingers?: number;
  }[] = [
    { tuning: TUNINGS_3.gbeHigh, current: [0, 0, 0], nextTargets: [4, 8, 11], maxFret: 3 },
    { tuning: TUNINGS_3.gbeHigh, current: [2, -1, 2], nextTargets: [4, 8, 11], maxFret: 4 },
    { tuning: TUNINGS_3.gbeLow, current: [-1, -1, 1], nextTargets: [9, 0, 4], maxFret: 4 },
    { tuning: TUNINGS_3.gbeLow, current: [3, 3, 3], nextTargets: [9, 0, 4], maxFret: 5 },
    { tuning: TUNINGS_3.ead, current: [2, 2, -1], nextTargets: [2, 6, 9], maxFret: 6 },
    { tuning: TUNINGS_3.ead, current: [0, 0, 0], nextTargets: [0, 3], maxFret: 3 },
    { tuning: TUNINGS_3.gbeHigh, current: [1, 1, 1], nextTargets: [1, 3, 6, 8, 10], maxFret: 4 },
    // 单横按模式：下一形状合法性与横按结论同样由参考实现对拍。
    { tuning: TUNINGS_3.gbeHigh, current: [1, 1, 0], nextTargets: [4, 8, 11], maxFret: 3, allowBarre: true },
    { tuning: TUNINGS_3.ead, current: [3, 3, 0], nextTargets: [2, 6, 9], maxFret: 4, allowBarre: true, maxFingers: 2 },
    {
      tuning: [40, 44, 49, 54],
      current: [1, 3, 3, 2],
      nextTargets: [0, 5, 9],
      maxFret: 4,
      allowBarre: true,
    },
  ];

  for (const c of cases) {
    it(`tuning=[${c.tuning}] current=[${c.current}] → {${c.nextTargets}} barre=${!!c.allowBarre}`, () => {
      const got = searchTransitions({ ...c, minStrings: 1 });
      const want = referenceTransitions({ ...c, minStrings: 1 });
      const tag = `[${c.current}] → {${c.nextTargets}}`;

      expect(got.total, tag).toBe(want.total);
      expect(got.valid, tag).toBe(want.valid);
      expect(got.truncated, tag).toBe(want.truncated);
      expect(got.candidates.length, tag).toBe(want.candidates.length);

      got.candidates.forEach((cand, i) => {
        const w = want.candidates[i];
        expect(cand.mutedChanges, `${tag} #${i} mutedChanges`).toBe(w.mutedChanges);
        expect(cand.fretMove, `${tag} #${i} fretMove`).toBe(w.fretMove);
        expect(cand.changes, `${tag} #${i} changes`).toEqual(w.changes);
        expect(cand.result.shape, `${tag} #${i} shape`).toEqual(w.result.shape);
        expect(cand.result.span, `${tag} #${i} span`).toBe(w.result.span);
        expect(cand.result.fretSum, `${tag} #${i} fretSum`).toBe(w.result.fretSum);
        expect(cand.result.fingers, `${tag} #${i} fingers`).toBe(w.result.fingers);
        expect(cand.result.ringing, `${tag} #${i} ringing`).toBe(w.result.ringing);
        expect(cand.result.midi, `${tag} #${i} midi`).toEqual(w.result.midi);
        if (c.allowBarre) {
          expect(cand.result.barre ?? null, `${tag} #${i} barre`).toEqual(w.result.barre);
        } else {
          // 默认模式候选不携带横按结论。
          expect('barre' in cand.result, `${tag} #${i} 默认模式无 barre 字段`).toBe(false);
        }
      });
    });
  }

  it('逐弦变化字段与代价计算', () => {
    expect(transitionChanges([0, 2, -1], [0, 3, -1])).toEqual({
      mutedChanges: 0,
      fretMove: 1,
      changes: [
        { from: 0, to: 0, mutedChange: false, sharedRinging: true, fretMove: 0 },
        { from: 2, to: 3, mutedChange: false, sharedRinging: true, fretMove: 1 },
        { from: -1, to: -1, mutedChange: false, sharedRinging: false, fretMove: 0 },
      ],
    });
    // x ↔ 发声：计闷音变化，不计品位移动量。
    const t2 = transitionChanges([-1, 0], [0, 0]);
    expect(t2.mutedChanges).toBe(1);
    expect(t2.fretMove).toBe(0);
    expect(t2.changes[0]).toMatchObject({ mutedChange: true, sharedRinging: false });
    // 两侧都发生 x↔发声：闷变 2，移动量仍为 0。
    const t3 = transitionChanges([-1, 2, 0], [3, -1, 0]);
    expect(t3.mutedChanges).toBe(2);
    expect(t3.fretMove).toBe(0);
    // 全部共同发声：移动量逐弦求和。
    expect(transitionChanges([1, 2, 3], [3, 2, 0]).fretMove).toBe(2 + 0 + 3);
  });

  it('长度不一致直接报错', () => {
    expect(() => transitionChanges([0, 0], [0, 0, 0])).toThrow();
  });
});

describe('双和弦切换预演：排序键语义', () => {
  it('闷音变化弦数优先，其次共同发声品位移动量；并列再走跨度/总和/向量', () => {
    const out = searchTransitions({
      tuning: TUNINGS_3.ead,
      current: [2, 2, 0],
      nextTargets: [2, 6, 9],
      maxFret: 6,
      minStrings: 1,
    });
    expect(out.candidates.length).toBeGreaterThan(1);
    for (let i = 1; i < out.candidates.length; i++) {
      const a = out.candidates[i - 1];
      const b = out.candidates[i];
      if (a.mutedChanges !== b.mutedChanges) {
        expect(a.mutedChanges).toBeLessThan(b.mutedChanges);
      } else if (a.fretMove !== b.fretMove) {
        expect(a.fretMove).toBeLessThan(b.fretMove);
      } else if (a.result.span !== b.result.span) {
        expect(a.result.span).toBeLessThan(b.result.span);
      } else if (a.result.fretSum !== b.result.fretSum) {
        expect(a.result.fretSum).toBeLessThan(b.result.fretSum);
      } else {
        expect(compareShape(a.result.shape, b.result.shape)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('同代价候选按形状向量兜底：真实平局对的形状向量必须非递减', () => {
    // 在 6 弦标准定弦 E 大三上，枚举全部下一形状并找一对闷变、移动量、
    // 跨度、总和都相同但形状不同的候选，验证其相对顺序遵循形状向量字典序。
    const STD = [40, 45, 50, 55, 59, 64];
    const tr = searchTransitions({
      tuning: STD,
      current: [0, 2, 2, 1, 0, 0],
      nextTargets: [4, 8, 11],
      maxFret: 5,
      limit: 100_000,
    });
    let found = false;
    for (let i = 1; i < tr.candidates.length; i++) {
      const a = tr.candidates[i - 1];
      const b = tr.candidates[i];
      if (
        a.mutedChanges === b.mutedChanges &&
        a.fretMove === b.fretMove &&
        a.result.span === b.result.span &&
        a.result.fretSum === b.result.fretSum &&
        compareShape(a.result.shape, b.result.shape) !== 0
      ) {
        found = true;
        expect(compareShape(a.result.shape, b.result.shape)).toBe(-1);
      }
    }
    expect(found, '该场景下应至少存在一对需要形状向量兜底的候选').toBe(true);
  });

  it('切换预演不会先截单和弦前 20 名：最省动作的形状可落在单和弦 20 名之外', () => {
    // 5 弦小指板、minStrings=1，合法形状远多于 20；用全枚举验证。
    const input = {
      tuning: [23, 28, 33, 38, 43],
      nextTargets: [2, 6, 9],
      maxFret: 6,
      minStrings: 1 as const,
    };
    // 全部合法下一形状（单和弦排序）。
    const full = searchChords({ ...input, targets: input.nextTargets, limit: 100_000 });
    expect(full.results.length).toBeGreaterThan(20);
    // 取单和弦排序中靠后的一个合法形状作为当前形状：它自身的切换代价为
    // （闷变 0、移动 0），必为切换排序第一，但不在单和弦前 20 名内。
    const deep = full.results[full.results.length - 1];
    const singleIndex = full.results.findIndex((r) => compareShape(r.shape, deep.shape) === 0);
    expect(singleIndex).toBeGreaterThan(20);

    const tr = searchTransitions({ ...input, current: deep.shape });
    expect(tr.valid).toBe(full.results.length);
    expect(tr.truncated).toBe(full.results.length > 20);
    expect(compareShape(tr.candidates[0].result.shape, deep.shape)).toBe(0);
    expect(tr.candidates[0].mutedChanges).toBe(0);
    expect(tr.candidates[0].fretMove).toBe(0);
  });

  it('limit 生效：默认 20、truncated 与计数正确', () => {
    const input = {
      tuning: [23, 28, 33, 38, 43],
      nextTargets: [2, 6, 9],
      maxFret: 6,
      minStrings: 1 as const,
    };
    const full = searchChords({ ...input, targets: input.nextTargets, limit: 100_000 });
    const tr = searchTransitions({ ...input, current: [0, 0, 0, 0, 0] });
    expect(tr.candidates.length).toBe(20);
    expect(tr.valid).toBe(full.results.length);
    expect(tr.truncated).toBe(true);
    const all = searchTransitions({ ...input, current: [0, 0, 0, 0, 0], limit: 100_000 });
    expect(all.candidates.length).toBe(all.valid);
    expect(all.truncated).toBe(false);
  });
});

describe('双和弦切换预演：合法性与边界', () => {
  it('无合法下一形状时明确给出空结果（valid=0、candidates=[]）', () => {
    // 4 弦贝斯、最大 3 品：音级 1(C#) 在任何弦的 0..3 品都不可达。
    const tr = searchTransitions({
      tuning: [28, 33, 38, 43],
      current: [-1, 0, 2, 2],
      nextTargets: [0, 1],
      maxFret: 3,
    });
    expect(tr.valid).toBe(0);
    expect(tr.candidates).toEqual([]);
    expect(tr.total).toBe(5 ** 4);
  });

  it('起点只需结构合法：本身不必属于下一和弦，也不必是单和弦结果', () => {
    // 起点含目标外音级也能预演；它只决定切换代价，不参与下一形状合法性。
    const tr = searchTransitions({
      tuning: TUNINGS_3.gbeHigh,
      current: [1, 1, 1],
      nextTargets: [4, 8, 11],
      maxFret: 3,
      minStrings: 1,
    });
    expect(tr.valid).toBeGreaterThan(0);
    expect(tr.candidates.every((c) => c.changes.length === 3)).toBe(true);
  });

  it('参数校验：弦数不一致、品位越界、下一目标非法均抛错', () => {
    expect(() =>
      searchTransitions({ tuning: TUNINGS_3.gbeHigh, current: [0, 0], nextTargets: [4, 8], maxFret: 3 }),
    ).toThrow();
    expect(() =>
      searchTransitions({ tuning: TUNINGS_3.gbeHigh, current: [0, 0, 9], nextTargets: [4, 8], maxFret: 3 }),
    ).toThrow();
    expect(() =>
      searchTransitions({ tuning: TUNINGS_3.gbeHigh, current: [0, 0, -2], nextTargets: [4, 8], maxFret: 3 }),
    ).toThrow();
    expect(() =>
      searchTransitions({ tuning: TUNINGS_3.gbeHigh, current: [0, 0, 0], nextTargets: [4, 13], maxFret: 3 }),
    ).toThrow();
    expect(() =>
      searchTransitions({ tuning: TUNINGS_3.gbeHigh, current: [0, 0, 0], nextTargets: [], maxFret: 3 }),
    ).toThrow();
  });

  it('全部候选的下一形状都是当前约束下的合法形状', () => {
    const opts = {
      tuning: TUNINGS_3.gbeLow,
      current: [2, 0, -1],
      nextTargets: [9, 0, 4],
      maxFret: 5,
      minStrings: 1,
    };
    const tr = searchTransitions(opts);
    const single = searchChords({
      tuning: opts.tuning,
      targets: opts.nextTargets,
      maxFret: opts.maxFret,
      minStrings: 1,
      limit: 100_000,
    });
    const legalShapes = new Set(single.results.map((r) => r.shape.join(',')));
    expect(tr.candidates.length).toBeGreaterThan(0);
    for (const cand of tr.candidates) {
      expect(legalShapes.has(cand.result.shape.join(','))).toBe(true);
    }
  });

  it('默认约束（响弦≥3）同样遵守 minStrings', () => {
    const tr = searchTransitions({
      tuning: TUNINGS_3.gbeHigh,
      current: [0, 0, 0],
      nextTargets: [4, 8, 11],
      maxFret: 3,
    });
    expect(tr.candidates.every((c) => c.result.ringing >= 3)).toBe(true);
  });
});

describe('双和弦切换预演：单横按约束', () => {
  const STD = [40, 45, 50, 55, 59, 64];

  it('横按才能按出的下一形状进入候选，横按结论直接取自搜索枚举', () => {
    const fShape: Shape = [1, 3, 3, 2, 1, 1]; // F 大三 1 品全横按
    const on = searchTransitions({
      tuning: STD,
      current: fShape,
      nextTargets: [0, 5, 9],
      maxFret: 5,
      allowBarre: true,
      limit: 100_000,
    });
    // 零切换代价：该形状在横按模式合法，必排第一。
    expect(on.candidates[0].result.shape).toEqual(fShape);
    expect(on.candidates[0].result.fingers).toBe(4);
    expect(on.candidates[0].result.barre).toEqual({ fret: 1, from: 0, to: 5 });

    // 默认模式：同一形状被 4 指闸门排除，候选集合不同且零代价候选不是它。
    const off = searchTransitions({
      tuning: STD,
      current: fShape,
      nextTargets: [0, 5, 9],
      maxFret: 5,
      allowBarre: false,
      limit: 100_000,
    });
    expect(off.valid).toBeLessThan(on.valid);
    expect(off.candidates.some((c) => compareShape(c.result.shape, fShape) === 0)).toBe(false);
  });

  it('横按模式小样本：候选的 fingers/barre 与参考全枚举一致（含排序）', () => {
    const c = {
      tuning: [40, 45, 50, 55],
      current: [1, 1, 3, 3],
      nextTargets: [0, 4, 7],
      maxFret: 4,
      allowBarre: true,
      maxFingers: 2,
    };
    const got = searchTransitions({ ...c, minStrings: 2 });
    const want = referenceTransitions({ ...c, minStrings: 2 });
    expect(got.valid).toBe(want.valid);
    expect(got.candidates.map((c2) => c2.result.shape)).toEqual(
      want.candidates.map((c2) => c2.result.shape),
    );
    got.candidates.forEach((cand, i) => {
      expect(cand.result.barre ?? null).toEqual(want.candidates[i].result.barre);
      expect(cand.result.fingers).toBe(want.candidates[i].result.fingers);
      expect(cand.mutedChanges).toBe(want.candidates[i].mutedChanges);
      expect(cand.fretMove).toBe(want.candidates[i].fretMove);
    });
  });
});

describe('双和弦切换预演：移调不变性', () => {
  it('定弦与下一目标同时移调：候选形状序列、代价与排序完全不变', () => {
    const base = {
      tuning: [40, 45, 50, 55],
      current: [0, 2, 2, -1],
      nextTargets: [2, 6, 9],
      maxFret: 6,
      minStrings: 1,
    };
    const a = searchTransitions(base);
    for (const k of [-3, 1, 5, 12]) {
      const b = searchTransitions({
        ...base,
        tuning: base.tuning.map((m) => m + k),
        nextTargets: base.nextTargets.map((t) => (t + k + 1200) % 12),
      });
      expect(b.candidates.map((c) => c.result.shape)).toEqual(a.candidates.map((c) => c.result.shape));
      expect(b.candidates.map((c) => [c.mutedChanges, c.fretMove])).toEqual(
        a.candidates.map((c) => [c.mutedChanges, c.fretMove]),
      );
    }
  });
});
