export interface CronExpression {
  minute: number | null
  hour: number | null
  dom: number | null
  month: number | null
  dow: number | null
}

export function parseCron(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/)
  const field = (p: string) => (p === "*" ? null : parseInt(p, 10))
  return {
    minute: field(parts[0] ?? "*"),
    hour:   field(parts[1] ?? "*"),
    dom:    field(parts[2] ?? "*"),
    month:  field(parts[3] ?? "*"),
    dow:    field(parts[4] ?? "*"),
  }
}
