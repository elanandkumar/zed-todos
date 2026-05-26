# Todos — Zed Extension

Task management for `.todo` files in [Zed editor](https://zed.dev). Inspired by VS Code's Todo+.

## Features

- Syntax highlighting for task states, section headers, tags, and comments
- Toggle task state via code actions (`cmd+.`)
- Auto-insert next task on Enter (pending and in-progress lines only)
- Inlay hints showing task count per section
- Customizable markers via LSP settings

## Task Syntax

```
Section Header:
[ ] pending task
[/] in-progress task
[x] done task
[-] cancelled task
// this is a comment
[ ] task with @tag or @due(2026-06-01)
```

### Rules

- Lines ending with `:` (no brackets) = section header
- Lines starting with `//` = comment, ignored by task count
- `@word` or `@word(value)` = tag, highlighted separately
- Indentation preserved — nested tasks supported

## Usage

### Toggle task state

Place cursor on any task line → `cmd+.` → select action:

- Mark Done
- Mark In Progress
- Mark Pending
- Mark Cancelled
- New Task Below / New Task Above

On a non-task line, `cmd+.` offers **New Task Here**.

### Auto-insert

Press Enter at end of a `[ ]` or `[/]` line → next line auto-fills with `[ ]` at same indent.

Press Enter on an **empty** task line (just `[ ]` with no text) → breaks out, removes the empty marker.

Done (`[x]`) and cancelled (`[-]`) lines do not continue the chain.

## Installation

Search for **Todos** in Zed's extension panel (`cmd+shift+x`).

## Configuration

Override default markers in your Zed `settings.json`:

```json
{
  "lsp": {
    "todo-ls": {
      "initialization_options": {
        "markers": {
          "pending": "[ ]",
          "done": "[x]",
          "in_progress": "[/]",
          "cancelled": "[-]"
        }
      }
    }
  }
}
```

Markers can be any string — bracket style, Unicode symbols (`☐` `✔` `◑` `✗`), or anything else. Rebuild is not required; changes apply on next LSP start.

## Requirements

- Zed editor
- Node.js (used by the language server — Zed provides this automatically)
