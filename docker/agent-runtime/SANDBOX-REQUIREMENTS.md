# Sandbox Runtime Requirements

This document states the sandbox environment as a contract. The sandbox owner
must meet this contract. The Paperclip runtime does not build the environment at
exec time. The environment is a requirement, not a build step.

This document states requirements. It does not state build steps.

## Required on PATH

- `node` must be installed and on the PATH.
- Each agent CLI that the run uses must be installed and on the PATH. The set of
  agent CLIs includes `claude`, `codex`, `gemini`, and similar CLIs.
- The owner installs only the CLIs that the run uses. The owner does not need to
  install a CLI that no run uses.

## Detection contract

Paperclip probes each CLI before launch. Paperclip uses the same detection
pattern that the runtime Dockerfiles use:

```bash
command -v <cmd> || exit 1
```

Paperclip probes each CLI with `command -v <cmd>`. Paperclip fails loudly when
the CLI is absent. Paperclip does not install the CLI. Paperclip does not repair
the PATH.

## Firm rule

- The Paperclip runtime never modifies the login profile. The runtime never
  writes a profile file. The runtime never writes an rc file.
- The Paperclip runtime never sources `nvm` on the exec path.
- The sandbox owner supplies a ready PATH. The PATH must resolve `node` and each
  used agent CLI without any action from the runtime.
