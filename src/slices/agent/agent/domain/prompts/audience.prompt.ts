/**
 * The signed-in person the agent is talking to, for the `# Audience` block
 * of the system prompt (CLEAN-232, ranch `specs/032-agent-user-access/
 * contracts/acting-party.md` §4). Display and guidance only: what a person
 * may do is decided by the tools Ranch lists for them, never by this text.
 * It holds no token. Every field is optional: the hub may not know the
 * console (an older console build declares none), and a role this runtime
 * does not know is left out rather than guessed.
 */
export interface IAudience {
  role?: "Owner" | "Admin" | "User"
  surface?: "app" | "admin"
  email?: string
}

const CONSOLE: Record<"app" | "admin", string> = {
  app: "user console",
  admin: "management console",
}

const TOOLS_ARE_THEIRS = "The tools you have in this conversation are the ones this person may use."

/** For a User: a tool name read anywhere else (a skill, a note, an earlier turn) is not a tool of this conversation. */
const NO_OTHER_TOOLS = "Only the tools in your tool list exist in this conversation; call no other tool, whatever name you have read elsewhere."

const NO_OTHER_ROUTE =
  "Do not attempt it another way, do not describe the management console, do not suggest steps they cannot take."

/** An email as one printable line: it comes from the hub, and still goes into a prompt. */
function oneLine(text: string | undefined): string | undefined {
  const clean = text?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200)
  return clean || undefined
}

/**
 * The audience this turn should be told about, or undefined when the prompt
 * stays as it is. Only a person a token proves gets a block. A trusted
 * party (the agent's own job, an admin its own configuration names) gets
 * none, and neither does a guest: their catalogue already lacks what they
 * may not do, and a block for guests would be read by every visitor of
 * every product bot on Telegram and share links.
 */
export function audienceOf(
  actor: { kind: "person" | "trusted" | "peer" | "guest" },
  acting?: { role?: "Owner" | "Admin" | "User"; surface?: "app" | "admin" },
  email?: string,
): IAudience | undefined {
  if (actor.kind !== "person") return undefined
  const shown = oneLine(email)
  return {
    ...(acting?.role ? { role: acting.role } : {}),
    ...(acting?.surface ? { surface: acting.surface } : {}),
    ...(shown ? { email: shown } : {}),
  }
}

/** The `# Audience` block for one turn. */
export function buildAudiencePrompt(audience: IAudience): string {
  const email = oneLine(audience.email)
  const role = audience.role ? (audience.role === "User" ? "a User" : `an ${audience.role}`) : undefined
  const where = audience.surface ? ` in the ${CONSOLE[audience.surface]}` : ""
  let who: string
  if (email && role) who = `${email}, ${role}${where ? "," : ""}`
  else who = email ?? role ?? "a signed-in person"

  const lines = ["# Audience", "", `You are talking to ${who}${where}.`, TOOLS_ARE_THEIRS]
  if (audience.role === "User") {
    lines.push(NO_OTHER_TOOLS)
    lines.push(`When they ask for something you have no tool for, say in one sentence that their account cannot do that. ${NO_OTHER_ROUTE}`)
  }
  return lines.join("\n")
}
