# Contributing

HH Apply Assistant welcomes focused bug fixes, UI improvements, tests, and documentation changes. Report an ordinary problem with the [English bug form](https://github.com/tgeruzov/hh-apply-assistant/issues/new?template=bug_report_en.yml). Please open a [feature request](https://github.com/tgeruzov/hh-apply-assistant/issues/new?template=feature_request_en.yml) before a large change to application behavior, stored data, or browser permissions.

Report vulnerabilities through the [Security Policy](SECURITY.en.md), not a public bug report. Project discussions also follow the [Code of Conduct](../../.github/CODE_OF_CONDUCT.md), which is currently maintained in Russian.

## Setup

You need Git and Node.js 24. Desktop Chrome with Tampermonkey is needed only for changes that require a manual browser check. There is no build step or npm install.

Clone the canonical public repository and create your branch from `main`:

```bash
git clone https://github.com/tgeruzov/hh-apply-assistant.git
cd hh-apply-assistant
git switch main
git switch -c fix/short-description
```

Run the baseline checks before editing:

```bash
node --check hh-apply-assistant.user.js
node --test
```

## Make a focused change

- Keep the pull request to one clear bug or use case.
- Update tests and documentation when public behavior changes.
- Keep Russian and English UI text in sync. Keep `README.md` and `README.en.md` factually aligned when either changes.
- Discuss any new network access, userscript permission, or external runtime dependency before implementation.
- Never add personal data, cookies, tokens, cover letters, private URLs, or unredacted diagnostic reports to tests, screenshots, issues, or commits.

For UI or application-flow changes, test only with a safe account context and a minimal limit. Check the affected page type, **Start applying**, **Stop**, both interface languages, and any responsive layout you changed.

## Validate the result

Run:

```bash
node --check hh-apply-assistant.user.js
node --test
node scripts/validate-repository.mjs
git diff --check
```

## Open a pull request

Describe the reason for the change, its user-visible effect, and the checks you ran. Note any effect on application behavior, UI, localization, stored data, diagnostics, permissions, or privacy.

Update `CHANGELOG.md` for a meaningful user-facing change. Leave version bumps to a release pull request.
