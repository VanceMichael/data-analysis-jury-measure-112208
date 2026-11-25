import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeSeason } from './helpers/fixture.js'
import { buildEquating } from '../src/equating.js'
import { planSupplementaryReviews } from '../src/planner.js'

// 复用真实赛季的断裂结构：J2-S1、J1-S2 回避后 J1 与 J2 断开。
function brokenSeason(overrides = {}) {
  return makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
    // J2 来自另一已有分量，J4 是新评委；二者对 J1 分量作品补评即可桥接。
    judge_availability: [
      { judge: 'J1', round: '3', language: '中', slots: '1', edition: 'V1' },
      { judge: 'J2', round: '3', language: '中+英', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中+英', slots: '2', edition: 'V1' },
    ],
    ...overrides,
  })
}

test('补评建议只使用登记的空闲评委与剩余轮次', () => {
  const season = brokenSeason()
  const plan = planSupplementaryReviews(season, buildEquating(season))
  for (const s of plan.suggestions) {
    assert.equal(s.round, 3)
    for (const j of s.judges) {
      assert.ok(season.judge_availability.some((a) => a.judge === j && Number(a.round) === s.round))
    }
  }
  assert.ok(plan.suggestions.length > 0)
})

test('建议必须合并两个已有分量；新评委单独参与不构成有效建议', () => {
  const season = brokenSeason({
    judge_availability: [
      // J5 是没有任何历史评分的新评委。
      { judge: 'J5', round: '3', language: '中+英', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中+英', slots: '2', edition: 'V1' },
    ],
  })
  const plan = planSupplementaryReviews(season, buildEquating(season))
  // J4 与 J5 都不在任何历史分量里 → 无法连接两个已有分量，不应给建议。
  assert.equal(plan.suggestions.length, 0)
})

test('回避约束对补评同样生效：对受回避院校的作品不给建议', () => {
  // J1 回避 S1；若唯一中文作品是 S1 的 E1，则 J1 不能参与该作品的补评。
  const season = brokenSeason({
    entries: [
      { entry: 'E1', track: '旅行', school: 'S1', lang: '中', edition: 'V1' },
      { entry: 'E2', track: '会展', school: 'S2', lang: '英', edition: 'V1' },
    ],
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'no' },
      { entry: 'E2', judge: 'J2', round: '1', method: '盲', design: '80', version: '1', shared: 'no' },
    ],
    judge_availability: [
      { judge: 'J1', round: '3', language: '中', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中+英', slots: '1', edition: 'V1' },
    ],
  })
  const plan = planSupplementaryReviews(season, buildEquating(season))
  assert.ok(plan.suggestions.every((s) => !(s.judges.includes('J1') && s.entry === 'E1')))
})

test('语言不匹配（含双语要求）的建议被排除', () => {
  const season = brokenSeason({
    entries: [{ entry: 'E9', track: '会展', school: 'S9', lang: '双语', edition: 'V1' }],
    scores: [
      { entry: 'E9', judge: 'J2', round: '1', method: '盲', design: '83', version: '1', shared: 'no' },
    ],
    judge_availability: [
      // J1 只会中文，不满足双语作品“中+英”要求。
      { judge: 'J1', round: '3', language: '中', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中+英', slots: '1', edition: 'V1' },
    ],
  })
  const plan = planSupplementaryReviews(season, buildEquating(season))
  assert.ok(plan.suggestions.every((s) => s.entry !== 'E9' || !s.judges.includes('J1')))
})

test('名额 slots 受限：超出空闲名额后不再继续建议占用同一评委', () => {
  const season = brokenSeason({
    judge_availability: [
      { judge: 'J1', round: '3', language: '中', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中', slots: '1', edition: 'V1' },
    ],
  })
  const plan = planSupplementaryReviews(season, buildEquating(season))
  for (const u of plan.slotUsage) {
    assert.ok(u.used <= u.total, `评委 ${u.judge} 占用 ${u.used} 超过名额 ${u.total}`)
  }
})

test('版本不匹配的作品（V2）不会出现在 V1 评委的建议中', () => {
  const season = makeSeason({
    judge_availability: [
      { judge: 'J1', round: '3', language: '中', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中+英', slots: '1', edition: 'V1' },
    ],
  })
  const plan = planSupplementaryReviews(season, buildEquating(season))
  assert.ok(plan.suggestions.every((s) => s.entry !== 'E5'))
  assert.ok(plan.unreachableComponents.length >= 1)
})

test('有效建议标注其解决的待定奖项', () => {
  const season = brokenSeason()
  const plan = planSupplementaryReviews(season, buildEquating(season))
  const bridge = plan.suggestions.find((s) => s.linksComponents.length === 2)
  assert.ok(bridge)
  assert.ok(bridge.resolves.some((r) => r.includes('P1')))
  assert.ok(bridge.mergedEntryCount >= 4)
})
