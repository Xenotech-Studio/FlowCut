# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

- Before your first commit in a fresh clone, enable the repository hooks once:
  `git config core.hooksPath scripts/git-hooks`
  The hooks mirror what GitHub Actions checks; if a hook rejects a commit, read its message and fix the commit rather than bypassing it. Never use `--no-verify`.
- Submodules are separate git repositories; the setting above does not propagate into them. See the README for the global-hook variant that covers them.
