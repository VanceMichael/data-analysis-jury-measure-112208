// 颁奖席位决议、答复状态机与赛后复议。
//
// 规则落点：
//  - 跨赛道奖先占建议席位：申请人最终确认前，原赛道名额保持保留，不得提前发掉；
//    只有最终确认接受，才释放其中可递补的部分。
//  - 调换只认可最终确认的回复：同一 (奖项,作品) 以时间戳最大的答复为准；
//    同一作品不能在两个互斥奖上同时处于最终获奖状态。
//  - 拒绝或到时未答复 → 打开重新评议窗口；无可比较下一位时按 unset_rule
//    暂挂或关闭，不得把名额递给无资格赛道。
//  - 赞助保留奖必须适用赛道且成绩不低于当季界限（如“低于84关闭”），否则空额也不发。
//  - 颁奖前新增回避使共评证据失效：已正式接受且依据仍有效的奖继续生效；
//    依据失效的发起复议，确认到达前冻结已释放的关联名额。
import { num } from './records.js'

export const SEAT_STATUS = {
  ACCEPTED: '有效接受',
  REVIEW_PENDING: '复议待确认',
  BASIS_INVALID: '依据失效待复议',
  LINKED_FROZEN: '关联名额冻结',
  RESERVED: '跨赛道席位保留',
  BACKFILL_READY: '可递补',
  HELD: '暂挂',
  CLOSED: '按规则关闭',
  WAIT_REVIEW: '待共同评议',
}

// 从条款文本解析当季成绩界限与默认处置。
export function parseTerm(termRow) {
  if (!termRow) {
    return { mutexPrizes: [], releaseOnAccept: false, confirmWithin: null, unsetRule: '暂挂', threshold: null }
  }
  const mutexPrizes = [...termRow.overlap.matchAll(/P\d+/g)].map((m) => m[0])
  const thresholdMatch = termRow.unset_rule.match(/(\d+(?:\.\d+)?)/)
  return {
    mutexPrizes: termRow.overlap.includes('不可兼领') ? mutexPrizes : [],
    releaseOnAccept: termRow.overlap.includes('接受后释放'),
    confirmWithin: num(termRow, 'confirm_within'),
    unsetRule: termRow.unset_rule,
    threshold: termRow.unset_rule.includes('低于') && thresholdMatch ? Number(thresholdMatch[1]) : null,
    closeBelowThreshold: termRow.unset_rule.includes('关闭'),
  }
}

// 作品成绩依据：所属连通分量、有效盲评、是否跨赛道可比。
export function evidenceBasisFor(entryId, equating) {
  const ranked = equating.entries.find((r) => r.entry === entryId)
  if (!ranked) return { exists: false }
  const component = equating.components.find((c) => c.id === ranked.component)
  const tracksInComponent = new Set(
    component.entries
      .map((e) => equating.entries.find((r) => r.entry === e)?.track)
      .filter(Boolean),
  )
  return {
    exists: true,
    component: component.id,
    judges: ranked.judges,
    versions: ranked.versions,
    caliberMixed: ranked.caliberMixed,
    adjustedMean: ranked.adjustedMean,
    track: ranked.track,
    crossTrackComparable: tracksInComponent.size > 1,
    tracksInComponent: [...tracksInComponent],
    linkEntries: [...new Set(component.edges.map((e) => e.entry))],
  }
}

function latestAnswers(season, prize, entry) {
  return season.answer_records
    .filter((r) => r.prize === prize && r.entry === entry)
    .sort((a, b) => num(a, 'at') - num(b, 'at'))
}

// 判断关联递补的释放来源是否已最终确认：
// “基于 Px 释放”指向的跨赛道奖，其最新答复必须是不带“待确认”的接受。
function linkedSourceConfirmed(season, timeline) {
  const linked = timeline.find((r) => r.state.includes('基于'))
  if (!linked) return false
  const match = linked.state.match(/P\d+/)
  if (!match) return false
  const sourcePrize = match[0]
  const sourceAnswers = season.answer_records
    .filter((r) => r.prize === sourcePrize)
    .sort((a, b) => num(a, 'at') - num(b, 'at'))
  const latest = sourceAnswers[sourceAnswers.length - 1]
  return Boolean(latest && latest.answer === '接受' && !latest.state.includes('待确认'))
}

