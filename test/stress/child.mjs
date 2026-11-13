/**
 * Run one scenario in a process of its own and print its measurements as JSON.
 *
 * A fresh process per scenario is what makes the numbers mean something: the
 * peak resident set is this scenario's, and lazily loaded format modules and
 * the parser worker start from nothing every time.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { createHost } from './harness.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { offloadState, stopWorker } from '../../lib/shared/offload.js'

const MIB = 1024 * 1024
const [name, dir] = process.argv.slice(2)
const scenario = SCENARIOS.find((candidate) => candidate.name === name)
if (scenario === undefined) throw new Error(`unknown scenario: ${name}`)

const host = await createHost()
const failures = []
const notes = []
globalThis.gc?.()
// `maxRSS` is a high-water mark in KiB; what the scenario adds is the difference.
// It covers the whole process, parser worker included.
const peakBefore = process.resourceUsage().maxRSS / 1024
const restBefore = process.memoryUsage().rss / MIB
// Only this thread is watched: it stands for the event loop the Host shares with DSH.
const stalls = monitorEventLoopDelay({ resolution: 5 })
stalls.enable()
const started = performance.now()
let crash
try {
  await scenario.run({
    host,
    file: (fixture) => join(dir, fixture),
    expect: (condition, message) => { if (!condition) failures.push(message) },
    note: (text) => notes.push(text),
  })
} catch (error) {
  crash = String(error?.stack ?? error)
}
const wallMs = performance.now() - started
stalls.disable()
const peakAfter = process.resourceUsage().maxRSS / 1024
const { inline } = offloadState()
await host.close()
// What stays behind once the previews are answered and the idle worker is gone.
stopWorker()
await new Promise((resolve) => setTimeout(resolve, 300))
globalThis.gc?.()
const restAfter = process.memoryUsage().rss / MIB

process.stdout.write(`\n@@RESULT ${JSON.stringify({
  name,
  wallMs: Math.round(wallMs),
  stallMs: Math.round(stalls.max / 1e6),
  peakMiB: Math.max(0, Math.round(peakAfter - peakBefore)),
  restMiB: Math.round(restAfter - restBefore),
  readMiB: Number((host.reads.rangedBytes / MIB).toFixed(1)),
  failures: inline ? [...failures, 'the parser worker did not start; tasks ran on the Host thread'] : failures,
  notes,
  crash,
  warnings: host.warnings.slice(0, 3),
  requests: host.requests.map(({ label, status, bytes, ms, error }) => ({ label, status, bytes, ms, error })),
})}\n`)
