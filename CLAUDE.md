# NemoClaw — Agent Instructions

## Git Hooks

Pre-commit, commit-msg, and pre-push hooks are managed by **prek**. Install them after cloning:

```bash
npm install          # root — also runs `prek install` via the prepare script
cd nemoclaw && npm install && cd ..
```

If hooks aren't firing, verify: `ls .git/hooks/pre-commit` should show the prek shim. If `core.hooksPath` is set from an old Husky setup, clear it: `git config --unset core.hooksPath`, then `npm install` again.

## Never use `--no-verify`

Do **not** pass `--no-verify` (or `-n`) to `git commit` or `git push`. The hooks catch the same issues CI checks — skipping them just pushes broken code that blocks the PR.

If a hook fails, fix the issue before committing. If a hook itself is broken, open an issue.
