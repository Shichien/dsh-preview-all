/**
 * Stress run: large and hostile files against every format group.
 *
 *   npm run stress                      everything
 *   npm run stress -- --only=zip64-5g,rtf-long
 *   npm run stress -- --keep            keep the fixtures for the next run
 *   npm run stress -- --dir=D:\\scratch   where to put them (default: .stress-tmp)
 *
 * Needs a few hundred MiB of real disk; the multi-gigabyte files are sparse.
 * Not part of `npm test`: it takes minutes and builds its fixtures first.
 * Exits non-zero when a scenario fails or goes over its budget.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixtures } from './fixtures.mjs'
import { SCENARIOS } from './scenarios.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const only = option('only')?.split(',')
const keep = process.argv.includes('--keep')
const dir = resolve(option('dir') ?? join(HERE, '..', '..', '.stress-tmp'))

const chosen = SCENARIOS.filter((scenario) => only === undefined || only.includes(scenario.name))
if (chosen.length === 0) {
  console.error(`no such scenario; known: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}`)
  process.exit(2)
}

mkdirSync(dir, { recursive: true })
console.log(`fixtures in ${dir}`)
const { available, unavailable } = await buildFixtures(dir, [...new Set(chosen.flatMap((scenario) => scenario.needs))], console.log)
for (const [name, reason] of unavailable) console.log(`  unavailable ${name}: ${reason}`)

const rows = []
let bad = 0
for (const scenario of chosen) {
  const missing = scenario.needs.filter((name) => !available.has(name))
  if (missing.length > 0 || scenario.available?.() === false) {
    rows.push({ name: scenario.name, verdict: 'SKIP', detail: missing.length > 0 ? `no ${missing.join(', ')}` : 'not available on this machine' })
    continue
  }
  const run = spawnSync(process.execPath, ['--expose-gc', join(HERE, 'child.mjs'), scenario.name, dir], {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const line = run.stdout?.split('\n').find((candidate) => candidate.startsWith('@@RESULT '))
  if (line === undefined) {
    // The process died: out of memory, a timeout, or an uncaught error.
    bad += 1
    const why = run.error?.code === 'ETIMEDOUT' ? 'timed out' : `exit ${run.status ?? run.signal}`
    rows.push({ name: scenario.name, verdict: 'CRASH', detail: `${why}: ${(run.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` })
    continue
  }
  const result = JSON.parse(line.slice('@@RESULT '.length))
  const over = []
  const budget = scenario.budget ?? {}
  if (budget.peakMiB !== undefined && result.peakMiB > budget.peakMiB) over.push(`memory ${result.peakMiB} > ${budget.peakMiB} MiB`)
  if (budget.stallMs !== undefined && result.stallMs > budget.stallMs) over.push(`stall ${result.stallMs} > ${budget.stallMs} ms`)
  const problems = [...(result.crash ? [result.crash.split('\n')[0]] : []), ...result.failures]
  const verdict = problems.length > 0 ? 'FAIL' : over.length > 0 ? 'OVER' : 'ok'
  if (verdict !== 'ok') bad += 1
  rows.push({ ...result, verdict, detail: [...problems, ...over, ...result.notes, ...result.warnings.map((warning) => `warning: ${warning.split('\n')[0]}`)].join('; ') })
}

const cell = (value, width) => String(value ?? '').padStart(width)
console.log('')
console.log(`${'scenario'.padEnd(14)} ${'result'.padEnd(6)} ${cell('wall ms', 8)} ${cell('stall ms', 9)} ${cell('+peak MiB', 10)} ${cell('+rest MiB', 10)} ${cell('read MiB', 9)}  detail`)
for (const row of rows) {
  console.log(`${row.name.padEnd(14)} ${row.verdict.padEnd(6)} ${cell(row.wallMs, 8)} ${cell(row.stallMs, 9)} ${cell(row.peakMiB, 10)} ${cell(row.restMiB, 10)} ${cell(row.readMiB, 9)}  ${row.detail}`)
}
console.log('')
console.log(bad === 0 ? `all ${rows.filter((row) => row.verdict === 'ok').length} scenarios within budget` : `${bad} scenario(s) failed or went over budget`)

if (!keep) rmSync(dir, { recursive: true, force: true })
process.exitCode = bad === 0 ? 0 : 1
