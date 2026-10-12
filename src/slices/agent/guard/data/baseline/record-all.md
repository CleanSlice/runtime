---
id: record-all
event: after
match:
  tool: '*'
action: record
protected: true
---
Every tool call is recorded to `data/toolcalls.jsonl`: tool, outcome, duration, sizes and the rules that fired. This is the audit trail and the evidence base for learning.
