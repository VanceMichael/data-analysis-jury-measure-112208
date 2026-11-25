// 把等值分析、补评规划、席位决议渲染成办公室可读的中文报告。
// 所有结论均来自纯函数模块，报告层不做业务判定，保证 JSON 与文本口径一致。
import { comparePair } from './equating.js'

function line(ch = '─', n = 72) {
  return ch.repeat(n)
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2).replace(/\.?0+$/, '') : String(n)
}

export function renderEquating(equating) {
  const out = []
  out.push('一、评分等值与可比范围')
  out.push(line())
  out.push(`有效共评边 ${equating.edges.length} 条，连通分量 ${equating.components.length} 个；不同分量之间不可直接比较。`)
  out.push('')
  for (const c of equating.components) {
    out.push(`【分量 ${c.id}】评委：${c.judges.join('、')}｜作品：${c.entries.join('、')}｜评分版本：${c.versions.join('/')}`)
    if (c.edges.length === 0) {
      out.push('  · 无有效共评边：评委宽严无法与其他分量锚定，组内名次可查，跨组比较待定。')
    } else {
      for (const e of c.edges) {
        out.push(`  · 共评作品 ${e.entry}（版本${e.version}）：${e.judges[0]}=${e.scores[0]}，${e.judges[1]}=${e.scores[1]}，宽严观测差 ${fmt(e.diff)}`)
      }
    }
    const diag = equating.diagnostics.find((d) => d.component === c.id)
    out.push(`  · 宽严估计（以 ${diag.refJudge} 为 0 锚点）：${c.judges
      .map((j) => `${j} ${fmt(equating.effects.get(j) ?? 0)}`)
      .join('；')}`)
    if (diag.residualDegreesOfFreedom === 0) {
      out.push('  · 残差自由度为 0：宽严完全由共评边确定，无额外波动可估；共评边很少，新增回避即可能断开连接。')
    } else {
      out.push(`  · 残差 sigma=${fmt(diag.residualSigma)}（自由度 ${diag.residualDegreesOfFreedom}）`)
    }
    out.push('')
  }

  out.push('各赛道内调整后名次：')
  for (const [track, list] of equating.byTrack) {
    out.push(`  ${track}赛道`)
    for (const r of list) {
      const range = r.adjustedLow === r.adjustedHigh
        ? fmt(r.adjustedMean)
        : `${fmt(r.adjustedLow)}~${fmt(r.adjustedHigh)}`
      const caliber = r.caliberMixed ? '（⚠ 版本口径混合，仅弱比较）' : ''
      const judges = r.judges.join('、')
      out.push(`    ${r.trackRank}. ${r.entry} 调整分 ${range}（均分 ${fmt(r.adjustedMean)}，评委 ${judges}）${caliber}`)
    }
  }
  out.push('')
  return out.join('\n')
}

export function renderUncertainty(season, equating) {
  const out = []
  out.push('二、名次不确定性（相邻名次与跨赛道候选）')
  out.push(line())
  for (const [track, list] of equating.byTrack) {
    for (let i = 0; i < list.length - 1; i += 1) {
      const cmp = compareForReport(list[i], list[i + 1], equating)
      out.push(`  ${track}：${list[i].entry} vs ${list[i + 1].entry} → ${label(cmp)}（${cmp.reason}）`)
    }
  }
  // 跨赛道：列出各分量头名之间为何不可比。
  const heads = []
  for (const c of equating.components) {
    const ranked = equating.entries
      .filter((r) => r.component === c.id)
      .sort((a, b) => b.adjustedMean - a.adjustedMean)
    if (ranked[0]) heads.push(ranked[0])
  }
  out.push('')
  out.push('跨赛道头名对照：')
  for (let i = 0; i < heads.length; i += 1) {
    for (let j = i + 1; j < heads.length; j += 1) {
      const cmp = compareForReport(heads[i], heads[j], equating)
      out.push(`  ${heads[i].entry}(${heads[i].track}) vs ${heads[j].entry}(${heads[j].track}) → ${label(cmp)}（${cmp.reason}）`)
    }
  }
  out.push('')
  return out.join('\n')
}

function compareForReport(a, b, equating) {
  return comparePair(a, b, equating.diagnostics, equating.rows)
}

function label(cmp) {
  return {
    undecidable: '不可比较',
    weak: '弱比较',
    direct: '确定',
    inferred: '外推',
    'inferred-uncertain': '不确定',
  }[cmp.strength]
}

