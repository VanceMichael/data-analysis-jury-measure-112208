import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeSeason } from './helpers/fixture.js'
import { buildEquating } from '../src/equating.js'
import { planSupplementaryReviews } from '../src/planner.js'
import { buildSeats, SEAT_STATUS } from '../src/seats.js'

// 端到端闭环：回避断开连接 → 规划器给建议 → 应用建议后跨赛道依据恢复。
test('端到端：补评建议落地后，失效的跨赛道奖依据恢复为可复议', () => {
  // 干净夹具：J1 评旅行 E1/E3（E1 可共评），J2 评会展 E2/E4（E2 可共评），
  // 二者历史上无同作品共评 → 两个独立分量。
  const season = makeSeason({
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E3', judge: 'J1', round: '1', method: '盲', design: '90', version: '1', shared: 'no' },
      { entry: 'E2', judge: 'J2', round: '1', method: '盲', design: '80', version: '1', shared: 'yes' },
      { entry: 'E4', judge: 'J2', round: '1', method: '盲', design: '82', version: '1', shared: 'no' },
      { entry: 'E5', judge: 'J3', round: '1', method: '盲', design: '92', version: '2', shared: 'no' },
    ],
    recusals: [],
    judge_availability: [
      { judge: 'J2', round: '3', language: '中+英', slots: '1', edition: 'V1' },
    ],
    decisions: [{ entry: 'E2', prize: 'P1', version: '1', state: '待接受' }],
    answer_records: [{ prize: 'P1', entry: 'E2', at: '10', answer: '复议', state: '待确认' }],
  })

  const before = buildEquating(season)
  assert.equal(before.components.length, 3)
  const seatsBefore = buildSeats(season, before)
  assert.equal(
    seatsBefore.prizes.find((p) => p.prize === 'P1').seats[0].status,
    SEAT_STATUS.BASIS_INVALID,
  )

  const plan = planSupplementaryReviews(season, before)
  // J2 单人补评可共评作品 E1（J1 已 shared=yes）即可桥接，只需 1 个名额。
  const bridge = plan.suggestions.find((s) => s.linksComponents.length >= 2)
  assert.ok(bridge, '应给出至少一条跨分量补评建议')
  assert.equal(bridge.slotsNeeded, 1)
  assert.ok(bridge.newScores.every((ns) => ns.judge === 'J2'))

  // 落地建议：同轮次、同盲评口径、同评分版本；锚点 E1 原本即可共同评分。
  for (const ns of bridge.newScores) {
    season.scores.push({
      entry: bridge.entry,
      judge: ns.judge,
      round: String(ns.round),
      method: '盲',
      design: '87',
      version: '1',
      shared: 'yes',
    })
  }

  const after = buildEquating(season)
  assert.ok(after.components.length < before.components.length, '补评后分量数应减少')
  assert.ok(after.edges.some((e) => e.entry === bridge.entry))
  const seatsAfter = buildSeats(season, after)
  const p1 = seatsAfter.prizes.find((p) => p.prize === 'P1')
  assert.equal(p1.seats[0].evidenceValid, true)
  assert.equal(p1.seats[0].status, SEAT_STATUS.REVIEW_PENDING)
})
