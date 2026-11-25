import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeSeason } from './helpers/fixture.js'
import { buildEquating } from '../src/equating.js'
import { buildSeats, parseTerm, SEAT_STATUS, evidenceBasisFor } from '../src/seats.js'

// 构造一个“已连接”的赛季：J1/J2 有共评边，跨赛道比较有效。
function connectedSeason(overrides = {}) {
  return makeSeason({
    decisions: [
      { entry: 'E2', prize: 'P1', version: '1', state: '待接受' },
    ],
    answer_records: [
      { prize: 'P1', entry: 'E2', at: '10', answer: '接受', state: '先前有效' },
    ],
    ...overrides,
  })
}

test('条款解析：互斥奖、确认时限、保留界限', () => {
  const t = parseTerm({ prize: 'P5', overlap: '与P1不可兼领', confirm_within: '24', unset_rule: '低于84关闭' })
  assert.deepEqual(t.mutexPrizes, ['P1'])
  assert.equal(t.threshold, 84)
  assert.equal(t.confirmWithin, 24)
  assert.ok(t.closeBelowThreshold)
  const def = parseTerm(undefined)
  assert.equal(def.unsetRule, '暂挂')
  assert.deepEqual(def.mutexPrizes, [])
})

test('跨赛道奖最终确认接受后才释放单赛道席位；确认前持续保留', () => {
  // 待确认状态：原赛道名额必须保留。
  const pending = connectedSeason({
    answer_records: [{ prize: 'P1', entry: 'E2', at: '10', answer: '接受', state: '待确认' }],
  })
  const viewPending = buildSeats(pending, buildEquating(pending))
  const p1 = viewPending.prizes.find((p) => p.prize === 'P1')
  assert.notEqual(p1.seats[0].status, SEAT_STATUS.ACCEPTED)
  assert.ok(viewPending.trackReservations.some((t) => t.track === '会展' && t.items.some((i) => i.entry === 'E2')))

  // 最终接受（无待确认标记）：释放，可递补。
  const accepted = connectedSeason()
  const viewAccepted = buildSeats(accepted, buildEquating(accepted))
  const p1a = viewAccepted.prizes.find((p) => p.prize === 'P1')
  assert.equal(p1a.seats[0].status, SEAT_STATUS.ACCEPTED)
  const reservation = viewAccepted.trackReservations
    .flatMap((t) => t.items)
    .find((i) => i.entry === 'E2')
  assert.equal(reservation.status, '接受后释放')
})

test('调换只认最终回复：时间戳最大的答复为准', () => {
  const season = connectedSeason({
    answer_records: [
      { prize: 'P1', entry: 'E2', at: '10', answer: '接受', state: '先前有效' },
      { prize: 'P1', entry: 'E2', at: '20', answer: '拒绝', state: '最终答复' },
    ],
  })
  const view = buildSeats(season, buildEquating(season))
  const seat = view.prizes.find((p) => p.prize === 'P1').seats[0]
  assert.equal(seat.latestAnswer.at, 20)
  assert.equal(seat.latestAnswer.answer, '拒绝')
  assert.equal(seat.status, SEAT_STATUS.HELD)
})

test('到时未答复打开重新评议窗口（nowHours 超过 confirm_within）', () => {
  const season = makeSeason({
    decisions: [{ entry: 'E3', prize: 'P2', version: '1', state: '待接受' }],
    answer_records: [],
  })
  const view = buildSeats(season, buildEquating(season), 60)
  const seat = view.prizes.find((p) => p.prize === 'P2').seats[0]
  assert.equal(seat.status, SEAT_STATUS.HELD)
  assert.ok(view.prizes.find((p) => p.prize === 'P2').waitingReasons.some((w) => w.kind === '到时未答复'))
})

test('关联递补席位在释放来源确认前冻结，来源确认后生效', () => {
  const base = {
    decisions: [{ entry: 'E2', prize: 'P1', version: '1', state: '待接受' }],
    answer_records: [
      { prize: 'P1', entry: 'E2', at: '10', answer: '接受', state: '待确认' },
      { prize: 'P3', entry: 'E4', at: '12', answer: '接受', state: '基于P1释放' },
    ],
  }
  const frozen = buildSeats(makeSeason(base), buildEquating(makeSeason(base)))
  const p3 = frozen.prizes.find((p) => p.prize === 'P3')
  assert.equal(p3.seats[0].status, SEAT_STATUS.LINKED_FROZEN)
  assert.ok(p3.blockedBy.length > 0)
  assert.equal(p3.occupied, 1) // 冻结仍占名额

  // P1 最终确认接受（不带待确认）→ P3 关联席位生效。
  const confirmed = makeSeason({
    ...base,
    answer_records: [
      { prize: 'P1', entry: 'E2', at: '10', answer: '接受', state: '先前有效' },
      { prize: 'P3', entry: 'E4', at: '12', answer: '接受', state: '基于P1释放' },
    ],
  })
  const view2 = buildSeats(confirmed, buildEquating(confirmed))
  assert.equal(view2.prizes.find((p) => p.prize === 'P3').seats[0].status, SEAT_STATUS.ACCEPTED)
})

