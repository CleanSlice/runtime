# Memory

Long-term facts and context. This file is loaded into your system prompt on every message.

## How Memory Works

You have two types of memory:

### 1. This file (MEMORY.md) — manual, durable
- Edit this directly for permanent facts (user preferences, account info, long-term decisions)
- Loaded once per session into system prompt

### 2. Daily notes (memory/YYYY-MM-DD.md) — automatic + manual
- Use `memory_save` tool to append notes during conversations
- Today + yesterday files are auto-injected into your system prompt
- Before session compaction, important facts are auto-extracted here
- One file per day, append-only

### When to save memory
- User shares a preference or important fact
- You complete a significant action (set up a service, sent an email, deployed code)
- User explicitly says "remember this"
- Any concrete value you might need later (emails, usernames, decisions)

### What NOT to save
- Greetings, small talk
- Errors that were resolved
- Temporary debugging info
