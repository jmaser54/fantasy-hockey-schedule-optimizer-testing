# CLAUDE.md — Playoff Planner

Vite + React + TypeScript single-page app, deployed to GitHub Pages. The canonical detailed reference is **`docs/PROJECT_SOURCE_OF_TRUTH.md`**: product requirements, architecture, business rules, persistence, testing, regression lessons and open questions.

## Before changing anything
1. Read the relevant sections of `docs/PROJECT_SOURCE_OF_TRUTH.md` before any change that could affect documented requirements, product behavior, business rules, architecture, data flow, persistence or known regressions (§G).
2. Inspect the relevant current code and tests; don't rely only on the doc, assumptions or conversation history. The doc can go stale. If it disagrees with the code, investigate and say so; don't silently pick one.
3. Check `git status` first and preserve any existing changes. Don't commit unrelated work.

## Scope
- Do only what the user asked. These instructions don't authorize broader work.
- Make the smallest maintainable change. No unrelated refactoring, redesign, cleanup or feature work.
- Preserve confirmed product requirements and existing functionality unless the user explicitly authorizes a change. If a request conflicts with a documented requirement, flag the conflict rather than changing the requirement or unrelated functionality.
- "Text-only" or "UI-only" changes must not alter handlers, conditions, data or calculations. Confirm this in the diff.
- If a change needs a functional or data-model change the user didn't ask for, stop and ask.

## Verify and report honestly
- Run what's relevant: `npm run typecheck`, `npm test`, `npm run build` and the data check (`node --experimental-strip-types --no-warnings scripts/check-data.ts`). For UI work, also check in a browser (`npm run build && npx vite preview`) at desktop and phone widths (390px and 360px).
- Fix any regression you introduce. Report what you verified and what you couldn't. Never claim live-site or email delivery checks you didn't perform.
- This dev container can't reach the NHL/ESPN APIs, `github.io` or `formsubmit.co`. Live checks happen only in the GitHub Actions smoke test.
- Copy in the Lineup heading, the Roster tab and the paste label is asserted by `scripts/smoke-test.mjs`. Update it if you change that copy.

## Git and deployment
- This is the **testing repo** (`jmaser54/fantasy-hockey-schedule-optimizer-testing`). Work on its default branch `main` unless told otherwise; the live repo uses `claude/practical-faraday-ti8p02`.
- **Every push to the default branch redeploys that repo's site** (here, the testing site) (`.github/workflows/deploy-pages.yml`), and CI runs on every push.
- A bot commits daily data refreshes to this branch, so `git pull --rebase` before pushing.
- Commit only the files the task touched.

## Delegation (specialist subagents)
- `.claude/agents/` defines three review-only specialists (they report; they never change anything): `insights-analyst`, `qa-reviewer` and `data-auditor`. The main session stays the only implementer, integrator, committer, pusher and deployer, and the only one that triggers workflows or touches Live.
- Material Insights logic or methodology changes get an independent QA review: implement on Testing, push and name the frozen commit, have `qa-reviewer` review it, address the findings and rerun the checks, then report and ask before any Live promotion. Minor text-only changes can skip it. QA never approves or fixes its own findings.
- Give each specialist a brief with the question, the pinned commit or data snapshot, the source-of-truth sections to read, what's out of scope, and a scratch folder under the session scratchpad. Don't run overlapping delegations or redo delegated work.
- Specialists have Bash, so they aren't technically read-only. The project Bash hook in `.claude/settings.json` runs `.claude/hooks/specialist-bash-guard.py`, which applies only when Claude Code's `agent_type` is one of the three specialists (the main session and other agents pass straight through) and blocks common modifying commands. It's a guardrail, not a security boundary: programs started from allowed commands can still write files. After every delegation, check `git status` in both clones and revert and report any change a specialist made. Don't put hooks in agent frontmatter: Claude Code skips them in untrusted project folders (§G 20).
- Relay specialist reports with your own assessment; only the main session records decisions in the source of truth.

## Keep the source of truth current
- Update `docs/PROJECT_SOURCE_OF_TRUTH.md` in the same commit whenever:
  - the implementation changes something it describes (behavior, architecture, data flow, persistence, commands, workflows);
  - a requirement or decision is made or changed by the user;
  - a documented limitation, discrepancy or open question is resolved, or a new one is discovered;
  - a regression teaches a lesson worth keeping (§G).
- Keep the labels honest:
  - **Confirmed** = an explicit user decision;
  - **Implemented** = verified in the current code;
  - **Open** = unresolved.

  Never silently turn an Open item or an assumption into a Confirmed decision; record the user's decision when they make one. Passing tests or the existence of a function doesn't prove documented behavior; check the code.
- Keep the document focused and accurate: correct or remove stale statements rather than appending history. Update its "Last reviewed" line when you review it. Don't copy its contents into this file; link to it.
- Keep documentation out of the deployed website. Never add docs to `public/`, import them into the app, or link them from the site's UI or navigation. The repository is public, so don't put secrets in docs.
