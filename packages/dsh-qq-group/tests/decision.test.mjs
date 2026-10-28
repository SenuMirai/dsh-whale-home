import assert from 'node:assert/strict';
import { decide, DECISIVE_P, DECISIVE_LEAD } from '../src/qq/decision.ts';

// ── 一边倒：直接拍板，不摇骰子 ──
{
  let rolls = 0;
  const random = () => {
    rolls += 1;
    return 0.99;
  };
  const result = decide(
    [
      { value: 'A', weight: 8 },
      { value: 'B', weight: 1 },
      { value: 'C', weight: 1 },
    ],
    random,
  );
  assert.equal(result.value, 'A');
  assert.equal(result.decisive, true);
  assert.equal(rolls, 0, '一边倒时不该摇骰子');
  assert.ok(result.topP >= DECISIVE_P);
  assert.ok(result.lead >= DECISIVE_LEAD);
}

// ── 竞争态：要摇 ──
{
  let rolls = 0;
  const random = () => {
    rolls += 1;
    return 0.9; // 落在最后一个
  };
  const result = decide(
    [
      { value: 'A', weight: 1 },
      { value: 'B', weight: 1 },
    ],
    random,
  );
  assert.equal(result.decisive, false, '五五开该摇');
  assert.equal(rolls, 1);
  assert.ok(['A', 'B'].includes(result.value));
}

// ── 只有一个选项：不必摇 ──
{
  const result = decide([{ value: 'only', weight: 3 }], () => {
    throw new Error('不该摇');
  });
  assert.equal(result.value, 'only');
  assert.equal(result.decisive, true);
}

// ── 空选项 / 全零权重 ──
{
  assert.equal(decide([]).value, undefined);
  assert.equal(decide([{ value: 'x', weight: 0 }]).value, undefined);
  assert.equal(decide([{ value: 'x', weight: -5 }]).value, undefined);
}

// ── 权重不带归一化也能用 ──
{
  const result = decide(
    [
      { value: 'big', weight: 900 },
      { value: 'small', weight: 100 },
    ],
    () => 0,
  );
  assert.equal(result.value, 'big');
  assert.ok(Math.abs(result.topP - 0.9) < 1e-9);
}

// ── 抽样分布大致符合权重（固定种子不可用，只验证区间） ──
{
  const counts = { A: 0, B: 0 };
  // 竞争态：1:1，摇 400 次应该在 150~250 之间
  for (let i = 0; i < 400; i += 1) {
    const result = decide(
      [
        { value: 'A', weight: 1 },
        { value: 'B', weight: 1 },
      ],
      Math.random,
    );
    counts[result.value] += 1;
  }
  assert.ok(counts.A > 120 && counts.A < 280, `A 的分布异常：${counts.A}`);
}

console.log('decision: all assertions passed');
