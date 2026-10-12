import matter from "gray-matter"

/**
 * gray-matter evaluates `---js` / `---javascript` frontmatter as code. Rule,
 * instinct and skill files live in the agent directory — some are written by
 * the operator, some by the runtime, some by the model itself — so none of
 * them may carry executable frontmatter. Only YAML is accepted; anything
 * else throws and the caller skips or refuses the file.
 */
const refuse = (name: string) => () => { throw new Error(`${name} frontmatter is not allowed — use YAML`) }

const SAFE_ENGINES = {
  js: refuse("js"),
  javascript: refuse("javascript"),
  json: refuse("json"),
  coffee: refuse("coffee"),
  "coffee-script": refuse("coffee-script"),
  cson: refuse("cson"),
  toml: refuse("toml"),
}

export interface ISafeMatter {
  data: Record<string, unknown>
  content: string
}

export function safeMatter(text: string): ISafeMatter {
  // An explicit language tag on the opening fence (`---js`) is the attack
  // surface; refuse it before gray-matter even looks for an engine.
  const first = text.split(/\r?\n/, 1)[0] ?? ""
  if (/^---\s*\S/.test(first)) throw new Error(`frontmatter language "${first.slice(3).trim()}" is not allowed — use plain ---`)
  const parsed = matter(text, { engines: SAFE_ENGINES })
  return { data: (parsed.data ?? {}) as Record<string, unknown>, content: parsed.content }
}