// 主入口：重建本赛季全部奖项的席位视图。
// nowHours：赛季时钟（小时），用于“到时未答复”判定；不传则只依据登记答复。
export function buildSeats(season, equating, nowHours = null) {
  const terms = new Map(season.award_terms.map((t) => [t.prize, parseTerm(t)]))
  const awards = [...season.awards].sort((a, b) => num(a, 'order') - num(b, 'order'))

  // 赛道保留表：跨赛道奖占用期间，原赛道席位保持保留。
  const trackReservations = new Map()
  const reserveTrack = (track, entry, sourcePrize, status) => {
    if (!trackReservations.has(track)) trackReservations.set(track, [])
    trackReservations.get(track).push({ entry, sourcePrize, status })
  }

  const prizeViews = []
  // 全局已占席位作品：同一作品不能借候补名单在另一个奖项上重复占位。
  const globallyOccupied = new Set()

  for (const award of awards) {
    const term = terms.get(award.prize) ?? parseTerm(undefined)
    const decisions = season.decisions.filter((d) => d.prize === award.prize)
    // 答复记录可能登记了 decisions 表尚未收录的席位（如“基于 P1 释放”的关联递补），
    // 这类席位同样占用名额，且在来源确认前必须冻结。
    const decisionKeys = new Set(decisions.map((d) => `${d.entry}|${d.prize}`))
    const answerOnly = season.answer_records
      .filter((r) => r.prize === award.prize && !decisionKeys.has(`${r.entry}|${r.prize}`))
      .map((r) => ({ entry: r.entry, prize: r.prize, version: null, state: r.state, source: 'answer_records' }))
    const allSeatRows = decisions.map((d) => ({ ...d, source: 'decisions' })).concat(answerOnly)
    const seats = []
    const waitingReasons = []
    const blockedBy = []

    for (const d of allSeatRows) {
      const basis = evidenceBasisFor(d.entry, equating)
      const timeline = latestAnswers(season, d.prize, d.entry)
      const latest = timeline[timeline.length - 1] ?? null
      const isCrossTrack = award.track === '跨赛道'
      const evidenceValid = basis.exists && (!isCrossTrack || basis.crossTrackComparable)
      const linkedRelease = timeline.some((r) => r.state.includes('基于'))
      const awaitingConfirm = latest?.state.includes('待确认')
      const finalAccepted = latest?.answer === '接受' && !awaitingConfirm
      const rejected = latest?.answer === '拒绝'
      const timeout =
        !latest && nowHours !== null && term.confirmWithin !== null && nowHours > term.confirmWithin

      let status
      // 关联递补优先判定：释放来源（如跨赛道奖 P1）未最终确认前，
      // 即使本席位登记了“接受”，也必须冻结，等收到确认后才处理已释放的关联名额。
      if (linkedRelease && !linkedSourceConfirmed(season, timeline)) {
        status = SEAT_STATUS.LINKED_FROZEN
      } else if (finalAccepted && evidenceValid) {
        status = SEAT_STATUS.ACCEPTED
      } else if (awaitingConfirm) {
        status = evidenceValid ? SEAT_STATUS.REVIEW_PENDING : SEAT_STATUS.BASIS_INVALID
      } else if (linkedRelease) {
        status = SEAT_STATUS.LINKED_FROZEN
      } else if (rejected || timeout) {
        status = SEAT_STATUS.HELD // 打开重新评议窗口，具体处置在候补阶段定
        waitingReasons.push({
          entry: d.entry,
          kind: rejected ? '申请人拒绝' : '到时未答复',
          rule: term.unsetRule,
          window: '重新评议窗口已打开',
        })
      } else if (!evidenceValid) {
        status = SEAT_STATUS.BASIS_INVALID
      } else if (isCrossTrack) {
        status = SEAT_STATUS.RESERVED
      } else {
        status = SEAT_STATUS.RESERVED
      }

      // 跨赛道奖（含待答复/复议中）持续保留原赛道名额；
      // 确认接受后按条款把该席位转为“接受后释放”，同赛道空出的部分才可递补。
      if (isCrossTrack) {
        if (finalAccepted && term.releaseOnAccept) {
          reserveTrack(basis.track, d.entry, award.prize, '接受后释放')
        } else if (status !== SEAT_STATUS.ACCEPTED) {
          reserveTrack(basis.track, d.entry, award.prize, status)
        }
      }

      seats.push({
        entry: d.entry,
        decisionState: d.state,
        status,
        evidenceValid,
        evidenceBasis: basis,
        timeline: timeline.map((r) => ({ at: num(r, 'at'), answer: r.answer, state: r.state })),
        latestAnswer: latest ? { at: num(latest, 'at'), answer: latest.answer, state: latest.state } : null,
        linkedRelease,
        note: !evidenceValid && isCrossTrack
          ? '跨赛道比较所需的共评连接已失效（回避追溯剔除共评评分），依据不足'
          : basis.caliberMixed
            ? '作品评分存在版本口径差异，仅可弱比较'
            : null,
      })
    }

    // 关联名额冻结传播：若本奖项席位的释放来源正处于复议/失效，标记阻塞关系。
    for (const seat of seats) {
      if (seat.status === SEAT_STATUS.LINKED_FROZEN) {
        const parent = seat.timeline.find((r) => r.state.includes('基于'))
        blockedBy.push({
          seat: seat.entry,
          reason: parent ? `释放来源 ${parent.state} 尚未确认` : '释放来源未确认',
        })
      }
    }

    // 互斥校验：同一作品不得在两个互斥奖上同时最终获奖。
    const mutexConflicts = []
    const finalEntries = new Set(seats.filter((s) => s.status === SEAT_STATUS.ACCEPTED).map((s) => s.entry))
    for (const entry of finalEntries) {
      for (const otherPrize of term.mutexPrizes) {
        const otherDecisions = season.decisions.filter(
          (d) => d.prize === otherPrize && d.entry === entry,
        )
        for (const od of otherDecisions) {
          const otherTimeline = latestAnswers(season, otherPrize, entry)
          const otherLatest = otherTimeline[otherTimeline.length - 1]
          if (otherLatest?.answer === '接受' && !otherLatest.state.includes('待确认')) {
            mutexConflicts.push({ entry, otherPrize, rule: term.unsetRule })
          }
        }
      }
    }

    // 名额核算：保留/冻结/复议中的席位都继续占用名额（受保护旧记录参与校验）。
    const quota = num(award, 'quota')
    const occupied = seats.filter((s) => s.status !== SEAT_STATUS.HELD).length
    const freeSlots = Math.max(0, quota - occupied)

    // 候补与空额处置。
    const backfill = evaluateBackfill(season, equating, award, term, seats, trackReservations, freeSlots, globallyOccupied)
    waitingReasons.push(...backfill.waitingReasons)
    // 本奖项席位（含冻结/保留/复议中）都占用名额，登记进全局占用表。
    for (const s of seats) globallyOccupied.add(s.entry)

    prizeViews.push({
      prize: award.prize,
      track: award.track,
      quota,
      order: num(award, 'order'),
      release: award.release,
      term,
      seats,
      occupied,
      freeSlots: backfill.effectiveFree,
      mutexConflicts,
      blockedBy,
      candidates: backfill.candidates,
      waitingReasons,
    })
  }

  // 复议级联：同赛道奖项若共用同一成绩依据或同一席位则受阻塞。
  applyReconsiderationCascade(prizeViews)

  return {
    prizes: prizeViews,
    trackReservations: [...trackReservations.entries()].map(([track, items]) => ({ track, items })),
    waitingIndex: buildWaitingIndex(prizeViews, equating),
  }
}

