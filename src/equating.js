// 评分等值：评委宽严校正、共评连通分量、可比范围与名次不确定性。
//
// 设计原则（对应办公室规则）：
// 1. 不做“按各组均值平移”——组内作品质量差异不能被当成评委宽严。
//    宽严只能来自同一作品被多名评委共同评分的共评边，按加法评委效应
//    score = 作品水准 + 评委宽严 + 残差，在每个连通分量内用最小二乘估计。
// 2. 共评边必须同时满足：作品被标记为可共同评分(shared=yes)、盲评(method=盲)、
//    同一评分版本(version)，且两侧评分均未被回避剔除。
//    仅“评过同一院校的不同作品”不构成连接。
// 3. 回避对该评委给同校作品已经打过的分同样追溯生效（连同明评分一起剔除）。
// 4. 无有效连接的分量之间不可比较；同分量不同版本只能弱比较（口径提示）。
import { num } from './records.js'

// 返回当前生效的回避集合：键 `${judge}|${school}`。
// revision 留作赛季内多次修订的审计字段；state 非“回避”的记录不生效。
export function activeRecusals(season) {
  const map = new Map()
  for (const row of season.recusals) {
    if (row.state !== '回避') continue
    map.set(`${row.judge}|${row.school}`, {
      judge: row.judge,
      school: row.school,
      revision: num(row, 'revision'),
    })
  }
  return map
}

// 逐评分行标注是否被回避剔除（追溯适用于历史评分，含明评）。
export function isRecused(scoreRow, entryRow, recusalSet) {
  return recusalSet.has(`${scoreRow.judge}|${entryRow.school}`)
}

// 构造有效评分行：附带作品资料、数值化分数与剔除原因。
export function buildScoringRows(season) {
  const recusalSet = activeRecusals(season)
  const entryById = new Map(season.entries.map((e) => [e.entry, e]))
  const rows = []
  for (const s of season.scores) {
    const entry = entryById.get(s.entry)
    const recused = entry ? isRecused(s, entry, recusalSet) : false
    rows.push({
      entry: s.entry,
      judge: s.judge,
      round: num(s, 'round'),
      method: s.method,
      design: num(s, 'design'),
      version: num(s, 'version'),
      shared: s.shared === 'yes',
      track: entry?.track ?? null,
      school: entry?.school ?? null,
      lang: entry?.lang ?? null,
      edition: entry?.edition ?? null,
      excluded: recused || num(s, 'design') === null,
      excludeReason: !entry
        ? '作品不存在'
        : recused
          ? `回避：${s.judge} 不得评审 ${entry.school} 作品（追溯生效）`
          : num(s, 'design') === null
            ? '分数缺失'
            : null,
      blind: s.method === '盲',
    })
  }
  return rows
}

// 有效共评边：同一作品、同版本、盲评、shared=yes、两侧均未被剔除。
// 边是评委-评委之间的连接，依据是“同一作品”这一硬条件。
export function buildLinkEdges(rows) {
  const edges = []
  const byEntry = new Map()
  for (const r of rows) {
    if (r.excluded || !r.blind || !r.shared) continue
    if (!byEntry.has(r.entry)) byEntry.set(r.entry, [])
    byEntry.get(r.entry).push(r)
  }
  for (const [entry, group] of byEntry) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]
        const b = group[j]
        if (a.version !== b.version) continue
        edges.push({
          entry,
          version: a.version,
          judges: [a.judge, b.judge],
          scores: [a.design, b.design],
          diff: b.design - a.design, // b 相对 a 的宽严观测
        })
      }
    }
  }
  return edges
}

function unionFind(items) {
  const parent = new Map(items.map((x) => [x, x]))
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
  const union = (a, b) => parent.set(find(a), find(b))
  return { find, union }
}

