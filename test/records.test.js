import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeSeason } from './helpers/fixture.js'
import { validateReferences, num, splitCombined } from '../src/records.js'

test('完整自洽的赛季资料无 error 级问题', () => {
  const issues = validateReferences(makeSeason())
  assert.equal(issues.filter((i) => i.level === 'error').length, 0)
})

test('悬空引用与重复评分被识别为 error', () => {
  const season = makeSeason({
    scores: [
      { entry: 'E404', judge: 'J1', round: '1', method: '盲', design: '80', version: '1', shared: 'no' },
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '89', version: '1', shared: 'yes' },
    ],
  })
  const issues = validateReferences(season)
  assert.ok(issues.some((i) => i.code === 'SCORE_ENTRY'))
  assert.ok(issues.some((i) => i.code === 'SCORE_DUP'))
})

test('非回避状态与缺失条款产生 warn 而非 error', () => {
  const season = makeSeason({
    recusals: [{ judge: 'J2', school: 'S1', revision: '1', state: '已撤销' }],
    award_terms: [],
  })
  const issues = validateReferences(season)
  assert.ok(issues.some((i) => i.code === 'TERM_MISSING'))
})

test('num 处理问号与非法值，splitCombined 拆组合编号', () => {
  assert.equal(num({ x: '42' }, 'x'), 42)
  assert.equal(num({ x: '?' }, 'x'), null)
  assert.equal(num({ x: 'abc' }, 'x'), null)
  assert.deepEqual(splitCombined('中+英'), ['中', '英'])
})
