---
name: devops
description: Git push, file operations, stack trace debugging, auth recovery, codebase search — recipes for development tasks
metadata:
  emoji: "🔧"
  always: true
---

# DevOps Skill — Tool Recipes

Follow these exact sequences when performing development tasks. These are NOT suggestions — they are mandatory procedures.

---

## Git Push / Deploy

```
1. exec("git push origin <branch>")
   ↓ blocked or 403?
2. secret_get("github:token")          ← MUST be next call, NOT secret_list
   ↓ found?
3a. exec("git remote set-url origin https://<token>@github.com/<org>/<repo>.git && git push")
   ↓ exec still blocked?
3b. http_request({
      method: "POST",
      url: "https://api.github.com/repos/<org>/<repo>/git/refs",
      headers: { "Authorization": "Bearer <token>" }
    })
   ↓ not found?
4. secret_list()                        ← now check what keys exist
5. Check [env] ok: GITHUB_TOKEN        ← if listed, exec("git push") uses env var
   ↓ exec blocked + env listed?
6. Tell user: "Token is in env but exec is unavailable. Save to secrets:
   secret_set('github:token', '<paste>')"
   ↓ nothing?
7. Ask user for token — ONLY as last resort
```

**Key rules:**
- `secret_get("github:token")` MUST come before `secret_list`. Always.
- When exec is blocked — try `http_request` (GitHub API) next. This is the #1 missed fallback.
- Never ask user for a token without calling `secret_get` first.

---

## Auth Failure Recovery (any service)

When any action fails with 403, 401, "Permission denied", "auth required":

1. **`secret_get("<service>:token")`** — call with specific key name. Common: `github:token`, `gitlab:token`, `npm:token`, `docker:token`.
2. **Found → use it and retry.** Via `exec` (embed in URL/header) or `http_request` if exec blocked.
3. **Not found → `secret_list()`** to see what keys exist. Try alternative key names.
4. **Check env vars:** `[env] ok: GITHUB_TOKEN` = credential available. Try `exec` (uses env) or note it for user.
5. **Only now ask user** — state exactly what's missing.

**`secret_get` MUST come before `secret_list`.** `secret_list` returning empty does NOT mean credentials don't exist — `secret_get` with specific key may still find them.

---

## Bug Fix from Stack Trace

When user shares a stack trace like:
```
EACCES: permission denied, mkdir '/app/.agent/sessions'
    at ensureDirs (/app/src/slices/runtime/init/data/init.gateway.ts:52:7)
```

**Try ALL path variations with `file` tool — in parallel if possible:**
1. `file("/app/src/slices/runtime/init/data/init.gateway.ts")` — exact path
2. `file("src/slices/runtime/init/data/init.gateway.ts")` — without `/app/` prefix
3. `file("./src/slices/runtime/init/data/init.gateway.ts")` — relative
4. `file("/workspace/src/slices/runtime/init/data/init.gateway.ts")` — `/workspace/` prefix

**Do NOT give up after 1-2 attempts. Try all 4+ variations.**
**NEVER ask user to send file contents.** You have the `file` tool — use it.

After reading: identify the fix, apply it with `file` (write), confirm.

---

## Codebase Search (find a file by name)

When user references a feature/section/component by name (e.g. "System page", "Bot Runtime section"):

**Step 1:** Try `exec("grep -r '<name>' src/" )` or `exec("find src/ -name '*<name>*'")`.

**Step 2:** If exec blocked, try `file` with guessed paths — ALL of these:
- `file("src/pages/<Name>.vue")` and `file("src/pages/<name>.vue")`
- `file("src/pages/<name>/index.vue")`
- `file("src/components/<Name>.vue")`
- `file("pages/<Name>.vue")` and `file("app/pages/<name>.vue")`
- `file("src/views/<Name>.vue")`
- `file("src/slices/<name>/presentation/<Name>.vue")`
- `memory_search("<name> page")` for saved project structure info

**Step 3:** If multiple candidates found, check ALL of them.

**Step 4:** You MUST try at least **6-8 different `file` calls** before asking user. Each unique path = one attempt.

**Step 5:** Only ask after exhausting all guesses. Be specific about what you tried.

**Common mistake:** `file(".")` or `file("src/")` — the `file` tool reads FILES, not directories. Guess specific file paths instead.

---

## Tool Fallback Chains

When primary tool is blocked or fails, always try the next one:

| Task | Chain |
|------|-------|
| Server commands | `exec` → `http_request` → `web_fetch` |
| File search | `exec(grep/find)` → `file` (specific paths) → `memory_search` |
| File read | `exec(cat)` → `file("<exact-path>")` |
| Git operations | `exec(git)` → `http_request` (API) |
| Web search | `web_search` → `web_fetch` |

**Never give up after one tool fails. Exhaust the chain.**
