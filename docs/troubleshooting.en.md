# Troubleshooting

## The panel does not appear

Check these items in order:

1. Confirm that the Tampermonkey extension is enabled in Chrome, then open its Dashboard and confirm that **HH Apply Assistant** is enabled.
2. In Chrome 138 or newer, open Tampermonkey's extension details and turn on **Allow User Scripts**.
3. Confirm that Tampermonkey Site access includes hh.ru.
4. Use a supported page: vacancy search, an individual vacancy, or an hh.ru application or questionnaire page.
5. Reload the page after installing or changing the script.

On a narrow window, the panel may be collapsed. Look for the vertical HH Apply Assistant tab at the edge of the page.

Older Chrome or Chromium versions may require the global **Developer mode** setting instead of **Allow User Scripts**. It is not required solely for Tampermonkey in current Chrome.

## The Raw link shows source code

Chrome has not handed the `.user.js` file to Tampermonkey. Confirm that the extension and **Allow User Scripts** are enabled, allow Site access to `raw.githubusercontent.com`, then reopen the [install link](https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js).

If that still fails, use the [manual installation steps](installation.en.md#manual-installation).

## A run does not start

- **Active in another tab:** stop the assistant in the other hh.ru tab. If that tab closed unexpectedly, wait briefly and try again.
- A storage warning: check that Chrome allows site data for hh.ru and that browser storage is not full.
- No visible change: reload the supported page, open **Diagnostics**, and select **Check page**.

## No vacancies are processed

The assistant handles only the current search results page and skips vacancies already recorded by the current tab. Use **Reset history** if you intentionally want to process those vacancies again.

It can also skip cards whose application control is not visible. Run **Diagnostics → Check page** on the affected search page. If the check reports an error for a control that should be present, include that result in a bug report.

## A vacancy is in the Manual queue

This is expected for employer questionnaires, a likely-rejection warning when **Apply when HH warns** is off, missing application controls, timeouts, or an outcome the assistant could not confirm safely.

Open the queue entry and review it manually. The queue does not guarantee that the application was not sent.

## CAPTCHA stops the run

Solve the CAPTCHA yourself, return to a supported page, and start a new run. HH Apply Assistant does not bypass CAPTCHA or resume automatically afterward.

## An update is not found

1. Confirm that HH Apply Assistant is enabled in the Tampermonkey Dashboard.
2. Allow Tampermonkey Site access to `raw.githubusercontent.com`.
3. Use Tampermonkey's update check, or reopen the [install link](https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js).

## Ask for help

Before reporting a bug:

1. Reproduce it on the affected page.
2. Open **Diagnostics** and select **Check page**.
3. Select **Download log** if the log is relevant.
4. Remove personal data, cookies, tokens, full private URLs, and sensitive page text from everything you share.
5. Note the HH Apply Assistant, Chrome, and Tampermonkey versions, page type, work mode, steps, expected result, and actual result.

Use the [English bug report form](https://github.com/tgeruzov/hh-apply-assistant/issues/new?template=bug_report_en.yml) or open the [issue chooser](https://github.com/tgeruzov/hh-apply-assistant/issues/new/choose). Report vulnerabilities through the [Security Policy](../SECURITY.en.md), not a public bug report.
