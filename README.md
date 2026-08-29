# ChatGPT Web Provider

An experimental OpenAI-compatible local model provider backed by a user-authenticated ChatGPT Web session.

This project is an MIT-licensed fork of [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). It retains the upstream browser worker, model detection, streaming parser, session lifecycle, and safety checks while exposing a generic, Codex-independent OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`, `/v1/responses`).

> [!WARNING]
> This is unofficial browser automation, not an official OpenAI API. ChatGPT UI changes can break it, and ChatGPT plan, workspace, rate limits, and usage restrictions still apply.

---

## Features

- **OpenAI Compatibility**: Drop-in compatible with standard OpenAI SDKs and tools (`/v1/chat/completions`, `/v1/models`).
- **Responses API**: Direct `/v1/responses` endpoint with JSON and SSE streaming support.
- **Multimodal**: Supports text prompts and image inputs.
- **Bearer Authentication**: Secure local API requiring private token authentication.
- **Session Persistence**: Automates extracting and caching session cookies and state (`storage-state.json`) so login is only required once.
- **Loopback Binding**: Strictly bound to `127.0.0.1` for local machine security.
- **Idempotency & Session Retention**: Supports `X-Idempotency-Key` and `X-ChatGPT-Web-Conversation-ID`.

---

## First-Time Setup Guide (ขั้นตอนการติดตั้งและเริ่มใช้งานครั้งแรก)

### Prerequisites (สิ่งที่ต้องมี)
- [Bun](https://bun.sh/) (v1.3+ / v1.4+) or [Node.js](https://nodejs.org/) (v20+)
- Google Chrome installed on your machine
- A valid ChatGPT account (Free, Plus, Team, or Pro)

---

### Step 1: Install Dependencies
Open a terminal in the project root directory and install dependencies:

```powershell
Set-Location D:\Projects\Github\chatgpt-web-provider
bun install --frozen-lockfile
```

---

### Step 2: Initialize Provider Configuration
Create the private configuration and generate a secure local API bearer token:

```powershell
bun run provider:init
```

This command generates a private configuration file at:
- **Windows:** `%USERPROFILE%\.chatgpt-web-provider\config.json`
- **macOS / Linux:** `~/.chatgpt-web-provider/config.json`

The file contains your local server port (`17842`), host (`127.0.0.1`), and your secret `apiToken`.

---

### Step 3: Login to ChatGPT (One-Time Setup)
To authenticate the provider with your ChatGPT account:

**Option A: Using the CLI**
```powershell
bun run provider:login
```

**Option B: 1-Click Helper (Windows)**
Double-click `login-chatgpt.bat` in the project root or from your Desktop.

#### What happens during login:
1. A dedicated, clean Google Chrome window will open to `https://chatgpt.com/?temporary-chat=true`.
2. Sign in to your ChatGPT account (via Google, Microsoft, Apple, or email/password).
3. Wait until you are logged in and see the ChatGPT chat interface (the prompt text box is visible).
4. **Close the Chrome window (click the X button).**
5. The provider will automatically extract the session cookies and local storage tokens, verify them, and save them permanently to:
   `%USERPROFILE%\.chatgpt-web-provider\browser\storage-state.json`

> [!NOTE]
> You only need to perform this login step **once**. The session remains saved on your local machine and will be reused automatically until OpenAI expires your web session.

---

### Step 4: Verify Setup (Doctor)
Run the diagnostic check to ensure your configuration, Chrome executable, and login session are valid:

```powershell
bun run src/provider-cli.ts doctor
```

Expected output:
```json
{
  "config": "C:\\Users\\<Username>\\.chatgpt-web-provider\\config.json",
  "home": "C:\\Users\\<Username>\\.chatgpt-web-provider",
  "chrome_exists": true,
  "login_verified": true,
  "host": "127.0.0.1",
  "port": 17842
}
```
When `login_verified` is `true`, your provider is ready to serve requests.

---

### Step 5: Start the API Server
Start the local OpenAI-compatible provider:

```powershell
bun run provider:serve
```
Or double-click `start-provider.bat`.

The provider will listen at:
```text
http://127.0.0.1:17842/v1
```

---

## Connecting Clients (การนำไปเชื่อมต่อใช้งาน)

### Configuration Details
- **Base URL:** `http://127.0.0.1:17842/v1`
- **API Key:** The `apiToken` found inside `%USERPROFILE%\.chatgpt-web-provider\config.json`
- **Available Models:**
  - `chatgpt-web/light` (ChatGPT Web — Instant)
  - `chatgpt-web/medium` (ChatGPT Web — Medium reasoning)
  - `chatgpt-web/high` (ChatGPT Web — High reasoning)

---

### Examples

#### 1. PowerShell / cURL
Query available models:
```powershell
$token = (Get-Content "$env:USERPROFILE\.chatgpt-web-provider\config.json" | ConvertFrom-Json).apiToken
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod http://127.0.0.1:17842/v1/models -Headers $headers
```

Send a Chat Completion request:
```powershell
$body = @{
    model = "chatgpt-web/medium"
    messages = @(
        @{ role = "user"; content = "Hello! Explain quantum computing in 1 sentence." }
    )
} | ConvertTo-Json

Invoke-RestMethod http://127.0.0.1:17842/v1/chat/completions `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
    -Body $body
```

#### 2. Python (using standard `openai` package)
```python
from openai import OpenAI
import json
from pathlib import Path

# Load token from config
config_path = Path.home() / ".chatgpt-web-provider" / "config.json"
with open(config_path) as f:
    config = json.load(f)

client = OpenAI(
    base_url="http://127.0.0.1:17842/v1",
    api_key=config["apiToken"],
)

response = client.chat.completions.create(
    model="chatgpt-web/medium",
    messages=[{"role": "user", "content": "Write a quick haiku about coding."}],
)

print(response.choices[0].message.content)
```

#### 3. AI Coding Assistants (Cursor / Cline / Continue / LibreChat)
In your tool's settings:
- **Provider:** OpenAI / OpenAI Compatible
- **Base URL:** `http://127.0.0.1:17842/v1`
- **API Key:** Paste your `apiToken` from `config.json`
- **Model ID:** `chatgpt-web/medium` (or `chatgpt-web/light` / `chatgpt-web/high`)

---

## Technical Notes & Troubleshooting

### Chrome App-Bound Encryption on Windows
Starting with Chrome 127 on Windows, Google introduced App-Bound Encryption for cookies (`v20` cookies encrypted via DPAPI and an elevation service). Direct copying of `Cookies` SQLite files from an existing Chrome user data directory into another process or directory will fail to decrypt.

**Solution:** Use `bun run provider:login` (or `login-chatgpt.bat`). This launches Chrome in a dedicated clean user-data directory where the session is created natively and Playwright extracts the complete decrypted state into `storage-state.json`.

### Alternative: Upstream Electron Desktop Launcher
If you prefer a full standalone desktop application with an embedded ChatGPT browser view (specifically optimized for OpenAI Codex):
You can install upstream [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) with one command in PowerShell:

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

---

## Validation & Testing

```powershell
bun test tests/provider-api.test.ts
bun run typecheck
```

See [openapi.json](openapi.json), [llms.txt](llms.txt), and [docs/security-model.md](docs/security-model.md).