// 候补评估：只在本赛道/本奖项资格范围内递补，绝不跨无资格赛道。
function evaluateBackfill(season, equating, award, term, seats, trackReservations, freeSlots, globallyOccupied) {
  const waitingReasons = []
  const heldEntries = new Set(seats.map((s) => s.entry))
  const isCrossTrack = award.track === '跨赛道'

  // 候选池：赛道奖取本赛道作品；跨赛道奖只能在同一连通分量内跨赛道取。
  let pool = equating.entries.filter((r) => (isCrossTrack ? r.component !== undefined : r.track === award.track))
  if (isCrossTrack) {
    // 跨赛道候选必须处于一个真正跨赛道的连通分量中。
    pool = pool.filter((r) => {
      const c = equating.components.find((cc) => cc.id === r.component)
      const tracks = new Set(c.entries.map((e) => equating.entries.find((x) => x.entry === e)?.track))
      return tracks.size > 1
    })
  }
  pool = pool.filter((r) => !heldEntries.has(r.entry) && !globallyOccupied.has(r.entry))

  // 赛道保留：被跨赛道奖保留的赛道名额不能发给别人。
  const reservedTracks = new Set()
  for (const [track, items] of trackReservations) {
    if (track === award.track && items.some((i) => i.status !== '接受后释放')) reservedTracks.add(track)
  }

  const candidates = pool
    .sort((a, b) => b.adjustedMean - a.adjustedMean)
    .map((r) => ({
      entry: r.entry,
      track: r.track,
      adjustedMean: r.adjustedMean,
      component: r.component,
      caliberMixed: r.caliberMixed,
      meetsThreshold: term.threshold === null ? true : r.adjustedMean >= term.threshold,
    }))

  let effectiveFree = freeSlots
  if (freeSlots > 0) {
    if (term.threshold !== null) {
      const eligible = candidates.filter((c) => c.meetsThreshold)
      if (eligible.length === 0) {
        waitingReasons.push({
          kind: '保留奖界限',
          rule: term.unsetRule,
          detail: `适用赛道内无作品达到当季界限 ${term.threshold}，即使空额也不发放`,
          closure: term.closeBelowThreshold ? SEAT_STATUS.CLOSED : SEAT_STATUS.HELD,
        })
        effectiveFree = 0 // 空额冻结，不可外递
      }
    } else if (reservedTracks.has(award.track)) {
      waitingReasons.push({
        kind: '赛道名额保留中',
        rule: '跨赛道奖申请人最终确认前不得提前发放',
      })
      effectiveFree = 0
    } else if (candidates.length === 0) {
      waitingReasons.push({
        kind: isCrossTrack ? '待共同评议' : '无可比较下一位',
        rule: term.unsetRule,
        detail: isCrossTrack
          ? '不存在跨赛道共评连接，不能把名额递给无资格赛道；按条款待共同评议'
          : '本赛道无其他合格候选',
        closure: term.unsetRule.includes('关闭') ? SEAT_STATUS.CLOSED : SEAT_STATUS.HELD,
      })
      // 无可递补对象（跨赛道奖尤为明确：不能递给无资格赛道），空额锁回暂挂。
      effectiveFree = 0
    }
  }

  return { candidates, waitingReasons, effectiveFree }
}

