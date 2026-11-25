// 颁奖截止前的共同评分（补评）规划。
//
// 硬约束（任一不满足即不可行）：
//  - 只能使用组织方登记的空闲评委与剩余轮次（judge_availability）；
//  - 评委语言覆盖作品语种；“双语”作品要求评委同时掌握两种语言；
//  - 评委对作品院校无生效回避（回避对新评分同样生效）；
//  - 作品版本与评委可评版本一致；
//  - 共评必须是“同一作品”由两名评委在同轮次、同盲评口径、同评分版本下评分；
//  - 评委空闲名额(slots)有限；
//  - 两名评委若最终仍把两组分开评分（没有共同落到同一作品），不产生连接，
//    因此每条建议都要验证合并后的连通分量确实变大。
import { num, splitCombined } from './records.js'
import { activeRecusals } from './equating.js'

function judgeLanguages(availRow) {
  return new Set(splitCombined(availRow.language))
}

function languageMatches(judgeLangs, entryLang) {
  if (entryLang === '双语') {
    // 双语作品要求两种语言都覆盖；组合编号如“中+英”。
    return judgeLangs.has('中') && judgeLangs.has('英')
  }
  return judgeLangs.has(entryLang)
}

// 汇总每个评委在每个剩余轮次的可用资源。
export function buildAvailability(season) {
  return season.judge_availability.map((row) => ({
    judge: row.judge,
    round: num(row, 'round'),
    languages: judgeLanguages(row),
    slots: num(row, 'slots'),
    edition: row.edition,
  }))
}

// 并查集模拟：补评边落地后的评委连通图。
// 返回新增边实际并入同一集合的“已有分量”id 列表；若没有把两个已有分量
// 合并起来（两名评委仍把两组分开评分），返回空数组。
function simulateMerge(equating, entry, judgePair) {
  const allJudges = new Set()
  for (const c of equating.components) c.judges.forEach((j) => allJudges.add(j))
  judgePair.forEach((j) => allJudges.add(j))
  const parent = new Map([...allJudges].map((j) => [j, j]))
  const find = (x) => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (x, y) => parent.set(find(x), find(y))
  // 载入现有共评边。
  for (const e of equating.edges) union(e.judges[0], e.judges[1])
  // 载入锚点作品上已有的有效盲评评委（新边要与他们连通才接得上原分量）。
  const anchorJudges = equating.rows
    .filter((r) => r.entry === entry && !r.excluded && r.blind)
    .map((r) => r.judge)
  for (let i = 1; i < anchorJudges.length; i += 1) union(anchorJudges[0], anchorJudges[i])

  // 加入拟议的新共评边。严格按 buildLinkEdges 的真实连边方式模拟：
  // 同作品上“有评分”的评委两两连通，而不是凭空在两名拟议评委间连边。
  // 已评过锚点作品的评委本就在 anchorJudges 中；新增评分的评委加入后，
  // 与锚点评委集合两两连通。
  const scoringJudges = new Set(anchorJudges)
  for (const j of judgePair) scoringJudges.add(j)
  const scoringList = [...scoringJudges]
  for (let i = 0; i < scoringList.length; i += 1) {
    for (let k = i + 1; k < scoringList.length; k += 1) {
      union(scoringList[i], scoringList[k])
    }
  }

  const afterRoot = find(judgePair[0])
  const mergedCids = new Set()
  for (const c of equating.components) {
    if (find(c.judges[0]) === afterRoot) mergedCids.add(c.id)
  }
  return mergedCids.size >= 2 ? [...mergedCids] : []
}

