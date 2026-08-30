# AGENTS.md

This file provides guidance to Clew Code and other AI coding assistants when working with code in this repository.

## Project intent

`chatgpt-web-provider` exposes a user-authenticated ChatGPT Web session through a bounded OpenAI-compatible local API.

The generic provider is the product boundary. Codex-specific integration retained from upstream is compatibility code, not the public identity of this fork.

## Development commands

Install dependencies:
```powershell
bun install
```

Run the full test suite:
```powershell
bun test
```

Run a single test file:
```powershell
bun test tests/provider-api.test.ts
```

Run a specific test by name:
```powershell
bun test tests/provider-api.test.ts -t "test name"
```

Type-check:
```powershell
bun run typecheck
```

Build the provider CLI bundle:
```powershell
bun run build:provider
```

Start the provider server:
```powershell
# Using global CLI:
cwp serve

# Or using Node directly:
node dist/provider-cli.mjs serve
```

Ask a quick question via CLI:
```powershell
cwp ask "your question"
cwp ask --model chatgpt-web/instant "quick question"
```

Run interactive terminal chat:
```powershell
cwp chat
```

### Required checks

Before editing:
```powershell
git status --short --branch
bun test
```

After editing:
```powershell
bun test tests/provider-api.test.ts
bun run typecheck
```

Run the full upstream suite when changing shared browser, Responses, launcher, or session code. Cross-platform launcher fixtures may require their native operating system and packaged Electron dependencies; distinguish baseline platform failures from provider regressions.

## Architecture

The project is a TypeScript application running on Bun and Node.js:
- `src/provider-cli.ts` / `dist/provider-cli.mjs` is the main universal CLI entrypoint (`cwp` / `chatgpt-web-provider`).
- Requests enter through an OpenAI-compatible local HTTP API on `http://127.0.0.1:17842/v1` and are routed through provider abstractions rather than directly coupling callers to ChatGPT Web behavior.

### Public HTTP API
- `GET /healthz` — unauthenticated health check.
- `GET /readyz` — authenticated readiness check.
- `GET /v1/models` — authenticated model catalog.
- `POST /v1/responses` — authenticated Responses-compatible endpoint.
- `POST /v1/chat/completions` — authenticated Chat Completions endpoint.

### Models & Reasoning Effort
- `chatgpt-web/instant` — Low effort / instant response.
- `chatgpt-web/medium` — Medium effort (default).
- `chatgpt-web/high` — High effort for complex coding and deep problem solving.
- `chatgpt-web/extra-high` — Extra high effort (requires Pro).
- `chatgpt-web/pro` — Maximum effort (requires Pro).
- Friendly aliases like `sol`, `sol-high`, `sol-medium`, `sol-low`, `terra`, and `luna` are canonicalized automatically, and `reasoning_effort` parameters map dynamically into the corresponding model mode.

Provider adapters under `src/adapters/chatgpt-web/` translate generic API requests into browser automation turns via Playwright driving Chrome.

Generic client tool execution is intentionally disabled until request-scoped capability and approval semantics are implemented and tested.

## Security

- Never log or return provider bearer tokens, ChatGPT cookies, browser storage, tunnel keys, or prompt bodies.
- Never treat client-supplied Codex metadata as machine authority.
- Bind the local API only to `127.0.0.1`.
- Keep browser-only mode as the generic default.
- Preserve the inherited five-browser-turn concurrency bound and explicit UI-drift failures inherited from upstream.
- Unsupported capabilities must fail explicitly; never silently route to another model or API.
