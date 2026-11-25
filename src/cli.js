#!/usr/bin/env node
// 赛季工具命令行入口。无第三方依赖，仅使用 Node.js 22 内置模块。
//
// 用法：
//   node src/cli.js report [--data=./data] [--now=48] [--json]
//   node src/cli.js check  [--data=./data]
//   node src/cli.js plan   [--data=./data] [--json]
//   node src/cli.js seats  [--data=./data] [--now=48] [--json]
//   node src/cli.js why    [--data=./data]            # 等待原因反查
import { resolve } from 'node:path'
import { loadSeason, validateReferences } from './records.js'
import { buildEquating } from './equating.js'
import { planSupplementaryReviews } from './planner.js'
import { buildSeats } from './seats.js'
import {
  renderEquating,
  renderUncertainty,
  renderPlan,
  renderSeats,
  renderWaitingIndex,
  renderFullReport,
} from './report.js'

function parseArgs(argv) {
  const args = { _: [] }
  for (const item of argv) {
    if (item.startsWith('--')) {
      const [key, value] = item.slice(2).split('=')
      args[key] = value ?? true
    } else {
      args._.push(item)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'report'
  const dataDir = resolve(process.cwd(), args.data ?? './data')
  const nowHours = args.now === undefined ? null : Number(args.now)

  const season = await loadSeason(dataDir)
  const issues = validateReferences(season)
  const equating = buildEquating(season)
  const plan = planSupplementaryReviews(season, equating)
  const seats = buildSeats(season, equating, nowHours)

  if (command === 'check') {
    if (args.json) {
      console.log(JSON.stringify({ issues }, null, 2))
    } else {
      if (issues.length === 0) {
        console.log('资料引用校验通过，未发现问题。')
      }
      for (const i of issues) console.log(`[${i.level}] ${i.code}：${i.message}`)
    }
    process.exitCode = issues.some((i) => i.level === 'error') ? 1 : 0
    return
  }

  if (command === 'plan') {
    console.log(args.json ? JSON.stringify(plan, null, 2) : renderPlan(plan))
    return
  }

  if (command === 'seats') {
    console.log(args.json ? JSON.stringify(seats, null, 2) : renderSeats(seats))
    return
  }

  if (command === 'why') {
    console.log(args.json ? JSON.stringify(seats.waitingIndex, null, 2) : renderWaitingIndex(seats))
    return
  }

  if (command === 'equating') {
    console.log(args.json
      ? JSON.stringify({
          edges: equating.edges,
          components: equating.components.map((c) => ({
            id: c.id, judges: c.judges, entries: c.entries, versions: c.versions,
          })),
          effects: [...equating.effects.entries()],
          diagnostics: equating.diagnostics,
          entries: equating.entries,
        }, null, 2)
      : `${renderEquating(equating)}\n${renderUncertainty(season, equating)}`)
    return
  }

  if (command === 'report') {
    if (args.json) {
      console.log(JSON.stringify({ issues, equating: {
        edges: equating.edges,
        components: equating.components,
        effects: [...equating.effects.entries()],
        diagnostics: equating.diagnostics,
        entries: equating.entries,
      }, plan, seats }, null, 2))
    } else {
      console.log(renderFullReport(season, equating, plan, seats, issues))
    }
    return
  }

  console.error(`未知命令：${command}。可用命令：report | check | plan | seats | why | equating`)
  process.exitCode = 2
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  process.exitCode = 1
})