// 连通分量：只依据有效共评边连接评委；再把评委评过的作品挂到分量上。
export function buildComponents(rows, edges) {
  const judges = [...new Set(rows.filter((r) => !r.excluded).map((r) => r.judge))]
  const uf = unionFind(judges)
  for (const e of edges) uf.union(e.judges[0], e.judges[1])

  const compOfJudge = new Map()
  for (const j of judges) compOfJudge.set(j, uf.find(j))

  const compMap = new Map()
  const ensure = (id) => {
    if (!compMap.has(id)) {
      compMap.set(id, {
        id,
        judges: new Set(),
        entries: new Set(),
        edges: [],
        versions: new Set(),
      })
    }
    return compMap.get(id)
  }
  for (const j of judges) ensure(compOfJudge.get(j)).judges.add(j)
  for (const e of edges) {
    ensure(compOfJudge.get(e.judges[0])).edges.push(e)
  }
  for (const r of rows) {
    if (r.excluded || !r.blind) continue
    const c = ensure(compOfJudge.get(r.judge))
    c.entries.add(r.entry)
    c.versions.add(r.version)
  }
  const components = [...compMap.values()].map((c) => ({
    id: c.id,
    judges: [...c.judges].sort(),
    entries: [...c.entries].sort(),
    edges: c.edges,
    versions: [...c.versions].sort((x, y) => x - y),
  }))
  return { components, compOfJudge }
}

// 加法评委效应估计：design ~ 作品水准 + 评委宽严。
// 固定每个分量内编号最小的评委宽严为 0，交替最小二乘求解。
// 单评委分量宽严恒为 0；没有共评边时不会产生任何跨评委假设。
export function estimateJudgeEffects(rows, components) {
  const effects = new Map() // judge -> 宽严（正值=整体偏松）
  const diagnostics = []
  const valid = rows.filter((r) => !r.excluded && r.blind)

  for (const comp of components) {
    const ref = comp.judges[0]
    const bias = new Map(comp.judges.map((j) => [j, 0]))
    const compRows = valid.filter((r) => comp.judges.includes(r.judge))
    let iterations = 0
    if (comp.judges.length > 1) {
      for (iterations = 0; iterations < 200; iterations += 1) {
        // 作品水准 = 该作品各（去宽严）评分均值
        const byEntry = new Map()
        for (const r of compRows) {
          if (!byEntry.has(r.entry)) byEntry.set(r.entry, [])
          byEntry.get(r.entry).push(r.design - bias.get(r.judge))
        }
        const merit = new Map()
        for (const [entry, vals] of byEntry) {
          merit.set(entry, vals.reduce((a, b) => a + b, 0) / vals.length)
        }
        // 评委宽严 = 该评委（评分-作品水准）均值，参考评委固定 0
        let delta = 0
        const sums = new Map(comp.judges.map((j) => [j, { sum: 0, n: 0 }]))
        for (const r of compRows) {
          const s = sums.get(r.judge)
          s.sum += r.design - merit.get(r.entry)
          s.n += 1
        }
        for (const j of comp.judges) {
          if (j === ref) continue
          const s = sums.get(j)
          const next = s.n ? s.sum / s.n : 0
          delta = Math.max(delta, Math.abs(next - bias.get(j)))
          bias.set(j, next)
        }
        // 重新锚定，使参考评委严格为 0
        const anchor = bias.get(ref)
        for (const j of comp.judges) bias.set(j, bias.get(j) - anchor)
        if (delta < 1e-9) break
      }
    }
    // 统一的作品水准与残差
    const byEntry = new Map()
    for (const r of compRows) {
      if (!byEntry.has(r.entry)) byEntry.set(r.entry, [])
      byEntry.get(r.entry).push(r.design - bias.get(r.judge))
    }
    const merit = new Map()
    for (const [entry, vals] of byEntry) {
      merit.set(entry, vals.reduce((a, b) => a + b, 0) / vals.length)
    }
    let residualSse = 0
    let residualCount = 0
    for (const r of compRows) {
      residualSse += (r.design - bias.get(r.judge) - merit.get(r.entry)) ** 2
      residualCount += 1
    }
    const dof = Math.max(0, residualCount - merit.size - (comp.judges.length - 1))
    for (const j of comp.judges) effects.set(j, bias.get(j))
    diagnostics.push({
      component: comp.id,
      refJudge: ref,
      iterations,
      linkEdges: comp.edges.length,
      linkedEntries: [...new Set(comp.edges.map((e) => e.entry))],
      residualSse,
      residualSigma: dof > 0 ? Math.sqrt(residualSse / dof) : 0,
      residualDegreesOfFreedom: dof,
    })
  }
  return { effects, diagnostics }
}

