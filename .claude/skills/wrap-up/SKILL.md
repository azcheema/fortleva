---
name: wrap-up
description: Check whether this session's work is finished and safe to close — everything committed and pushed, CI green, PLAN §0 and memory recorded, nothing still running — and tell the founder plainly whether they can clear the context and close the session. Use when the founder asks "is everything done, can I clear the context / close the session?" or types /wrap-up.
---

# Wrap up: is it safe to close this session?

The founder wants to clear the context and start a fresh session. Answer ONE question: **is anything from this session still unfinished, unsaved or unrecorded?** Check, don't assume — a summary written earlier in the session is not evidence. These checks are read-only; never kill, revert or delete anything to make a check pass.

Run every git and gh command with `< /dev/null` (a bare stdin reader hangs the Bash tool) and never pipe a command whose exit code you need.

## The checks

1. **Saved.** `git status --short` is empty (an untracked or modified file is either work to commit or a leftover — a mutation-check backup, a stray probe — to name). `git log origin/main..HEAD --oneline` is empty (nothing unpushed).
2. **Green.** Find the newest commit that touched more than `docs/**` and `*.md` (`ci.yml` ignores those, so a docs-only commit starts no run). `gh run list --commit <sha> --json status,conclusion,databaseId` must show the CI run `completed` / `success`. If it is still running, say so and watch it in the background (`gh run watch <id> --exit-status`) — the answer is "not yet". If it failed, the answer is "not done".
3. **Nothing still running.** No background shell task or subagent this session started is still running or has an unread result. Say which, if any.
4. **Recorded.**
   - `docs/PLAN.md` §0's top STATE paragraph names this session's slice, its commit, its CI run and result, and the NEXT step.
   - Any founder decision made this session is in `docs/OPEN_QUESTIONS.md`.
   - The memory file `fortleva-project.md` and its line in `MEMORY.md` mention this session's slice and its lessons.
   - Record-only gaps here (a CI result not yet written into PLAN §0, a memory line) are this session's own duty: fill them, commit and push the docs change, then re-check. Anything bigger — ask first.
5. **Database matches the code.** Only if this session wrote a migration: `pnpm exec prisma migrate status` reports the dev database up to date (redirect its output to a file; it prints the datasource host).
6. **No leftovers on the machine.** If this session started a dev server or an e2e run, check that nothing it started is still listening (`netstat -ano | grep LISTENING` on the ports it used, e.g. 3000 or 3457). Report one; never stop a process you did not start.

## The answer

Keep it short and plain — the founder wants guidance "simple and short".

- **All clear:** "Yes — safe to clear the context and close." Then at most three lines: the last commit and its CI run, what the next session starts with (usually: type `continue`; PLAN §0 says what is next), and the one-line model/effort suggestion for that next work (`⚙️ Suggest: <model>, effort <level> — <reason>`).
- **Not yet:** "Not yet —" and a short list of exactly what is left, each with what you will do about it (or the question for the founder). Offer to finish it now.