// 找出能把两个无连接分量重新连起来的可行共评建议。
// 返回的每条建议都附带：解决了哪些待定名次/奖项、所需名额、合并后的分量范围。
export function planSupplementaryReviews(season, equating) {
  const availability = buildAvailability(season)
  const recusalSet = activeRecusals(season)
  const { components, compOfJudge, edges } = equating

  // 记录现有评分，避免建议重复劳动（同评委同作品同版本已有有效盲评分则无需再评）。
  // 键与 availability.edition（如 V1）保持同一口径。
  const existingBlind = new Set(
    equating.rows
      .filter((r) => !r.excluded && r.blind)
      .map((r) => `${r.judge}|${r.entry}|${r.edition}`),
  )

  const componentIds = components.map((c) => c.id)

  // 候选作品：只要存在版本匹配的空闲评委即可进入候选，
  // 具体语言/回避/配对资格在逐对评委时再校验。
  const availableEditions = new Set(availability.map((a) => a.edition))
  const candidateEntries = season.entries.filter((e) => availableEditions.has(e.edition))

  const suggestions = []
  // 去重索引：锚点作品 + 被合并分量集合 + 轮次 → 当前最优建议。
  const suggestionIndex = new Map()
  // 跟踪名额占用，同一评委同一轮次 slots 可被多条建议共享时需扣减。
  const slotUsage = new Map()
  const useKey = (a) => `${a.judge}|${a.round}`
  const remainingSlots = (a) => a.slots - (slotUsage.get(useKey(a)) ?? 0)

  // 对每个候选作品枚举可行的“补评评分者集合”：
  //  方案甲（单人补评，1 名额）：一名空闲评委补评一件已被其他分量评委评过的作品；
  //  方案乙（双人新评，2 名额）：两名空闲评委同轮次同口径共评。
  // 所有方案统一用并查集验证是否真把两个已有分量并入同一集合，再按名额择优。
  for (const entryRow of candidateEntries) {
    const entry = entryRow.entry
    const eligible = availability.filter(
      (a) =>
        a.edition === entryRow.edition &&
        languageMatches(a.languages, entryRow.lang) &&
        !recusalSet.has(`${a.judge}|${entryRow.school}`),
    )

    const consider = (reviewerAvail, round) => {
      const judges = reviewerAvail.map((a) => a.judge)
      const newScores = reviewerAvail
        .filter((a) => !existingBlind.has(`${a.judge}|${entry}|${a.edition}`))
        .map((a) => ({ judge: a.judge, round: a.round }))
      if (newScores.length === 0) return
      for (const ns of newScores) {
        const a = reviewerAvail.find((x) => x.judge === ns.judge)
        if (remainingSlots(a) <= 0) return
      }
      const mergedFrom = simulateMerge(equating, entry, judges)
      if (mergedFrom.length < 2) return

      const dedupeKey = `${entry}|${[...mergedFrom].sort().join('+')}|${round}`
      const existing = suggestionIndex.get(dedupeKey)
      if (existing && existing.slotsNeeded <= newScores.length) return

      const mergedEntries = new Set()
      const mergedJudges = new Set()
      for (const cid of mergedFrom) {
        const c = components.find((c) => c.id === cid)
        c.entries.forEach((e) => mergedEntries.add(e))
        c.judges.forEach((jj) => mergedJudges.add(jj))
      }
      mergedEntries.add(entry)
      judges.forEach((jj) => mergedJudges.add(jj))

      const suggestion = {
        entry,
        track: entryRow.track,
        lang: entryRow.lang,
        school: entryRow.school,
        round,
        judges,
        newScores,
        slotsNeeded: newScores.length,
        linksComponents: mergedFrom,
        mergedJudgeCount: mergedJudges.size,
        mergedEntryCount: mergedEntries.size,
        resolves: describeResolutions(season, equating, mergedFrom, entry),
      }
      if (existing) {
        suggestions.splice(suggestions.indexOf(existing), 1, suggestion)
        for (const ns of existing.newScores) {
          const key = `${ns.judge}|${ns.round}`
          slotUsage.set(key, Math.max(0, (slotUsage.get(key) ?? 0) - 1))
        }
      } else {
        suggestions.push(suggestion)
      }
      suggestionIndex.set(dedupeKey, suggestion)
      for (const ns of newScores) {
        const key = `${ns.judge}|${ns.round}`
        slotUsage.set(key, (slotUsage.get(key) ?? 0) + 1)
      }
    }

    // 按轮次分组，保证同轮次同口径。
    const byRound = new Map()
    for (const a of eligible) {
      if (!byRound.has(a.round)) byRound.set(a.round, [])
      byRound.get(a.round).push(a)
    }
    for (const [round, group] of byRound) {
      // 方案甲：单人补评。
      for (const a of group) consider([a], round)
      // 方案乙：双人新评。
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          consider([group[i], group[j]], round)
        }
      }
    }
  }

  // 按“合并作品数多、所需名额少”排序，优先推荐信息量大的方案。
  suggestions.sort((x, y) => y.mergedEntryCount - x.mergedEntryCount || x.slotsNeeded - y.slotsNeeded)

  return {
    suggestions,
    slotUsage: [...slotUsage.entries()].map(([k, used]) => {
      const [judge, round] = k.split('|')
      const avail = availability.find((a) => a.judge === judge && String(a.round) === round)
      return { judge, round: Number(round), used, total: avail?.slots ?? used }
    }),
    unreachableComponents: findUnreachableComponents(componentIds, suggestions),
  }
}

// 说明一条补评建议能解决哪些待定名次与奖项。
function describeResolutions(season, equating, mergedFrom, anchorEntry) {
  const out = []
  const crossPrizes = season.awards.filter((a) => a.track === '跨赛道')
  if (crossPrizes.length > 0) {
    out.push(`合并分量 ${mergedFrom.join('、')} 后，跨赛道奖 ${crossPrizes.map((p) => p.prize).join('、')} 获得评委宽严可相互锚定的比较依据`)
  }
  // 找出因分量隔离而无法判定的赛道间名次。
  const tracks = new Set()
  for (const cid of mergedFrom) {
    const c = equating.components.find((c) => c.id === cid)
    for (const e of c.entries) {
      const row = equating.entries.find((r) => r.entry === e)
      if (row) tracks.add(row.track)
    }
  }
  if (tracks.size > 1) {
    out.push(`可在 ${[...tracks].join('、')} 赛道之间给出调整后名次（锚点作品 ${anchorEntry}）`)
  }
  // 对正在等待共同评议的奖项给出直接提示。
  const waiting = season.award_terms.filter((t) => t.unset_rule.includes('共同评议'))
  for (const t of waiting) {
    out.push(`奖项 ${t.prize} 的“${t.unset_rule}”等待项可依据新连接重新评议`)
  }
  return out
}

function findUnreachableComponents(componentIds, suggestions) {
  const reachable = new Set()
  for (const s of suggestions) s.linksComponents.forEach((c) => reachable.add(c))
  return componentIds.filter((id) => !reachable.has(id))
}
