# HH Apply Assistant

[Русский](README.md) | [English](README.en.md)

[![Version](https://img.shields.io/badge/version-4.0.0-2563eb.svg)](CHANGELOG.md)
[![CI](https://github.com/tgeruzov/hh-auto-responder/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tgeruzov/hh-auto-responder/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-2563eb.svg)](LICENSE)

HH Apply Assistant is a userscript for automating standard job applications on hh.ru. It adds a side panel to search and vacancy pages, processes cards on the current result page, and keeps questionnaires or unconfirmed outcomes in a manual queue.

[Install HH Apply Assistant](https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js) · [Installation guide](docs/installation.md) · [User guide](docs/usage.md) · [Troubleshooting](docs/troubleshooting.md)

> [!WARNING]
> This is an independent project and is not affiliated with hh.ru or HeadHunter. Platform rules and limits can change, and automation may lead to CAPTCHA challenges, temporary restrictions, or an account block. You are responsible for how you use the script and for the resulting risks.

## What it does

- processes vacancies that have not yet been handled on the current search page;
- supports standard application forms, cover letters, and strict send confirmation;
- provides four pacing profiles: **Safe**, **Balanced**, **Fast**, and **Turbo**;
- applies a per-run successful-application limit and shows run statistics;
- stores questionnaires, reject warnings, and unclear outcomes in a manual queue;
- keeps local diagnostics with search, filters, metrics, Healthcheck, and report export;
- includes Russian and English UI;
- resumes across page navigation and prevents a normal parallel run in another tab;
- stops on CAPTCHA and critical persistence failures.

The script depends on hh.ru DOM and response flows. Site changes can require selector or scenario updates.

## Interface

On wide screens, the panel is docked to the right of hh.ru. It switches to a compact layout and then an overlay as available width decreases. Collapsing the panel does not stop an active run.

There are no current screenshots yet. [docs/assets/screenshots](docs/assets/screenshots/README.md) is ready for reviewed images that do not contain personal data.

## Installation

The documented installation path is desktop Chrome with a current Tampermonkey release.

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. In Chrome 138 or newer, open Tampermonkey's extension details and enable **Allow User Scripts**. Older Chromium versions use the global **Developer mode** toggle for the User Scripts API.
3. Keep the required Tampermonkey site access enabled for hh.ru and update checks. The [installation guide](docs/installation.md) explains the relevant Site access setting.
4. Open the [install URL](https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js) and confirm the Tampermonkey prompt.
5. Sign in to hh.ru, open [vacancy search](https://hh.ru/search/vacancy), and reload the page. The HH Apply Assistant panel should appear on the right.

The metadata contains `@updateURL` and `@downloadURL`, so Tampermonkey can use its normal userscript update mechanism after a newer version is published to `main`. Manual editor installation remains available as a fallback.

## Quick start

1. Configure an hh.ru search and open the result page you want to process.
2. Select a pacing profile. **Balanced** is the default; the initial limit is 50 and cover letters are enabled.
3. Review the letter text. Applying through an hh.ru likely-rejection warning is disabled by default.
4. Click **Start applying**. The limit counts only confirmed successful sends in this run.
5. Watch the status, **Manual queue**, and **Diagnostics**. Click **Stop** to end the run.

Processed-vacancy history belongs to the current tab and is not cleared by a new Start. The script does not advance to the next search results page automatically.

## Limits and local data

- Employer questionnaires are not completed automatically.
- CAPTCHA is not bypassed. Automation stops until you solve it and start again.
- An ambiguous or missing confirmation is never counted as a successful send.
- Settings, cover-letter text, the manual queue, and diagnostics use `localStorage` on the `hh.ru` origin. Run state and per-tab history use `sessionStorage`.
- Runtime source contains no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `@require`, or `@resource`. Exports are created locally with `Blob`.
- A diagnostic export includes URLs/paths, user agent, run state, metrics, logs, and limited diagnostic DOM fragments. Review and redact it before sharing.

See [storage](docs/storage.md), [diagnostics](docs/diagnostics.md), and [privacy notes](PRIVACY.md) for details.

## Documentation

- [Installation and updates](docs/installation.md)
- [Using the assistant](docs/usage.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Developer documentation index](docs/README.md)

The detailed documentation is maintained in Russian; the facts and user-facing setup in this README match the Russian version.

## Contributing

There is no build step or npm dependency installation. Local setup, testing, and pull-request requirements are covered in [CONTRIBUTING.md](CONTRIBUTING.md). Use the [issue templates](https://github.com/tgeruzov/hh-auto-responder/issues/new/choose) for bugs and feature requests, and follow the [Security Policy](SECURITY.md) for vulnerabilities.

## License

HH Apply Assistant is licensed under the [GNU General Public License v3.0 only](LICENSE), SPDX: `GPL-3.0-only`.
