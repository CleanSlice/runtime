/**
 * System-prompt section for clients that can draw sources (CLEAN-138).
 * Present only when the triggering message advertised the `sources`
 * capability — on Telegram, Slack and older Bridle bundles there is nothing
 * to draw, so the model is not asked to cite. The numbers it may use arrive
 * with each tool result, under "Sources you may cite"; a citation is a
 * lookup, not a guess.
 */
export const CITATIONS_PROMPT =
  `# Citing sources\n\n` +
  `When an answer rests on something a tool returned, cite it with a footnote marker — \`[^3]\` — using ONLY the numbers listed under "Sources you may cite" in that tool result. The numbers are fixed for this turn; never invent one or renumber them.\n\n` +
  `Rules:\n` +
  `- Put the marker right after the sentence or clause it supports, before the full stop is fine: "The notice period is 30 days [^3]."\n` +
  `- Cite only what you actually looked up in this turn. No marker for general knowledge, and none for a source you did not read.\n` +
  `- Never write your own list of sources, references or footnotes — the reader sees the list under your message, built from your markers.\n` +
  `- A marker inside a code block is text, not a citation.`
