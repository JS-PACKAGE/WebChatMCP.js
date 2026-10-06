# Security Policy

WebChatMCP.js is a local tool. It runs an [MCP](https://modelcontextprotocol.io) server with a built-in Chromium browser (Playwright, persistent profile) that drives the web UIs of ChatGPT, Claude, Grok and Gemini on your behalf, and it can optionally expose OpenAI-/Anthropic-/chat-completions-compatible bridges for Codex, Claude Code, Grok Build and Hermes Agent.

Because it operates a browser that holds your logged-in sessions and listens on a local network port, a security flaw here can have real consequences for your accounts and your machine. This document explains what the project protects, what it deliberately does **not** protect, how to deploy it safely, and how to report a vulnerability.

- [Supported versions](#supported-versions)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [What is in scope](#what-is-in-scope)
- [Security model](#security-model)
- [Known limitations and accepted risks](#known-limitations-and-accepted-risks)
- [Hardening guide](#hardening-guide)
- [Data handling and privacy](#data-handling-and-privacy)
- [Install, update and uninstall scripts](#install-update-and-uninstall-scripts)
- [Plugins](#plugins)
- [Dependencies and supply chain](#dependencies-and-supply-chain)
- [Safe harbor](#safe-harbor)
- [Disclosure policy](#disclosure-policy)

---

## Supported versions

Only the latest released version receives security fixes. The project ships from a single branch and the install script always updates to the newest commit, so there are no long-term-support branches.

| Version | Supported |
| --- | --- |
| Latest release (currently `1.6.x`) | Yes |
| Anything older than the latest release | No — update first (`script/install.sh` / `script\install.ps1`, or `git pull && npm run build`) |

Please reproduce any issue against the latest version before reporting it.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion that contains exploit details.**

Preferred channel — GitHub private vulnerability reporting:

1. Go to <https://github.com/JS-PACKAGE/WebChatMCP.js/security/advisories/new> (repository → **Security** tab → **Report a vulnerability**).
2. Describe the issue using the template below.

If that page is not available to you, open a public issue that says only that you have a security report and asks for a private channel. Do **not** include technical details, proof-of-concept code, logs or screenshots in that public issue. A maintainer will reply with a way to continue privately.

### What to include

A good report lets a maintainer reproduce the problem in minutes. Please include as much of the following as you can:

- **Summary** — one or two sentences describing the flaw and its impact.
- **Affected component** — e.g. `src/http.ts` (HTTP transport), `src/session.ts` (browser/session), `src/plugins.ts` (JSON plugin loader), `plugins/<name>/bridge.js` (a bridge), `plugins/lib/*`, `script/*` (install scripts), `plugins/<name>/install.*`.
- **Version / commit** — output of `git rev-parse HEAD` or the `version` in `package.json`.
- **Environment** — OS and version, Node.js version (`node -v`), whether you use stdio, HTTP or a bridge, and the values of `WEBCHATMCP_HOST` / `WEBCHATMCP_PORT` if changed.
- **Preconditions** — what the attacker needs: local user, same-LAN host, a web page opened in the victim's browser, a malicious plugin file, a malicious prompt or web-chat answer, etc.
- **Steps to reproduce** — exact commands, requests (`curl` examples are ideal) or a minimal script.
- **Expected vs. actual behavior.**
- **Impact** — what an attacker gains (read/modify files, drive the user's chat sessions, exfiltrate content, run code, delete data, ...).
- **Suggested fix** — optional, but welcome.

**Never include real credentials.** Do not attach your browser profile, cookies, tokens, API keys or private chat contents. Use a throwaway profile (`WEBCHATMCP_PROFILE_DIR=/tmp/some-dir`) and a disposable account for reproduction. Redact anything sensitive from logs.

### What you can expect

These are good-faith targets for a volunteer-maintained project, not contractual guarantees:

| Step | Target |
| --- | --- |
| Acknowledge receipt | within 3 business days |
| Initial assessment (valid / needs info / not a vulnerability) | within 7 days |
| Fix or mitigation for confirmed high/critical issues | as soon as practical, aiming for 30 days |
| Public advisory and credit | after a fixed release is available |

If you do not get an acknowledgement within a week, please nudge the report through the same channel.

## What is in scope

In scope — please report:

- **Network exposure of the MCP/bridge HTTP endpoint**: authentication or origin bypass, request smuggling, session confusion/hijacking, path traversal, denial of service by a remote party, or any way a *remote web page* can drive the server (see [CORS and DNS rebinding](#cors-and-dns-rebinding)).
- **Credential handling**: any code path that reads, logs, stores, transmits or returns passwords, cookies, session tokens or API keys, other than the intended pass-through described below.
- **Logout scope**: `webchat_logout` clearing anything other than the cookies of the selected service's domains.
- **Private/temporary chat guarantees**: a flow in which `webchat_ask` writes a prompt into the account's normal chat history while reporting `temporaryChat: true`.
- **Bridge behavior**: leaking the client's `Authorization` / `x-api-key` / `chatgpt-account-id` (or similar) headers anywhere other than the configured upstream; forwarding to an unintended upstream; response splitting; unbounded memory use.
- **JSON plugin loader**: any way for a plugin file to execute code, reach a non-HTTPS URL, escape the `domains` restriction, override a built-in provider, or make `webchat_logout` touch other sites' cookies.
- **Code plugins and install scripts**: privilege escalation, writing outside the documented locations, deleting files they did not install, following symlinks to clobber user data, skipping SHA-256 verification, command injection through environment variables or paths.
- **Prompt-injection amplification** in the web-model tool round trip (`plugins/lib/tool-protocol.js`): ways for text returned by a web chat to forge a tool call that the user did not request, bypassing the nonce envelope validation.
- **Dependency issues** that are reachable through this project's usage of the dependency.

Out of scope — please do not report these as vulnerabilities (a normal issue is fine):

- Behavior that the documentation already states as a known limitation, such as "the HTTP endpoint has no authentication" when the user deliberately sets `WEBCHATMCP_HOST=0.0.0.0`. (Bypassing protections that *are* supposed to hold on the default `127.0.0.1` binding is in scope.)
- An attacker who already has the ability to run code as the same OS user, can read `~/.webchatmcp/profile`, or can attach to the Chromium process. That attacker already owns the session.
- Vulnerabilities in ChatGPT, Claude, Grok, Gemini, Cloudflare, Chromium, Playwright or Node.js themselves — report those to their vendors. (Do tell us if this project's usage makes them worse.)
- A web service changing its UI so that selectors stop matching, or a service banning/rate-limiting automated use. Those are compatibility and terms-of-service matters, not security flaws.
- Social engineering, physical access, or attacks needing a rooted/jail-broken device.
- Findings from automated scanners without a demonstrated, reproducible impact.
- Denial of service that requires the attacker to already be authorized to send prompts (a prompt can legitimately take minutes to answer).

## Security model

### Components and trust boundaries

```
 MCP client / coding agent ──stdio──┐
                                    ├── WebChatMCP.js (Node.js) ── Playwright ── Chromium (persistent profile)
 MCP client / bridge client ──HTTP──┘          │                                      │
   127.0.0.1:8321 (default)                    │                                      └── chatgpt.com / claude.ai /
                                               │                                          grok.com / gemini.google.com
                                               └── (optional) upstream pass-through for non-web models
```

Trust boundaries, from most to least trusted:

1. **The local OS user** running the server. Everything the server stores (profile, logs, env file, caches) is protected only by that user's file permissions. The project makes no attempt to defend against the same user or against root.
2. **MCP clients and bridge clients that can reach the listening socket.** By design they are treated as the user: any client that can talk to the endpoint can ask the built-in browser to send prompts to the user's accounts. There is **no authentication** on the HTTP endpoint.
3. **The chat services** (ChatGPT, Claude, Grok, Gemini). They see every prompt and every answer. Their answers are untrusted text.
4. **Plugin files** (`plugins/*.json`, `~/.webchatmcp/plugins/*.json`). Data-only; validated and never executed.
5. **The rest of the network and every web page the user opens.** Untrusted. See the limitations below for what the default configuration does and does not guarantee against them.

### Guarantees the project aims to provide

- **No credential access.** The server never reads, writes, logs or returns passwords, cookies or tokens. Login is performed only by the user typing into the visible browser window (`webchat_login`); the resulting session lives inside the Chromium profile directory and is never parsed by this project.
- **Ephemeral chats.** Every `webchat_ask` opens a fresh private chat: ChatGPT `?temporary-chat=true`, Claude `?incognito=`, Grok `/c#private`, Gemini via the "temporary chat" button after load. The result reports `temporaryChat` as a tri-state (`true` / `false` / `unknown`); when it cannot be confirmed the tool result carries a note rather than guessing.
- **Tri-state probes.** Login and private-mode probes return `true`, `false` or `unknown`. When the page shows no recognizable indicator the answer is `unknown` — never a guess.
- **Narrow logout.** `webchat_logout` clears cookies only by domain condition for the selected service's own domains, without reading cookie values, and does not show a browser window.
- **Minimal browser visibility.** The browser is headless by default; it is shown only when a human action is required (manual login, Cloudflare verification). `webchat_login` first probes headlessly and does not open a window when the session is already logged in.
- **No automatic consent.** Dialogs that need the user's own decision (for example Grok's age confirmation) are **not** filled in; the server reports `browser_error` and points to `webchat_login`. Only "not now"/"got it"-style dismissal buttons on upgrade or tip dialogs are clicked.
- **Fixed navigation surface.** Built-in code only navigates the four services' own pages. Other sites are contacted only when the user places a JSON plugin declaring them in a plugin directory. There is no arbitrary-URL navigation tool and no remote script execution.
- **Data-only plugins.** JSON plugins are validated (HTTPS URLs only; `domains` must be the `baseUrl` host or a parent domain; built-in provider ids cannot be overridden) and never execute code. Malformed plugin files are skipped.
- **stdout hygiene.** In stdio mode stdout carries only JSON-RPC; all logs go to stderr, and errors are wrapped as JSON tool results rather than thrown into stdout.
- **Graceful port handling.** If the HTTP port is taken or not permitted, the server degrades to stdio only instead of crashing.

## Known limitations and accepted risks

Please read this section before deploying. Some of these are inherent to the design.

### The HTTP endpoint has no authentication

`http://127.0.0.1:8321/mcp` (and the bridge paths `/v1`, `/claude`, `/grok`, `/hermes`) accept requests from any client that can open the socket. The default bind address is `127.0.0.1`, which limits access to processes on the same machine.

- **Local processes.** Any process running as *any* local user on the machine can connect to the loopback port. On a multi-user machine, other users can drive your chat sessions.
- **`WEBCHATMCP_HOST=0.0.0.0` (or a LAN address).** This lets anyone on the network drive your browser and your logged-in chat accounts: send prompts as you, read answers, list models, log you out, and close the browser. **Only do this on a network you fully trust, behind a firewall, or behind an authenticating reverse proxy / VPN that you operate.** Never expose the port to the public internet.

### CORS and DNS rebinding

The HTTP transport sends `Access-Control-Allow-Origin: *` (to support browser-based MCP clients) and does not validate the `Origin` or `Host` request headers. Consequently:

- A web page open in *your* browser can send cross-origin requests to `http://127.0.0.1:8321/mcp` and bridge paths, including the CORS preflight, and read the responses. A malicious or compromised page could therefore use your locally running server to send prompts through your chat accounts, or attempt DNS rebinding against a non-loopback bind.
- Treat the running server as reachable from any page you browse to while it is up.

Mitigations available today:

- Run the server **only when you need it**, or use **stdio only** by setting `WEBCHATMCP_PORT=0` (the HTTP transport is then disabled entirely and the MCP client launches the server as a child process).
- Use a **dedicated browser profile / OS user** for untrusted browsing.
- Place a reverse proxy in front that enforces authentication and `Origin`/`Host` allow-lists if you must keep HTTP enabled on a shared machine.

Hardening this (a configurable `Origin`/`Host` allow-list and optional bearer-token authentication) is on the radar for the project. Reports that demonstrate a practical attack beyond what is described here are welcome and in scope.

### A stolen browser profile is a stolen login

The profile directory (default `~/.webchatmcp/profile`, override `WEBCHATMCP_PROFILE_DIR`) is a normal Chromium user-data directory that contains the cookies and local storage for every service you logged into. Anyone who can copy it can act as you on those services. The project does not encrypt it beyond what Chromium and your OS provide.

- It is excluded from version control (`.gitignore`). Never commit, share, sync to a cloud drive, or attach it to a bug report.
- The uninstall scripts **keep** the profile by default; deleting it requires an explicit `--purge-profile` / `-PurgeProfile`.
- Use full-disk encryption and a locked screen on machines holding the profile.

### Prompts and answers go to third parties

Everything sent through `webchat_ask` or a bridge is submitted to the selected chat service and subject to that service's privacy policy, retention rules, abuse monitoring and terms of service. "Temporary/private chat" reduces what lands in your chat history; it does **not** make the service unable to see or retain the content. Do not send secrets (keys, tokens, customer data) you would not paste into that website.

Guest mode (ChatGPT and Gemini work without logging in) is anonymous to the service only in the sense that no account is attached — IP address, browser fingerprint and the prompt itself are still visible to it.

### Automated use of third-party websites

This tool automates the public web UIs of third-party services. Those services may rate-limit, challenge (Cloudflare) or restrict automated use, and their terms of service may forbid it. Using the project is your responsibility with respect to those terms. A ban or captcha is not a vulnerability of this project.

### Answers from web chats are untrusted

Text returned by a chat service is attacker-influenceable (via the prompt, retrieved web content, or the service itself). Treat it like any other untrusted model output:

- Do not auto-execute commands or code that came back from a web model without review.
- The web-model tool round trip used by the bridges (`plugins/lib/tool-protocol.js`) wraps requests/results in a per-request nonce envelope that is parsed and validated, so text that merely *looks* like a tool call is not accepted. This reduces, but cannot eliminate, prompt-injection risk: a coding agent that grants tool access (shell, file write) to a web model inherits the risk of the model being manipulated. Keep the agent's own permission prompts enabled for destructive tools.

### Bridges forward the client's credentials upstream

For models that are **not** web models, each bridge acts as a transparent pass-through to the official backend so the host program keeps working when its base URL points at this server:

| Bridge | Local path | Default upstream |
| --- | --- | --- |
| Codex | `/v1` | `https://chatgpt.com/backend-api/codex` (ChatGPT login) or `https://api.openai.com/v1` (API key) |
| Claude Code | `/claude` | `https://api.anthropic.com` |
| Grok Build | `/grok` | configured model upstream |
| Hermes Agent | `/hermes` | configured model upstream |

In this pass-through all request headers except hop-by-hop ones — including `Authorization`, `x-api-key` and `chatgpt-account-id` — are forwarded unchanged to the upstream. The server does not store or log them. Consequences:

- Anyone who can reach a bridge path can use your credentials *if* your client sends them, and can observe nothing the upstream wouldn't show to them anyway; keep the bridge reachable only from the client that needs it.
- `WEBCHATMCP_CODEX_UPSTREAM` / `WEBCHATMCP_CLAUDE_UPSTREAM` (and the equivalents) replace the upstream. **Point them only at hosts you trust and over HTTPS** — whoever runs that upstream receives the forwarded credentials. The bridges do not follow upstream redirects (`redirect: "manual"`), so a redirect cannot silently re-target your credentials, but they do pass the redirect response to the client.
- Request bodies are capped at 64 MiB in the shared bridge kit; this is a resource-safety limit, not a strong DoS defense.

### Resource usage

A running server holds a Chromium instance. Browser operations are serialized with a lock, so concurrent clients queue behind each other and one slow prompt delays the rest. A client that can reach the endpoint can keep the browser busy; the per-request timeout (`timeout_seconds`, `WEBCHATMCP_ANSWER_TIMEOUT_MS`) bounds each call but is not rate limiting.

### Single-profile sharing

The background service and any stdio instance share one browser profile directory. Do not run both at once against the same profile; Chromium locks the profile and the second instance can interfere with or corrupt the first one's state.

## Hardening guide

Checklist for a safer deployment:

1. **Keep the default bind address** (`127.0.0.1`). Do not set `WEBCHATMCP_HOST=0.0.0.0` unless you have network-level access control in front of it.
2. **Prefer stdio when HTTP is not needed.** Set `WEBCHATMCP_PORT=0` to disable the HTTP transport (and with it the bridges) completely. Individual bridges can be switched off with `WEBCHATMCP_CODEX_BRIDGE=0`, `WEBCHATMCP_CLAUDE_BRIDGE=0`, `WEBCHATMCP_GROK_BRIDGE=0`, `WEBCHATMCP_HERMES_BRIDGE=0`.
3. **Stop the service when you are not using it** (`script/install.sh stop`, then `start` when needed), especially if you browse untrusted pages on the same machine — see [CORS and DNS rebinding](#cors-and-dns-rebinding).
4. **Use a dedicated OS account or container/VM** for the server on shared or sensitive machines so other local users cannot reach the loopback port or read the profile.
5. **Protect the profile directory**: owner-only permissions (`chmod 700 ~/.webchatmcp`), disk encryption, no cloud-sync of `~/.webchatmcp`.
6. **Use separate chat accounts** for automation rather than your primary personal or corporate account, and log out (`webchat_logout`) when finished.
7. **Do not paste secrets** into prompts. Sanitize logs before sharing; they may contain URLs and error text.
8. **Pin and review upstream overrides.** Leave `*_UPSTREAM` unset unless you are deliberately testing, and never point it at a host you do not control.
9. **Review plugins before placing them** in a plugin directory; although JSON plugins are data-only, a plugin declares which site the browser will visit and which selectors it will interact with.
10. **Review code plugins before installing** (`plugins/omp`, `pi`, `codex`, `claude`, `grok`, `hermes`): they modify the configuration of other programs (see below).
11. **Keep up to date.** Run the update command regularly; security fixes are delivered only in the latest version.
12. **Keep your OS, Node.js (≥ 22) and Chromium current.** The install script can download a private Node.js into `~/.webchatmcp/node` with SHA-256 verification; `npx playwright install chromium` updates the bundled browser.

## Data handling and privacy

| Data | Where it lives | Notes |
| --- | --- | --- |
| Login sessions (cookies, local storage) | Chromium profile: `~/.webchatmcp/profile` (`WEBCHATMCP_PROFILE_DIR`) | Written by Chromium, not by this project. Never read or logged by this project. Kept on uninstall unless `--purge-profile`. |
| Prompts and answers | In memory while a request runs; sent to the chat service | The server does not write prompt or answer contents to its own log; logs record provider names, durations and status. Bridges are request/response pass-through. |
| Server log | `~/.webchatmcp/logs/` when installed as a service; stderr otherwise | Contains operational messages (provider, elapsed time, errors, truncated session ids). Review before sharing. |
| Service environment | `~/.webchatmcp/webchatmcp.env` | `KEY=VALUE` configuration only. Do not put secrets here. |
| Model list caches | e.g. `~/.webchatmcp/hermes-models.json`, the Codex models cache | Contain model labels scraped from menus, not credentials. |
| Host program config edited by plugins | e.g. Codex/Grok `config.toml`, Claude `settings.json`, Hermes home | Backed up/edited atomically; see [Code plugins](#code-plugins-install--uninstall). |
| Source code | `~/.webchatmcp/app` after a remote install | Removed only by `--purge`; a user-owned clone is never deleted. |

The project has **no telemetry** and makes no network connections other than: the chat services' own pages (and plugin-declared sites), the documented bridge upstreams, the Node.js/MinGit download hosts during installation, and `git` fetches from the project repository during install/update.

## Install, update and uninstall scripts

The scripts in `script/` are designed to be run remotely (`curl -fsSL https://webchatmcp.js-package.xyz/script/install.sh | bash`, and the PowerShell equivalent). Piping a remote script into a shell is a trust decision. To reduce the risk:

- **Inspect first.** Download the script, read it, then run it: `curl -fsSLO https://webchatmcp.js-package.xyz/script/install.sh && less install.sh && bash install.sh`. Or clone the repository and run the script from the checkout.
- **Verify the transport.** The site and repository are served over HTTPS. Compare the script with the one in the GitHub repository if in doubt.
- **Whole script in a function.** The script body is wrapped in a function that is invoked only at the very end, so a truncated download cannot execute a partial script.

What the scripts do and do not do:

- They **do not require root or administrator rights**, with one documented exception: on Linux, if `git` is missing, the script installs it with the distribution's package manager via `sudo`. If you prefer, install `git` yourself first.
- Node.js (when the system one is too old) is downloaded into `~/.webchatmcp/node` and its **SHA-256 is verified** before use; on Windows, MinGit is downloaded and verified the same way. A mismatch aborts the installation. The system Node.js is never modified.
- `git clone` / `git fetch` pulls source from the project repository. Update **aborts if the working tree has uncommitted changes**, so your local edits are never overwritten.
- Before updating they **stop the running service and any leftover `WebChatMCP.js` processes** (including stdio instances started by an MCP client).
- Service registration uses per-user mechanisms only: LaunchAgent (macOS), `systemd --user` or crontab `@reboot` (Linux), Task Scheduler at logon (Windows). On Linux, enabling *linger* (start at boot without login) is attempted with your own rights or a password-less `sudo -n`, and is otherwise only suggested to you.
- **Uninstall** removes the service registration and autostart setup. By default it keeps the source, the login profile and the env file. `--purge` / `-Purge` additionally removes Node.js, git (if installed by the script), logs, the env file and source downloaded by a remote install; the **login profile is deleted only with `--purge-profile` / `-PurgeProfile`**. A repository you cloned yourself is never deleted.
- Windows `.ps1` files are UTF-8 with BOM so that Windows PowerShell 5.1 parses them correctly.

If you find a way to make a script act outside these rules (for example via a crafted environment variable, path with spaces/metacharacters, or symlink), that is a reportable vulnerability.

## Plugins

### JSON service plugins (`plugins/*.json`, `~/.webchatmcp/plugins/*.json`)

Data-only descriptions of additional chat services. They are loaded at startup and validated; files starting with `_` (such as the template) and malformed files are skipped. A plugin:

- must use `https` URLs for `baseUrl` and `askUrl`;
- must restrict `domains` to the `baseUrl` host or one of its parent domains (and each domain must contain a dot), which bounds what `webchat_logout` can clear;
- cannot reuse a built-in service id (`chatgpt`, `claude`, `grok`, `gemini`);
- cannot run code — it only supplies URLs, text markers and CSS selectors that the existing automation uses.

Still, a plugin tells the built-in browser which website to open, where to type your prompt and which page elements to click, so **a plugin you did not write is as trustworthy as the website it points to.** Only install plugins from sources you trust; remember that your prompts will be typed into that site. The user plugin directory can be changed with `WEBCHATMCP_PLUGINS_DIR`; keep it writable only by you.

### Code plugins (install / uninstall)

`plugins/omp`, `plugins/pi`, `plugins/codex`, `plugins/claude`, `plugins/grok` and `plugins/hermes` integrate WebChatMCP.js into other programs. They are separate from the data-only JSON plugins and **do run code and modify other programs' configuration**, so review them as you would any installer. Each ships `install.sh`, `uninstall.sh`, `install.ps1` and `uninstall.ps1` with these properties:

- No root/administrator rights are needed.
- Installation is **idempotent**, and refuses to overwrite a same-named target that it did not install unless you pass `--force` / `-Force`.
- Ownership is tracked with an **install marker** (a symlink pointing into this repository, or a marker file). Uninstall removes only what carries the marker and leaves everything else alone.
- Uninstall **keeps user data** (caches, settings, login profile) unless `--purge` / `-Purge` is given.
- Config files such as `config.toml` / `settings.json` are edited atomically (temp file + rename, existing file mode preserved, new files created `0600`), and the host program is closed before editing so it does not overwrite the change.
- The Hermes plugin writes a **placeholder API key** for the `webchat` provider; the placeholder is not a credential and is not accepted by any real service.
- Bridges (`plugins/*/bridge.js`) are loaded by the server from the repository checkout at startup; if you edit them, you are changing code that sees your prompts and forwarded upstream credentials.

## Dependencies and supply chain

Runtime dependencies are intentionally few: `@modelcontextprotocol/sdk`, `playwright` and their transitive dependencies (see `package.json` / `package-lock.json`). The build uses only `tsc`; there is no bundler and no postinstall script in this project.

- Run `npm audit` after installing. Report advisories that are *reachable* through this project; unreachable transitive findings are tracked as normal maintenance.
- `package-lock.json` is committed so installs resolve to reviewed versions.
- The compiled `dist/` output is committed and must match `src/`. When auditing, rebuild with `npm run build` and confirm there is no diff.
- Playwright downloads a Chromium build from its own CDN on `npx playwright install chromium`; that download is governed by Playwright's integrity checks, not by this project.

## Safe harbor

We support good-faith security research. If you:

- make a reasonable effort to avoid privacy violations, data destruction and service disruption;
- test only against **your own** installation and **your own** accounts, using throwaway profiles and disposable accounts;
- do not attack, scrape or load-test ChatGPT, Claude, Grok, Gemini or any other third-party service through this tool beyond what is necessary to demonstrate the issue;
- give us a reasonable time to fix the issue before disclosing it publicly; and
- do not exfiltrate, retain or disclose other people's data,

then we will consider your research authorized, will not pursue or support legal action against you for it, and will work with you to understand and resolve the issue. This statement covers this project only; it cannot grant permission to test third-party services, which have their own policies.

## Disclosure policy

- We prefer **coordinated disclosure**. Please keep the details private until a fix is released or 90 days have passed since the report, whichever comes first; we will tell you if we need more time and why.
- When a fix ships we publish a GitHub Security Advisory describing the impact, affected versions, the fixed version and workarounds, and request a CVE for issues of moderate or higher severity.
- Reporters are credited in the advisory unless they ask to remain anonymous.
- Severity is assessed with CVSS 3.1/4.0 in the context of a local-first tool; issues that are exploitable from a remote website or the network against the default configuration are rated highest.
- Non-security bugs should go to the normal issue tracker.

Thank you for helping keep WebChatMCP.js and its users safe.