test('回避使跨赛道依据失效：依据失效待复议，受保护旧奖（同赛道依据仍有效）继续生效', () => {
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
    decisions: [
      { entry: 'E2', prize: 'P1', version: '1', state: '待接受' },
      { entry: 'E1', prize: 'P2', version: '1', state: '已接受' },
    ],
    answer_records: [
      { prize: 'P1', entry: 'E2', at: '10', answer: '复议', state: '待确认' },
      { prize: 'P2', entry: 'E1', at: '11', answer: '接受', state: '独立答复' },
    ],
  })
  const eq = buildEquating(season)
  const view = buildSeats(season, eq)
  const p1 = view.prizes.find((p) => p.prize === 'P1')
  assert.equal(p1.seats[0].status, SEAT_STATUS.BASIS_INVALID)
  assert.equal(p1.seats[0].evidenceValid, false)
  // P2 是赛道内奖项，依据仍有效 → 不受影响。
  const p2 = view.prizes.find((p) => p.prize === 'P2')
  assert.equal(p2.seats[0].status, SEAT_STATUS.ACCEPTED)
})

test('赞助保留奖：无作品达到当季界限时空额也不发放并按规则关闭', () => {
  // 用回避把共评边断开并压低会展作品口径，确保调整分均低于 84。
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
  })
  const view = buildSeats(season, buildEquating(season))
  const p5 = view.prizes.find((p) => p.prize === 'P5')
  assert.equal(p5.freeSlots, 0)
  assert.ok(p5.waitingReasons.some((w) => w.kind === '保留奖界限' && w.closure === SEAT_STATUS.CLOSED))
  assert.ok(p5.candidates.every((c) => c.meetsThreshold === false))
})

test('保留奖：存在达标作品时空额可递补', () => {
  const season = makeSeason({
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E1', judge: 'J2', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E2', judge: 'J1', round: '1', method: '盲', design: '86', version: '1', shared: 'yes' },
      { entry: 'E2', judge: 'J2', round: '1', method: '盲', design: '86', version: '1', shared: 'yes' },
      { entry: 'E4', judge: 'J2', round: '1', method: '盲', design: '90', version: '1', shared: 'no' },
    ],
  })
  const view = buildSeats(season, buildEquating(season))
  const p5 = view.prizes.find((p) => p.prize === 'P5')
  assert.ok(p5.candidates.some((c) => c.entry === 'E4' && c.meetsThreshold))
  assert.equal(p5.freeSlots, 1)
})

test('跨赛道奖无共评连接时不能把名额递给无资格赛道，按条款待共同评议', () => {
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
    decisions: [{ entry: 'E2', prize: 'P1', version: '1', state: '待接受' }],
    answer_records: [{ prize: 'P1', entry: 'E2', at: '10', answer: '拒绝', state: '最终答复' }],
  })
  const view = buildSeats(season, buildEquating(season))
  const p1 = view.prizes.find((p) => p.prize === 'P1')
  assert.equal(p1.freeSlots, 0)
  assert.ok(p1.waitingReasons.some((w) => w.kind === '待共同评议'))
  assert.equal(p1.candidates.length, 0)
})

test('同一作品不能在两个互斥奖上同时最终获奖（冲突被显式报告）', () => {
  const season = connectedSeason({
    decisions: [
      { entry: 'E2', prize: 'P1', version: '1', state: '已接受' },
      { entry: 'E2', prize: 'P3', version: '1', state: '已接受' },
    ],
    answer_records: [
      { prize: 'P1', entry: 'E2', at: '10', answer: '接受', state: '先前有效' },
      { prize: 'P3', entry: 'E2', at: '11', answer: '接受', state: '独立答复' },
    ],
  })
  const view = buildSeats(season, buildEquating(season))
  const p3 = view.prizes.find((p) => p.prize === 'P3')
  assert.ok(p3.mutexConflicts.some((m) => m.entry === 'E2' && m.otherPrize === 'P1'))
})

test('等待原因反查包含可比性、答复链与名额占用', () => {
  const season = makeSeason({
    recusals: [{ judge: 'J1', school: 'S2', revision: '1', state: '回避' }],
    decisions: [{ entry: 'E2', prize: 'P1', version: '1', state: '待接受' }],
    answer_records: [{ prize: 'P1', entry: 'E2', at: '10', answer: '复议', state: '待确认' }],
  })
  const view = buildSeats(season, buildEquating(season))
  const item = view.waitingIndex.find((w) => w.prize === 'P1' && w.entry === 'E2')
  assert.ok(item)
  assert.equal(typeof item.comparability, 'object')
  assert.ok(item.answers.length >= 1)
  assert.ok(item.occupiedBy.includes('E2'))
})

test('复议级联只作用于共用失效依据/同一席位的同赛道奖项，不波及无关奖项', () => {
  const season = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
    decisions: [{ entry: 'E2', prize: 'P1', version: '1', state: '待接受' }],
    answer_records: [{ prize: 'P1', entry: 'E2', at: '10', answer: '复议', state: '待确认' }],
  })
  const view = buildSeats(season, buildEquating(season))
  const p2 = view.prizes.find((p) => p.prize === 'P2')
  // P2 在旅行赛道，与 P1（会展/跨赛道）不同赛道 → 不应被级联阻塞。
  assert.equal(p2.blockedBy.length, 0)
})

test('evidenceBasisFor 标注跨赛道可比性与共评锚点', () => {
  const connected = makeSeason()
  const eq = buildEquating(connected)
  const basis = evidenceBasisFor('E2', eq)
  assert.ok(basis.exists)
  assert.ok(basis.linkEntries.includes('E1'))
  const broken = makeSeason({
    recusals: [
      { judge: 'J2', school: 'S1', revision: '1', state: '回避' },
      { judge: 'J1', school: 'S2', revision: '1', state: '回避' },
    ],
  })
  const eqBroken = buildEquating(broken)
  assert.equal(evidenceBasisFor('E2', eqBroken).crossTrackComparable, false)
})
