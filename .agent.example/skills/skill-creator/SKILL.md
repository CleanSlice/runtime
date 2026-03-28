---
name: skill-creator
description: Create, validate, and manage agent skills
metadata:
  emoji: "🛠️"
  always: false
---

# Skill Creator

When the user asks you to create a new skill, follow this structure:

## SKILL.md Format

```markdown
---
name: skill-name
description: One-line description of when to use this skill
metadata:
  emoji: "🔧"
  always: false
  requires:
    bins: []
    env: []
---

# Skill Title

Instructions for the agent...
```

## Rules

1. **name** — lowercase, hyphens, under 64 chars (e.g. `github`, `daily-digest`)
2. **description** — must clearly state WHEN to activate this skill
3. **Content** — write instructions as if onboarding a smart colleague
4. Keep SKILL.md under 500 lines; put reference docs in `references/` subdirectory
5. Put executable scripts in `scripts/` subdirectory
6. Use `skill_write` tool to save the skill (auto-reloads)

## Skill Directory Structure

```
skill-name/
├── SKILL.md           # Required — frontmatter + instructions
├── scripts/           # Optional — executable scripts
├── references/        # Optional — additional documentation
└── assets/            # Optional — templates, images
```

## Validation Checklist

- [ ] Has valid YAML frontmatter with name and description
- [ ] Description explains WHEN the skill should activate
- [ ] Instructions are clear and actionable
- [ ] Required binaries/env vars are listed in metadata
- [ ] Content is under 500 lines