// 复议级联：依据失效/复议中的席位，只阻塞同赛道且确实共用同一成绩依据
// （同分量且跨赛道依据已失效）或同一席位的其他奖项；正常生效的奖不受影响。
function applyReconsiderationCascade(prizeViews) {
  const underReview = prizeViews.flatMap((p) =>
    p.seats
      .filter((s) => [SEAT_STATUS.REVIEW_PENDING, SEAT_STATUS.BASIS_INVALID].includes(s.status))
      .map((s) => ({
        prize: p.prize,
        track: p.track,
        entry: s.entry,
        status: s.status,
        component: s.evidenceBasis?.component,
        basisInvalid: !s.evidenceValid,
      })),
  )
  for (const view of prizeViews) {
    for (const u of underReview) {
      if (u.prize === view.prize) continue
      const sharedSeat = view.seats.some((s) => s.entry === u.entry)
      // 共用依据只在依据本身失效时才构成阻塞；分量相同但依据仍有效的奖项照常发放。
      const sharedBasis = u.basisInvalid && view.seats.some(
        (s) => s.evidenceBasis?.component === u.component && u.component !== undefined,
      )
      if (view.track === u.track && (sharedSeat || sharedBasis)) {
        view.blockedBy.push({
          seat: u.entry,
          reason: `与复议中的 ${u.prize}/${u.entry}（${u.status}）共用${sharedSeat ? '同一席位' : '同一成绩依据'}，确认前不得继续发放`,
        })
      }
    }
  }
}

// 等待原因反查：从每个待定项回溯可比性、答复链与名额占用。
function buildWaitingIndex(prizeViews, equating) {
  const index = []
  for (const view of prizeViews) {
    for (const seat of view.seats) {
      if (seat.status === SEAT_STATUS.ACCEPTED) continue
      index.push({
        prize: view.prize,
        track: view.track,
        entry: seat.entry,
        seatStatus: seat.status,
        comparability: seat.evidenceBasis.exists
          ? {
              component: seat.evidenceBasis.component,
              crossTrackComparable: seat.evidenceBasis.crossTrackComparable,
              linkEntries: seat.evidenceBasis.linkEntries,
              versions: seat.evidenceBasis.versions,
              adjustedMean: seat.evidenceBasis.adjustedMean,
            }
          : '无有效评分依据',
        answers: seat.timeline,
        occupiedBy: seat.entry,
        reasons: [
          seat.note,
          ...view.blockedBy.filter((b) => b.seat === seat.entry).map((b) => b.reason),
          ...view.waitingReasons.map((w) => w.detail ?? w.rule ?? w.kind),
        ].filter(Boolean),
      })
    }
    // 空额级等待原因单独入索引；席位级原因已在上面的席位项中体现，避免重复。
    const seatEntrySet = new Set(view.seats.map((s) => s.entry))
    for (const w of view.waitingReasons) {
      if (w.entry && seatEntrySet.has(w.entry)) continue
      index.push({
        prize: view.prize,
        track: view.track,
        entry: w.entry ?? null,
        seatStatus: w.closure ?? (w.kind === '待共同评议' ? SEAT_STATUS.WAIT_REVIEW : SEAT_STATUS.HELD),
        comparability: '见该奖项候选池',
        answers: [],
        occupiedBy: view.seats.map((s) => s.entry),
        reasons: [w.kind, w.rule, w.detail].filter(Boolean),
      })
    }
  }
  return index
}
