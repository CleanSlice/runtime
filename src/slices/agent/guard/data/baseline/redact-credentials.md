---
id: redact-credentials
event: after
match:
  tool: '*'
action: redact
protected: true
---
Credential-shaped values (API keys, OAuth tokens, bearer headers, JWTs, URL passwords) are masked before a tool result reaches the model or a reply reaches the person.
