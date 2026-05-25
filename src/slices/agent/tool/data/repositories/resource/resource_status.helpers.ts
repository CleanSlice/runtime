import { readFile } from "node:fs/promises"
import type { ISystemResourceStatus } from "../../../../../setup/llm/domain/resource.types"

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf-8")).trim()
  } catch {
    return undefined
  }
}

async function readMemoryV2(): Promise<{ used: number; limit?: number } | undefined> {
  const current = await readFileSafe("/sys/fs/cgroup/memory.current")
  if (!current) return undefined
  const used = Number(current)
  if (!Number.isFinite(used)) return undefined
  const max = await readFileSafe("/sys/fs/cgroup/memory.max")
  const limit = max && max !== "max" ? Number(max) : undefined
  return { used, limit: Number.isFinite(limit) ? limit : undefined }
}

async function readMemoryV1(): Promise<{ used: number; limit?: number } | undefined> {
  const usageRaw = await readFileSafe("/sys/fs/cgroup/memory/memory.usage_in_bytes")
  if (!usageRaw) return undefined
  const used = Number(usageRaw)
  if (!Number.isFinite(used)) return undefined
  const limRaw = await readFileSafe("/sys/fs/cgroup/memory/memory.limit_in_bytes")
  const lim = limRaw ? Number(limRaw) : undefined
  // cgroup v1 reports a sentinel for "unlimited" — bigger than total physical RAM.
  // Treat anything >= 1 PiB as uncapped to avoid showing a ridiculous limit.
  const limit = Number.isFinite(lim) && lim! < 1 << 50 ? lim : undefined
  return { used, limit }
}

async function readCpuQuotaV2(): Promise<number | undefined> {
  const raw = await readFileSafe("/sys/fs/cgroup/cpu.max")
  if (!raw) return undefined
  const [quotaStr, periodStr] = raw.split(/\s+/)
  if (quotaStr === "max") return undefined
  const quota = Number(quotaStr)
  const period = Number(periodStr)
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period === 0) return undefined
  return (quota / period) * 100
}

async function readCpuQuotaV1(): Promise<number | undefined> {
  const quotaRaw = await readFileSafe("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
  const periodRaw = await readFileSafe("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
  if (!quotaRaw || !periodRaw) return undefined
  const quota = Number(quotaRaw)
  const period = Number(periodRaw)
  if (quota <= 0 || period <= 0) return undefined
  return (quota / period) * 100
}

/**
 * Read total CPU jiffies used by the cgroup (v2: cpu.stat usage_usec).
 * Returns microseconds, or undefined if not available.
 */
async function readCpuUsageV2(): Promise<number | undefined> {
  const raw = await readFileSafe("/sys/fs/cgroup/cpu.stat")
  if (!raw) return undefined
  const match = raw.match(/^usage_usec\s+(\d+)/m)
  if (!match) return undefined
  const v = Number(match[1])
  return Number.isFinite(v) ? v : undefined
}

/**
 * Sample CPU% by taking two process.cpuUsage() readings ~100ms apart.
 * Works on macOS host and inside containers.
 */
async function sampleCpuPercent(sampleMs: number = 100): Promise<number> {
  const start = process.cpuUsage()
  const startWall = Date.now()
  await new Promise(r => setTimeout(r, sampleMs))
  const diff = process.cpuUsage(start)
  const elapsedMs = Date.now() - startWall
  if (elapsedMs <= 0) return 0
  const cpuMs = (diff.user + diff.system) / 1000
  return (cpuMs / elapsedMs) * 100
}

/**
 * Snapshot of container/process resources. Degrades silently when cgroup
 * files are absent (macOS / non-Docker hosts) — caller still gets RSS and
 * a CPU% sample.
 */
export async function readSystemResources(): Promise<ISystemResourceStatus> {
  const rssBytes = process.memoryUsage().rss

  // Prefer cgroup v2 (modern Linux containers), fall back to v1, then host.
  let cgroupVersion: ISystemResourceStatus["cgroupVersion"] = "host"
  let used: number | undefined
  let limit: number | undefined
  let cpuQuotaPct: number | undefined

  const memV2 = await readMemoryV2()
  if (memV2) {
    cgroupVersion = "v2"
    used = memV2.used
    limit = memV2.limit
    cpuQuotaPct = await readCpuQuotaV2()
  } else {
    const memV1 = await readMemoryV1()
    if (memV1) {
      cgroupVersion = "v1"
      used = memV1.used
      limit = memV1.limit
      cpuQuotaPct = await readCpuQuotaV1()
    }
  }

  const memoryUsagePct = limit && limit > 0 && used !== undefined
    ? (used / limit) * 100
    : undefined

  // CPU%: prefer cgroup v2 delta (reflects true container usage); fall back
  // to process.cpuUsage sampling for v1 / host.
  let cpuPercent: number
  if (cgroupVersion === "v2") {
    const a = await readCpuUsageV2()
    await new Promise(r => setTimeout(r, 100))
    const b = await readCpuUsageV2()
    if (a !== undefined && b !== undefined) {
      const deltaCpuMicros = b - a
      // 100ms wall = 100,000 microseconds × cores quota
      cpuPercent = (deltaCpuMicros / 100_000) * 100 / (cpuQuotaPct ? cpuQuotaPct / 100 : 1)
      // Clamp to [0, 100*cores] in case clock skewed
      if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = await sampleCpuPercent()
    } else {
      cpuPercent = await sampleCpuPercent()
    }
  } else {
    cpuPercent = await sampleCpuPercent()
  }

  return {
    rssBytes,
    memoryLimitBytes: limit,
    memoryUsagePct,
    cpuPercent,
    cpuQuotaPct,
    cgroupVersion,
  }
}
