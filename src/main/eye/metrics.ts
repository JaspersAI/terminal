import { app } from 'electron'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

// How the app performs, sampled once a minute with the frames: what each process takes, how much of
// main's heap is used, and how late main's event loop ran since the last sample. Only while recording.

let delay: IntervalHistogram | null = null

/** Starts timing main's event loop, from now. */
export function startMetrics(): void {
  if (delay) return
  delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
}

export function stopMetrics(): void {
  delay?.disable()
  delay = null
}

/** One sample: every process, main's heap, and the event loop's delay since the last sample, which starts the count over. */
export function metricsData(windows: number, runs: number): Record<string, unknown> {
  const processes = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    name: metric.serviceName ?? metric.name ?? null,
    cpu: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
    memory: metric.memory.workingSetSize,
  }))
  const lag = delay
    ? { max: Math.round(delay.max / 1e6), p99: Math.round(delay.percentile(99) / 1e6) }
    : { max: null, p99: null }
  delay?.reset()
  return { processes, heap: process.memoryUsage().heapUsed, lag, windows, runs }
}
