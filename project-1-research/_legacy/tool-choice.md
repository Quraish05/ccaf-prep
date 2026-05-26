# `tool_choice` reference

## Values

| Value | Must use a tool? | Which tool? | Typical use |
|---|---|---|---|
| `{type: "auto"}` (default) | No — may answer in plain text | Model decides | Open-ended chat with optional tools |
| `{type: "any"}` | **Yes** — at least one tool call | Model decides | You know the task needs a tool but don't care which |
| `{type: "tool", name: "X"}` | **Yes** — and it must be `X` | Forced | Structured extraction, guaranteed parameter shape |
| `{type: "none"}` | No — and may not use any tool | N/A | You've defined tools but want a plain text turn |

## `disable_parallel_tool_use`

An extra flag valid on any `tool_choice`. Default behavior: Claude may emit **multiple** `tool_use` blocks in a single response (parallel calls). Setting `disable_parallel_tool_use: true` caps that at **one** tool call per response.

### Combined effects

| Choice | `disable_parallel_tool_use: true` |
|---|---|
| `auto` | Zero or **exactly one** tool call (still optional) |
| `any` | **Exactly one** tool call |
| `tool: X` | **Exactly one** call to `X` |
| `none` | No effect — tools already disabled |

### When to disable parallel

- The tools have side effects and you want them executed sequentially with intermediate reasoning.
- Your harness can only handle one tool at a time.
- You're forcing a single structured extraction (`tool: X` + `disable_parallel_tool_use: true`) and want to guarantee one block to parse.

Otherwise leave it off — parallel tool use is often a latency win for read-only / independent tools (`glob`, `grep`, `read`).
