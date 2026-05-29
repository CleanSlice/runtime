import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { buildUiForm, MessagePartTypes, type MessageUiComponent } from "../../../../../setup/channel/domain/channel.types"

// ── LLM-facing schema ─────────────────────────────────────────
// Closed component set mirrors the wire format the Bridle SDK
// renders. Anything outside this set will be rejected at validation
// time so the agent gets a clear error instead of a silently dropped
// part on the wire.

const optionSchema = z.object({
  value: z.string(),
  label: z.string(),
})

const componentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("input"),
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("textarea"),
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("radio"),
    name: z.string(),
    label: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
    options: z.array(optionSchema).min(2),
  }),
  z.object({
    type: z.literal("checkbox"),
    name: z.string(),
    label: z.string(),
    default: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("checkbox-group"),
    name: z.string(),
    label: z.string().optional(),
    required: z.boolean().optional(),
    default: z.array(z.string()).optional(),
    options: z.array(optionSchema).min(1),
  }),
  z.object({
    type: z.literal("select"),
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
    options: z.array(optionSchema).min(2),
  }),
])

const schema = z.object({
  intro: z.string().describe(
    "Plain-text message rendered above the form, e.g. 'Quick one before we get you set up:'. Visitors who can't render forms (Telegram, email) only see this — keep it self-explanatory.",
  ),
  components: z.array(componentSchema).min(1).describe(
    "Ordered list of form fields. Allowed types: heading, text, input, textarea, radio, checkbox, checkbox-group, select. See the tool description for the field shape of each.",
  ),
  uiId: z.string().min(1).describe(
    "Stable identifier you'll use to match the visitor's submission. Pick something descriptive like 'plan-pick' or 'onboarding-step1'. Required.",
  ),
  submitLabel: z.string().optional().describe(
    "Label for the submit button. Default: 'Apply'. Use action verbs that fit the form: 'Continue', 'Save', 'Confirm'.",
  ),
})

type Params = z.infer<typeof schema>

export const RenderFormTool: Tool = {
  name: "render_form",
  description: `Render an interactive form inside the chat bubble — radio groups, checkboxes, text inputs, selects — and wait for the visitor to submit.

Use this INSTEAD of asking the visitor to type structured answers ("type basic/pro/team", "say yes or no") when the channel can render forms. Saves them keystrokes and you get structured values back.

Channel support:
  - bridle (web embed): renders the form inline. Use freely.
  - telegram / slack / email: no form renderer. DO NOT call this tool — fall back to a plain-text question.

How the round-trip works:
  1. You call render_form with components + a stable uiId.
  2. The Bridle SDK shows the form; the visitor fills it and clicks Submit.
  3. You receive a follow-up user message whose text starts with "[form submitted] uiId=<your-uiId>" and lists every field as "name=value". Parse those values and continue the conversation — DO NOT re-render the same form.

Component reference (each is an object you put in the components array):
  - heading: { type: "heading", text: "..." } — section title
  - text:    { type: "text", text: "..." } — help paragraph under the title
  - input:   { type: "input", name: "city", label?, placeholder?, required?, default? } — short free-form answer
  - textarea:{ type: "textarea", name: "notes", label?, placeholder?, required?, default? } — long free-form
  - radio:   { type: "radio", name: "plan", required?, default?, options: [{value,label}, ...] } — pick exactly one
  - checkbox:{ type: "checkbox", name: "newsletter", label: "Subscribe me", default? } — single boolean
  - checkbox-group: { type: "checkbox-group", name: "topics", required?, default?, options: [...] } — pick multiple
  - select:  { type: "select", name: "country", required?, default?, placeholder?, options: [...] } — long pick-one list

Returns: { ok: true, uiId, sent: true } when the form was sent. The visitor's answers arrive in the next user turn — do not call render_form again to "wait for the answer".

Validation: required fields are enforced client-side; you'll never see a submit missing a required value. Type coercion is automatic (checkbox → boolean, checkbox-group → string[], everything else → string).`,
  schema,
  async execute(rawParams: unknown, ctx: ToolContext): Promise<unknown> {
    const params = schema.parse(rawParams) as Params

    // Channel gate. Only bridle renders forms today. Make the failure mode
    // loud and structured so the LLM can react instead of silently
    // dropping the call.
    if (ctx.channel !== "bridle") {
      return {
        ok: false,
        error: "channel_not_supported",
        channel: ctx.channel ?? "unknown",
        message:
          "render_form only works on the bridle (web embed) channel. " +
          "Send the question as plain text instead.",
      }
    }

    const form = buildUiForm(
      params.components as MessageUiComponent[],
      {
        uiId: params.uiId,
        ...(params.submitLabel ? { submitLabel: params.submitLabel } : {}),
      },
    )

    await ctx.send(params.intro, [
      { type: MessagePartTypes.Text, text: params.intro },
      form,
    ])

    return {
      ok: true,
      uiId: params.uiId,
      sent: true,
      hint:
        "Form sent. The visitor will submit it; their answers arrive as the next user message " +
        `with text starting "[form submitted] uiId=${params.uiId}". Read that, then continue the conversation.`,
    }
  },
}
