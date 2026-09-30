# dsh-plugin-ollama-usage

English | [中文](README.zh.md)

Shows **Ollama Cloud account usage** (5-hour rolling window / weekly) on the
[dsh](https://github.com/deepseek-ai/deepseek-harness) Web chat page, and provides
a `baseURL` / credential-mode configuration.

## Features

- Shows one panel below the composer in the active session and another on the new-session (hero) page; both carry the same content.
- Reports both the `session` (5-hour rolling) and `weekly` windows as percentages, refreshed every 5 minutes by default.
- Read-only account usage: it touches no provider configuration and starts no conversations.
- Supports two modes: reusing an existing Ollama key, or using a plugin-specific key.
- When credentials are missing, the endpoint does not offer usage, or the response is malformed, the panel disappears silently — no placeholder, no error.

## Installation

Requirements: dsh with the `web` profile (tested with `0.2.0-rc.1`), Node `^22.19.0 || >=24.0.0`, and a working Ollama Cloud API key.

This package is a dsh bundle: installing it appends the bundle to the profile and applies its patch layer.

### Install from GitHub (recommended)

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-ollama-usage
```

### Install from a local directory

```bash
git clone https://github.com/CJ-SH/dsh-plugin-ollama-usage
dsh plugin --profile web add ./dsh-plugin-ollama-usage
```

### `link:` installs need one extra step

A plugin installed through `link:` lives outside the profile, so the profile's install closure has to be linked into the package (idempotent; unnecessary for a materialized install):

```bash
npm run link-imports
```

**Do not** use `npm install` to install the `@deepseek-ai/schemastery` peer — copying it breaks module identity.

The plugin loads at startup, so restart dsh after installing; `dsh --profile web --dump-config | grep ollama-usage` gives you a pre-flight check.

## Usage

The panel appears below the composer in the active session and on the new-session (hero) page:

```
Active session · below composer     session 26% · weekly 6%
New session (hero)                  the same panel
Configuration                       baseURL / credential mode / key
```

The configuration entry point is the "Ollama Usage" page in Settings (the Settings page the plugin registers; merged into the hub panel when the suite hub is installed),
or you can edit the `config:` block of `- id: ollama-usage` directly in `~/.dsh/profiles/<profile>/cordis.patch.yml`
(fields `baseURL` / `credentialMode` / `apiKeyEnv`).

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-ollama-usage
```

## Technical notes

- Two credential modes: **credential mode** (`reference`, the default) reuses an existing `apiKeyEnv` (default `OLLAMA_API_KEY`) and this plugin cannot write to it; **key mode** (`direct`) writes only its own reference, `OLLAMA_USAGE_API_KEY`.
- The usage endpoint currently returns only window names, with no reset timestamps, so the panel renders rolling semantics (reset every 5 hours / every 7 days / every 30 days); if the endpoint ever returns `resets_at`, it will switch to absolute times automatically.
- The slots and containers are dsh-internal contracts and a dsh upgrade may move them; a panel that does not render is itself the failure mode (no placeholder, no error).
- Settings and credentials survive uninstall; remove the `- id: ollama-usage` block from the profile patch by hand if you want them gone.

## Further reading

Contracts, troubleshooting, and internals are in [docs/design-notes.md](docs/design-notes.md).

## License

MIT © 2026 HenTaiCJN

Ollama is a product of Ollama Inc.; this plugin is not affiliated with it and only calls its public API.
