# .paddock — Eval Configuration

Copy this directory as `.paddock/` into your agent project to customize eval scenarios.

```
.paddock/
├── config.json              # Eval settings (optional)
└── scenarios/               # Test scenarios by category
    ├── tool_use/
    │   ├── web-search-basic.yml
    │   └── file-read-write.yml
    ├── conversation/
    ├── memory/
    ├── multi_turn/
    ├── edge_case/
    └── error_recovery/
```

## Scenario Format (YAML)

```yaml
id: tool-web-search-basic
category: tool_use
difficulty: easy
name: Basic web search
description: User asks to search the web for a simple fact
expectedBehavior: Agent should use web_search tool and summarize results
messages:
  - text: "Найди в интернете какая сейчас погода в Москве"
    from: eval-user
successCriteria:
  - dimension: correctness
    description: Used a search tool
    weight: 0.4
  - dimension: tool_usage
    description: Chose appropriate tool (web_search)
    weight: 0.3
  - dimension: response_quality
    description: Summarized results clearly
    weight: 0.3
```

## Dimensions

- `correctness` — Did the agent produce the right result?
- `tool_usage` — Did it pick the right tools with correct params?
- `soul_compliance` — Does the response match SOUL.md personality?
- `response_quality` — Is the response clear, well-structured?
- `error_handling` — How did it handle errors or edge cases?
