---
id: no-secret-store-reads
event: before
match:
  tool: 'exec|process_exec|file|unzip'
  arg: { path: '$', pattern: 'data/secrets' }
action: block
protected: true
---
The secret store is read only through `secret_get`. Shell and file tools never see it.
