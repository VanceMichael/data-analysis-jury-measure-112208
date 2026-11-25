// 赛季资料加载与引用校验。
// 来源表中所有值均为字符串（合成记录约定），本模块只负责读取与引用核对，
// 数值转换由各业务模块通过 num() 在使用点完成，避免把编号类字符串误转。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TABLES = [
  'entries',
  'scores',
  'recusals',
  'awards',
  'decisions',
  'award_terms',
  'judge_availability',
  'answer_records',
]

const NUMERIC_FIELDS = new Set([
  'round', 'design', 'version', 'revision', 'quota', 'order',
  'confirm_within', 'slots', 'at',
])

export function num(row, key) {
  const raw = row[key]
  if (raw === undefined || raw === null || raw === '?') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export async function loadSeason(dir) {
  const season = {}
  for (const name of TABLES) {
    const file = new URL(`../data/${name}.json`, `file://${dir.endsWith('/') ? dir : `${dir}/`}`)
    season[name] = JSON.parse(await readFile(file, 'utf8'))
  }
  season._dir = dir
  return season
}

// 与 test/data.test.js 的格式检查互补：这里核对跨表引用与枚举取值，
// 返回问题清单而不是抛异常，便于办公室在新赛季导入时一次性看到所有问题。
export function validateReferences(season) {
  const issues = []
  const warn = (code, message) => issues.push({ level: 'warn', code, message })
  const error = (code, message) => issues.push({ level: 'error', code, message })

  const entryIds = new Set(season.entries.map((r) => r.entry))
  const prizeIds = new Set(season.awards.map((r) => r.prize))
  const judges = new Set(season.scores.map((r) => r.judge))

  for (const row of season.scores) {
    if (!entryIds.has(row.entry)) error('SCORE_ENTRY', `评分引用了不存在的作品 ${row.entry}`)
    if (num(row, 'design') === null) warn('SCORE_DESIGN', `作品 ${row.entry} 评委 ${row.judge} 的分数缺失或不可解析`)
    if (!['盲', '明'].includes(row.method)) warn('SCORE_METHOD', `作品 ${row.entry} 评委 ${row.judge} 的评审方式标记异常：${row.method}`)
    if (!['yes', 'no'].includes(row.shared)) warn('SCORE_SHARED', `作品 ${row.entry} 评委 ${row.judge} 的共评标记异常：${row.shared}`)
  }

  const entrySchool = new Map(season.entries.map((r) => [r.entry, r.school]))
  for (const row of season.recusals) {
    if (!judges.has(row.judge)) warn('RECUSAL_JUDGE', `回避记录中的评委 ${row.judge} 没有任何评分`)
    if (!season.entries.some((e) => e.school === row.school)) {
      warn('RECUSAL_SCHOOL', `回避记录中的院校 ${row.school} 没有任何作品`)
    }
    if (row.state !== '回避') warn('RECUSAL_STATE', `评委 ${row.judge} 对 ${row.school} 的回避状态为“${row.state}”，未生效`)
  }

  for (const row of season.decisions) {
    if (!entryIds.has(row.entry)) error('DECISION_ENTRY', `决议引用了不存在的作品 ${row.entry}`)
    if (!prizeIds.has(row.prize)) error('DECISION_PRIZE', `决议引用了不存在的奖项 ${row.prize}`)
  }

  for (const row of season.answer_records) {
    if (!entryIds.has(row.entry)) error('ANSWER_ENTRY', `答复引用了不存在的作品 ${row.entry}`)
    if (!prizeIds.has(row.prize)) error('ANSWER_PRIZE', `答复引用了不存在的奖项 ${row.prize}`)
  }

  for (const row of season.judge_availability) {
    if (num(row, 'slots') === null || num(row, 'slots') <= 0) {
      warn('AVAIL_SLOTS', `评委 ${row.judge} 第 ${row.round} 轮的空闲名额无效`)
    }
    if (!season.entries.some((e) => e.edition === row.edition)) {
      warn('AVAIL_EDITION', `评委 ${row.judge} 可评版本 ${row.edition} 没有对应作品`)
    }
  }

  for (const prize of prizeIds) {
    if (!season.award_terms.some((t) => t.prize === prize)) {
      warn('TERM_MISSING', `奖项 ${prize} 缺少颁奖条款，将使用默认规则（暂挂、无互斥）`)
    }
  }

  // 同一作品同一轮次同一评委不应出现两条评分。
  const seen = new Set()
  for (const row of season.scores) {
    const key = `${row.entry}|${row.judge}|${row.round}|${row.version}`
    if (seen.has(key)) error('SCORE_DUP', `作品 ${row.entry} 评委 ${row.judge} 第 ${row.round} 轮存在重复评分`)
    seen.add(key)
  }

  return issues
}

// 供业务模块复用的小工具：拆“中+英”这类组合编号。
export function splitCombined(value) {
  return String(value).split('+').map((s) => s.trim()).filter(Boolean)
}

export { NUMERIC_FIELDS }
