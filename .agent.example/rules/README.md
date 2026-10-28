# Rules

Guardrails that hold no matter what the agent is asked. Each rule is one
markdown file in this folder; the runtime checks them around every tool call
and they never depend on the agent remembering an instruction.

Protected rules (secret store, `.env`, credential redaction, the call record)
ship with the runtime and cannot be overridden here. `/rules` lists what is in
force and what fired today; `/rules reload` re-reads this folder.

```markdown
---
id: no-prod-deletes            # ^[a-z0-9-]{2,64}$
event: before                  # before | after
match:
  tool: 'http'                 # glob: 'exec', 'exec|file', 'ranch__*', '*'
  arg: { path: '$.method', pattern: '^DELETE$' }   # before only — JSON path + regex
  # result: 'regex'            # after only — regex over the serialized result
action: block                  # block | redact | record
enabled: true
---
Deleting through the API is done from the console, not by the agent.
```

The body is the reason the agent sees when the rule fires. A file that does
not parse is skipped: the other rules and the protected ones stay in force,
and `/rules` names the file and the problem until it is fixed.
