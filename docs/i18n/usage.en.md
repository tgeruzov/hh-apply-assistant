# Using HH Apply Assistant

HH Apply Assistant starts from the current hh.ru vacancy search page. It works through eligible vacancies on that page and returns to the same results. Moving to the next results page is manual.

## Quick start

1. Sign in to hh.ru and prepare a vacancy search.
2. Open the HH Apply Assistant panel.
3. Choose a work mode and application limit. **Balanced** and a limit of 50 are the defaults.
4. Review the cover-letter text. Cover letters are enabled by default; **Apply when HH warns** is off by default.
5. Select **Start applying**.
6. Watch the status, statistics, and **Manual queue**. Select **Stop** whenever you want to end the run.

The limit counts confirmed applications in the current run. Starting again resets that counter, but it does not clear the processed-vacancy history for the tab.

## Main controls

- **Safe**, **Balanced**, **Fast**, and **Turbo** change the delay between actions. These names describe pacing; they do not guarantee that hh.ru will not show a CAPTCHA or apply account restrictions.
- **Application limit per run** accepts a value from 1 to 500.
- **Cover letter** controls whether the assistant fills a standard cover-letter field. Review the text before each run.
- **Apply when HH warns** allows an application to continue through hh.ru's likely-rejection warning. It is disabled by default.
- **Reset history** lets the current tab process previously handled vacancies again. It also resets the run counter and statistics, but not your settings or manual queue.

Collapsing the panel does not stop an active run. On smaller screens, the panel becomes compact or opens over the page.

## Manual queue

The assistant does not complete employer questionnaires. It also sends uncertain results, missing confirmation, and applications stopped by an hh.ru warning to the **Manual queue** for review.

A queue entry does not prove that an application failed. Open the vacancy and check its current state before taking action. You can open or remove individual entries, clear the queue, or export the full list.

## Diagnostics and stopping conditions

Open **Diagnostics** to review the log. Use **Check page** on the page where a problem occurs. **Download log** creates a local report; review and redact it before sharing because it can contain URLs and limited page text.

The assistant stops when it reaches the limit, finishes the current results page, detects a CAPTCHA, or encounters a critical storage error. An application whose outcome cannot be confirmed goes to the **Manual queue** instead of being counted as successful. The assistant does not bypass CAPTCHA and does not automatically continue after you solve one.

For setup problems, see [Installation](installation.en.md) and [Troubleshooting](troubleshooting.en.md). For stored data and exports, see [Data and privacy](PRIVACY.en.md).