export function renderPlan(plan) {
  const out = []
  out.push('三、颁奖截止前可补的共同评分')
  out.push(line())
  if (plan.suggestions.length === 0) {
    out.push('当前空闲评委与剩余轮次无法形成新的跨组共评连接。')
  }
  for (const s of plan.suggestions) {
    const newJudges = s.newScores.map((x) => x.judge).join('、')
    out.push(
      `建议：第 ${s.round} 轮由 ${s.judges.join('、')} 对作品 ${s.entry}（${s.track}/${s.lang}，院校 ${s.school}）同口径盲评同版本；` +
      `需新增评分 ${s.slotsNeeded} 份（${newJudges}），合并分量 ${s.linksComponents.join('+')}，` +
      `合并后覆盖 ${s.mergedJudgeCount} 名评委、${s.mergedEntryCount} 件作品。`,
    )
    for (const r of s.resolves) out.push(`    → ${r}`)
  }
  out.push('')
  out.push('名额占用核对：')
  for (const u of plan.slotUsage) {
    out.push(`  评委 ${u.judge} 第 ${u.round} 轮：已建议占用 ${u.used}/${u.total}`)
  }
  if (plan.unreachableComponents.length > 0) {
    out.push('')
    out.push(`无法接入的分量：${plan.unreachableComponents.join('、')}（无匹配语言/版本/回避约束的空闲评委，相关赛道只能查组内结果）。`)
  }
  out.push('')
  return out.join('\n')
}

export function renderSeats(view) {
  const out = []
  out.push('四、颁奖席位、答复与复议')
  out.push(line())
  for (const p of view.prizes) {
    out.push(`【${p.prize}｜${p.track}赛道｜名额 ${p.quota}｜决议顺序 ${p.order}｜释放方式：${p.release}】`)
    if (p.seats.length === 0) out.push('  暂无登记决议。')
    for (const s of p.seats) {
      const ans = s.latestAnswer ? `最新答复@${s.latestAnswer.at}h=${s.latestAnswer.answer}（${s.latestAnswer.state}）` : '尚无答复'
      out.push(`  席位 ${s.entry}：${s.status}`)
      out.push(`    答复链：${s.timeline.length ? s.timeline.map((t) => `@${t.at}h ${t.answer}/${t.state}`).join(' → ') : '无'}`)
      out.push(`    ${ans}`)
      out.push(`    依据：分量 ${s.evidenceBasis.component}｜跨赛道可比=${s.evidenceBasis.crossTrackComparable ? '是' : '否'}｜调整分 ${fmt(s.evidenceBasis.adjustedMean)}｜共评锚点 ${s.evidenceBasis.linkEntries.join('、') || '无'}`)
      if (s.note) out.push(`    提示：${s.note}`)
    }
    out.push(`  名额：占用 ${p.occupied}/${p.quota}，可发空额 ${p.freeSlots}`)
    for (const w of p.waitingReasons) {
      out.push(`  等待原因：${[w.kind, w.rule, w.detail, w.closure].filter(Boolean).join('｜')}`)
    }
    for (const b of p.blockedBy) out.push(`  阻塞：${b.reason}`)
    for (const m of p.mutexConflicts) out.push(`  ⚠ 互斥冲突：作品 ${m.entry} 同时满足 ${m.otherPrize}`)
    if (p.candidates.length) {
      out.push(`  候补顺序：${p.candidates
        .map((c) => `${c.entry}(${c.track},${fmt(c.adjustedMean)}${c.meetsThreshold ? '' : ',未达界限'})`)
        .join(' → ')}`)
    }
    out.push('')
  }
  out.push('赛道名额保留：')
  for (const t of view.trackReservations) {
    for (const item of t.items) {
      out.push(`  ${t.track}赛道：作品 ${item.entry} 的名额因 ${item.sourcePrize} 处于「${item.status}」`)
    }
  }
  out.push('')
  return out.join('\n')
}

export function renderWaitingIndex(view) {
  const out = []
  out.push('五、等待原因反查（可比性 → 答复 → 名额占用）')
  out.push(line())
  for (const item of view.waitingIndex) {
    out.push(`[${item.prize}] ${item.entry ?? '（空额）'} 状态：${item.seatStatus}`)
    if (typeof item.comparability === 'object') {
      const c = item.comparability
      out.push(`  可比性：分量 ${c.component}｜跨赛道可比=${c.crossTrackComparable ? '是' : '否'}｜共评锚点 ${c.linkEntries.join('、') || '无'}｜版本 ${c.versions.join('/')}｜调整分 ${fmt(c.adjustedMean)}`)
    } else {
      out.push(`  可比性：${item.comparability}`)
    }
    out.push(`  答复：${item.answers.length ? item.answers.map((a) => `@${a.at}h ${a.answer}/${a.state}`).join(' → ') : '无'}`)
    out.push(`  仍占名额：${[].concat(item.occupiedBy).join('、')}`)
    out.push(`  原因：${item.reasons.join('；')}`)
    out.push('')
  }
  return out.join('\n')
}

export function renderFullReport(season, equating, plan, seats, issues) {
  const parts = [
    `赛季评审决议报告（作品 ${season.entries.length} 件，评委 ${new Set(season.scores.map((s) => s.judge)).size} 名，奖项 ${season.awards.length} 项）`,
    line('═'),
    issues.length ? `资料校验提示 ${issues.length} 条（见 check 子命令明细）。\n` : '资料引用校验通过。\n',
    renderEquating(equating),
    renderUncertainty(season, equating),
    renderPlan(plan),
    renderSeats(seats),
    renderWaitingIndex(seats),
  ]
  return parts.join('\n')
}