// 调整后作品分：有效盲评分减去评委宽严后的均值。
// 同时给出依据范围（最低/最高调整分）、参与评委与版本口径。
export function rankEntries(rows, components, compOfJudge, effects) {
  const valid = rows.filter((r) => !r.excluded && r.blind)
  const byEntry = new Map()
  for (const r of valid) {
    if (!byEntry.has(r.entry)) byEntry.set(r.entry, [])
    byEntry.get(r.entry).push(r)
  }
  const results = []
  for (const [entry, group] of byEntry) {
    const adjusted = group.map((r) => ({
      judge: r.judge,
      raw: r.design,
      adjusted: r.design - (effects.get(r.judge) ?? 0),
      version: r.version,
      round: r.round,
    }))
    const values = adjusted.map((a) => a.adjusted)
    const versions = [...new Set(group.map((r) => r.version))].sort((x, y) => x - y)
    const judges = [...new Set(group.map((r) => r.judge))].sort()
    const componentId = compOfJudge.get(judges[0])
    const inSameComponent = judges.every((j) => compOfJudge.get(j) === componentId)
    results.push({
      entry,
      track: group[0].track,
      lang: group[0].lang,
      edition: group[0].edition,
      component: componentId,
      versions,
      caliberMixed: versions.length > 1,
      judges,
      judgeCount: judges.length,
      adjustedMean: values.reduce((a, b) => a + b, 0) / values.length,
      adjustedLow: Math.min(...values),
      adjustedHigh: Math.max(...values),
      rawScores: adjusted,
      inSameComponent,
    })
  }
  // 同赛道内名次（仅按调整均分排序；跨版本口径差异另行标注，不直接断定）
  const byTrack = new Map()
  for (const r of results) {
    if (!byTrack.has(r.track)) byTrack.set(r.track, [])
    byTrack.get(r.track).push(r)
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => b.adjustedMean - a.adjustedMean)
    list.forEach((r, i) => {
      r.trackRank = i + 1
    })
  }
  return { entries: results, byTrack }
}

// 名次不确定性判定：
// - 不同连通分量：不可比较（undecidable）。
// - 同分量、版本口径不一致：弱比较（weak），只能参考。
// - 同分量同版本、至少一名评委同时评过两件作品：次序由该评委直接见证（direct）。
// - 同分量同版本但无共同评委：次序依赖宽严外推（inferred），
//   分差不超过残差 sigma 时标注为不确定。
export function comparePair(a, b, diagnostics, rows) {
  if (a.component !== b.component) {
    return { comparable: false, strength: 'undecidable', reason: '两作品分属无共评连接的评委组，评委宽严无法相互锚定' }
  }
  const base = { comparable: true, gap: Math.abs(a.adjustedMean - b.adjustedMean) }
  if (a.versions.some((v) => !b.versions.includes(v)) || b.versions.some((v) => !a.versions.includes(v))) {
    return { ...base, strength: 'weak', reason: '评分版本口径不同，仅能弱比较' }
  }
  const judgesA = new Set(a.judges)
  const sharedJudge = b.judges.some((j) => judgesA.has(j))
  if (sharedJudge) {
    return { ...base, strength: 'direct', reason: '有共同评委直接评过两件作品，次序不依赖宽严外推' }
  }
  const diag = diagnostics.find((d) => d.component === a.component)
  const sigma = diag?.residualSigma ?? 0
  const uncertain = base.gap <= sigma
  return {
    ...base,
    strength: uncertain ? 'inferred-uncertain' : 'inferred',
    reason: uncertain
      ? `分差 ${base.gap.toFixed(2)} 不超过残差波动 ${sigma.toFixed(2)}，名次存在不确定性`
      : `分差 ${base.gap.toFixed(2)} 大于残差波动 ${sigma.toFixed(2)}，外推次序可接受`,
  }
}

// 一站式构建，供 CLI 与测试复用。
export function buildEquating(season) {
  const rows = buildScoringRows(season)
  const edges = buildLinkEdges(rows)
  const { components, compOfJudge } = buildComponents(rows, edges)
  const { effects, diagnostics } = estimateJudgeEffects(rows, components)
  const ranking = rankEntries(rows, components, compOfJudge, effects)
  return { rows, edges, components, compOfJudge, effects, diagnostics, ...ranking }
}
