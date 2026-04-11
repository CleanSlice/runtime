import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { SecretModule } from "../../../../../setup/secret/secret.module"

// Lazy singleton — initialized on first use
let _secrets: SecretModule | null = null
function getSecrets(ctx: ToolContext): SecretModule {
  if (!_secrets) _secrets = new SecretModule(ctx.agentDir)
  return _secrets
}

export const SecretSetTool: Tool = {
  name: "secret_set",
  description: "Save a secret value for the current user. Use for passwords, tokens, API keys. Key format: 'service:field' e.g. 'instagram:password', 'upwork:email'",
  schema: z.object({
    key: z.string().describe("Secret key, e.g. 'instagram:password'"),
    value: z.string().describe("Secret value to store"),
  }),
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { key, value } = (SecretSetTool.schema as ReturnType<typeof z.object>).parse(params)
    await getSecrets(ctx).set(ctx.from, key, value)
    return { ok: true, key }
  },
}

export const SecretGetTool: Tool = {
  name: "secret_get",
  description: "Retrieve a saved secret for the current user. Returns null if not found.",
  schema: z.object({
    key: z.string().describe("Secret key to retrieve"),
  }),
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { key } = (SecretGetTool.schema as ReturnType<typeof z.object>).parse(params)
    const value = await getSecrets(ctx).get(ctx.from, key)
    return value !== undefined ? { found: true, value } : { found: false }
  },
}

export const SecretListTool: Tool = {
  name: "secret_list",
  description: "List all secret keys saved for the current user (values are not shown).",
  schema: z.object({}),
  async execute(_params: unknown, ctx: ToolContext): Promise<unknown> {
    const keys = await getSecrets(ctx).list(ctx.from)
    return { keys }
  },
}

export const SecretDeleteTool: Tool = {
  name: "secret_delete",
  description: "Delete a saved secret for the current user.",
  schema: z.object({
    key: z.string().describe("Secret key to delete"),
  }),
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { key } = (SecretDeleteTool.schema as ReturnType<typeof z.object>).parse(params)
    await getSecrets(ctx).delete(ctx.from, key)
    return { ok: true, key }
  },
}
