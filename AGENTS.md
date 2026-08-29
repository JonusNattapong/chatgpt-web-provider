# AGENTS.md

## Project intent

`chatgpt-web-provider` exposes a user-authenticated ChatGPT Web session through a bounded OpenAI-compatible local API.

The generic provider is the product boundary. Codex-specific integration retained from upstream is compatibility code, not the public identity of this fork.

## Public API

- `GET /healthz` is unauthenticated and contains no secrets.
- `GET /readyz`, `GET /v1/models`, `POST /v1/responses`, and `POST /v1/chat/completions` require bearer authentication.
- Bind only to `127.0.0.1`.
- Unsupported capabilities must fail explicitly; never silently route to another model or API.
- Generic tool execution remains disabled until a request-scoped capability and approval design is implemented and tested.

## Required checks

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

## Security

- Never log or return the provider bearer token, ChatGPT cookies, browser storage, tunnel keys, or prompt bodies.
- Never accept client-supplied Codex metadata as machine authority.
- Keep browser-only mode as the generic default.
- Preserve the five-browser-turn concurrency bound and explicit UI-drift failures inherited from upstream.
