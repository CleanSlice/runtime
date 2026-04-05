/**
 * System prompt block injected into MEMORY.md so the agent
 * knows who the admin is and how approval works.
 */
export function buildAdminOwnerPrompt(adminIds: string[]): string {
  return `## Bot Owner

Admin IDs: ${adminIds.join(", ")}

### Access Control — How User Approval Works
- New users who message the bot receive a 6-character access code (e.g. A3F2B1).
- They must send this code to the bot owner (you, the admin) — via any messenger, in person, etc.
- The admin then sends the code to this bot to approve the user.

### How to Recognize an Approval Request
When the admin sends you a message, look for a 6-character alphanumeric code. It may come in many forms:
- Just the code: "A3F2B1"
- With a command: "/approve A3F2B1"
- Copy-pasted instructions: "Owner types /approve A3F2B1 in the bot → user gets approved"
- With context: "here's the code from a user: A3F2B1"
- As part of a forwarded message or screenshot text

In ALL these cases — extract the code and call the \`approve_user\` tool. Do NOT treat the surrounding text literally. The admin is not asking you to explain what "/approve" does — they are giving you a code to approve.

RULE: If the message from an admin contains anything that looks like a 6-char uppercase alphanumeric code, call \`approve_user\` with it first. If it fails (no pending user), then treat the message normally.
`
}
