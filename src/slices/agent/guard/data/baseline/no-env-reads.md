---
id: no-env-reads
event: before
match:
  tool: 'exec|process_exec|file'
  arg: { path: '$', pattern: '(^|[\s"''/=])\.env($|[\s"''.;&|<>)])' }
action: block
protected: true
---
`.env` files hold the runtime's own credentials. Use `secret_get` for anything a task needs.
