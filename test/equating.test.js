import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeSeason } from './helpers/fixture.js'
import {
  activeRecusals,
  buildScoringRows,
  buildLinkEdges,
  buildComponents,
  buildEquating,
  estimateJudgeEffects,
  comparePair,
} from '../src/equating.js'

test('无回避时：共评边把两名评委连成一个分量，宽严按共评作品估计而非组均值', () => {
  const season = makeSeason()
  const eq = buildEquating(season)
  // E1、E2 均为 J1/J2 同作品共评 → 1 个主分量含 J1、J2；J3 独立。
  const judgesByComp = eq.components.map((c) => c.judges)
  assert.ok(judgesByComp.some((j) => j.includes('J1') && j.includes('J2')))
  assert.ok(judgesByComp.some((j) => j.includes('J3') && j.length === 1))
  // J2 在两件共评作品上都比 J1 低 6~7 分，估计为更严（宽严为负）。
  const j2Bias = eq.effects.get('J2')
  assert.ok(j2Bias < 0, `J2 宽严应为负（更严），实际 ${j2Bias}`)
  // 调整后 E1 与 E2 的作品水准差保持原始差距，不被组均值平移抹掉。
  const e1 = eq.entries.find((r) => r.entry === 'E1')
  const e2 = eq.entries.find((r) => r.entry === 'E2')
  assert.ok(Math.abs((e1.adjustedMean - e2.adjustedMean) - 1.5) < 0.51)
})

test('回避追溯生效：同校历史评分（含明评）被剔除，共评边断裂', () => {
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
  })
  const rows = buildScoringRows(season)
  const e1j2 = rows.find((r) => r.entry === 'E1' && r.judge === 'J2')
  const e2j1 = rows.find((r) => r.entry === 'E2' && r.judge === 'J1')
  assert.ok(e1j2.excluded && e1j2.excludeReason.includes('回避'))
  assert.ok(e2j1.excluded && e2j1.excludeReason.includes('回避'))
  // 两条共评边都失去一侧 → 无边、分量拆开。
  const edges = buildLinkEdges(rows)
  assert.equal(edges.length, 0)
  const { components } = buildComponents(rows, edges)
  assert.equal(components.length, 3)
})

test('state 非“回避”的记录不生效', () => {
  const season = makeSeason({
    recusals: [{ judge: 'J2', school: 'S1', revision: '1', state: '已撤销' }],
  })
  assert.equal(activeRecusals(season).size, 0)
  const rows = buildScoringRows(season)
  assert.ok(!rows.find((r) => r.entry === 'E1' && r.judge === 'J2').excluded)
})

test('同院校不同作品不构成连接：只有同作品共评才产生边', () => {
  const season = makeSeason({
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'no' },
      { entry: 'E3', judge: 'J2', round: '1', method: '盲', design: '84', version: '1', shared: 'no' },
      { entry: 'E5', judge: 'J3', round: '1', method: '盲', design: '92', version: '2', shared: 'no' },
    ],
  })
  const rows = buildScoringRows(season)
  assert.equal(buildLinkEdges(rows).length, 0)
  const { components } = buildComponents(rows, buildLinkEdges(rows))
  // J1、J2 虽都评过 S1/S3 同赛道作品，但没有同作品共评 → 各自独立。
  assert.equal(components.length, 3)
})

test('共评边要求盲评、shared=yes、同版本，任一不满足即不连接', () => {
  const season = makeSeason({
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E1', judge: 'J2', round: '1', method: '明', design: '81', version: '1', shared: 'yes' },
      { entry: 'E2', judge: 'J1', round: '1', method: '盲', design: '86', version: '1', shared: 'no' },
      { entry: 'E2', judge: 'J2', round: '1', method: '盲', design: '80', version: '1', shared: 'no' },
      { entry: 'E3', judge: 'J1', round: '1', method: '盲', design: '90', version: '1', shared: 'yes' },
      { entry: 'E3', judge: 'J3', round: '1', method: '盲', design: '89', version: '2', shared: 'yes' },
    ],
  })
  const edges = buildLinkEdges(buildScoringRows(season))
  assert.equal(edges.length, 0)
})

test('不同连通分量不可比较；同分量有共同评委为确定次序；版本混合仅弱比较', () => {
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
  })
  const eq = buildEquating(season)
  const e3 = eq.entries.find((r) => r.entry === 'E3') // J1 分量
  const e4 = eq.entries.find((r) => r.entry === 'E4') // J2 分量
  const e5 = eq.entries.find((r) => r.entry === 'E5') // J3 分量，版本 2
  assert.equal(comparePair(e3, e4, eq.diagnostics, eq.rows).strength, 'undecidable')
  const e1 = eq.entries.find((r) => r.entry === 'E1')
  assert.equal(comparePair(e1, e3, eq.diagnostics, eq.rows).strength, 'direct')
  // 同分量不同版本 → 弱比较
  const seasonMixed = makeSeason({
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E1', judge: 'J2', round: '1', method: '盲', design: '88', version: '2', shared: 'yes' },
      { entry: 'E3', judge: 'J1', round: '1', method: '盲', design: '90', version: '1', shared: 'no' },
    ],
  })
  const eqMixed = buildEquating(seasonMixed)
  const a = eqMixed.entries.find((r) => r.entry === 'E1')
  const b = eqMixed.entries.find((r) => r.entry === 'E3')
  assert.ok(a.caliberMixed)
  assert.equal(comparePair(a, b, eqMixed.diagnostics, eqMixed.rows).strength, 'weak')
})

test('单评委分量宽严为 0，调整分等于原始有效盲评分', () => {
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
  })
  const eq = buildEquating(season)
  const j1Only = eq.components.find((c) => c.judges.length === 1 && c.judges[0] === 'J1')
  assert.ok(j1Only)
  assert.equal(eq.effects.get('J1'), 0)
  const e3 = eq.entries.find((r) => r.entry === 'E3')
  assert.equal(e3.adjustedMean, 90)
})

test('估计过程收敛且对共评边数量敏感：移除一条边仍可由另一条边锚定', () => {
  const season = makeSeason()
  const rows = buildScoringRows(season)
  const edges = buildLinkEdges(rows)
  const { components } = buildComponents(rows, edges)
  const { effects, diagnostics } = estimateJudgeEffects(rows, components)
  assert.ok([...effects.values()].every(Number.isFinite))
  const main = diagnostics.find((d) => d.linkEdges === 2)
  assert.ok(main.iterations < 200)
})
