export interface CronExpression {
  minute: number[] | null
  hour: number[] | null
  dom: number[] | null
  month: number[] | null
  dow: number[] | null
}

interface FieldSpec {
  name: keyof CronExpression
  min: number
  max: number
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour",   min: 0, max: 23 },
  { name: "dom",    min: 1, max: 31 },
  { name: "month",  min: 1, max: 12 },
  // 0 and 7 both mean Sunday (vixie-cron convention); 7 is normalized to 0.
  { name: "dow",    min: 0, max: 7 },
]

// Parse a 5-field cron expression into per-field allow-lists.
// `null` means wildcard (any value).
//
// Supported per field: `*`, numbers (`5`), lists (`0,30`), ranges (`1-5`),
// steps (`*/10`, `10-40/5`) and combinations (`0-15/5,30,45`).
//
// Throws on anything it can't parse or values out of range — callers
// (cron_add) surface the message to the agent instead of persisting a job
// that would never fire. The previous parser silently turned `*/5` into
// NaN, which matched nothing: the job saved fine and then never ran.
export function parseCron(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/)
  if (parts.length > FIELDS.length) {
    throw new Error(`Invalid cron "${expr}": expected at most 5 fields, got ${parts.length}`)
  }
  const [minute, hour, dom, month, dow] = FIELDS.map((spec, i) =>
    parseField(parts[i] ?? "*", spec, expr),
  )
  return { minute, hour, dom, month, dow }
}

function parseField(raw: string, spec: FieldSpec, expr: string): number[] | null {
  if (raw === "*") return null

  const fail = (why: string): never => {
    throw new Error(`Invalid cron "${expr}": ${spec.name} field "${raw}" — ${why}`)
  }

  const out = new Set<number>()
  for (const part of raw.split(",")) {
    if (!part) fail("empty list element")

    const [base, stepRaw, ...extra] = part.split("/")
    if (extra.length > 0) fail("multiple '/' in one element")

    let step = 1
    if (stepRaw !== undefined) {
      step = Number(stepRaw)
      if (!Number.isInteger(step) || step < 1) fail(`step "${stepRaw}" must be a positive integer`)
    }

    let lo: number
    let hi: number
    if (base === "*") {
      lo = spec.min
      hi = spec.max
    } else if (base.includes("-")) {
      const bounds = base.split("-").map(Number)
      if (bounds.length !== 2 || bounds.some((n) => !Number.isInteger(n))) {
        fail("range must be <from>-<to>")
      }
      ;[lo, hi] = bounds as [number, number]
      if (lo > hi) fail(`range ${lo}-${hi} is inverted`)
    } else {
      const n = Number(base)
      if (!Number.isInteger(n)) fail(`"${base}" is not a number`)
      if (stepRaw !== undefined) {
        // vixie-cron: "N/S" means "from N to max, every S"
        lo = n
        hi = spec.max
      } else {
        lo = n
        hi = n
      }
    }

    if (lo < spec.min || hi > spec.max) {
      fail(`values must be within ${spec.min}-${spec.max}`)
    }

    for (let v = lo; v <= hi; v += step) {
      // dow 7 → 0 (both mean Sunday)
      out.add(spec.name === "dow" && v === 7 ? 0 : v)
    }
  }

  if (out.size === 0) fail("matches no values")
  return [...out].sort((a, b) => a - b)
}
