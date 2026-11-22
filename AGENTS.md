# Agent Rules

- Be concise and direct.
- Do not repeat information.
- Inspect existing code before making changes.
- Make the smallest necessary change.
- Preserve existing logic, functionality, styling, and structure unless explicitly asked to change them.
- Do not create unnecessary files, dependencies, abstractions, or refactors.
- Follow the project's existing conventions.
- Use installed package versions, not assumptions from older versions.
- For Next.js, read relevant documentation in `node_modules/next/dist/docs/` before modifying Next.js code.
- Do not modify unrelated files.
- When fixing bugs, identify the root cause before changing code.
- Keep responses short; explain only what is necessary.
- When full code is requested, provide the complete code without omitting existing functionality.

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.
