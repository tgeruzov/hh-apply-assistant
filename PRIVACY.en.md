# Data and privacy

HH Apply Assistant is a local userscript, not a separate web service. This page describes the behavior represented by the current source.

## Data stored in the browser

The assistant stores the following data under the hh.ru site:

- settings, interface language, and cover-letter text;
- manual-queue entries, including vacancy IDs, links, titles, and timestamps;
- diagnostic logs, metrics, and small diagnostic page snapshots;
- panel state and coordination between hh.ru tabs;
- per-tab processed-vacancy history, counters, run state, and return page.

Because the assistant runs in the hh.ru page context, hh.ru page code and other scripts in the same context may technically access data stored for that site. Do not use the cover-letter field or diagnostics as a place to keep secrets.

## Network behavior

The userscript does not send its stored data to a project server, and the project does not operate a separate data service. Applying for a vacancy uses hh.ru pages and forms.

Tampermonkey separately contacts `raw.githubusercontent.com` to install the script and check for updates. That request is made by the userscript manager.

## Exported files

A diagnostic report is created locally. It can include the current URL and query parameters, browser information, run state, settings with the cover-letter text replaced by its length, logs, metrics, and limited page fragments. Form-field values are not intentionally copied into snapshots, but labels, placeholders, button text, and other visible page text may appear.

Read and redact every diagnostic report before sharing it. Remove private URLs, personal data, cookies, tokens, and sensitive page text.

A Manual queue export is a local HTML file containing the saved vacancy IDs, links, return links, titles, and timestamps.

## Deleting local data

- **Reset history** removes the processed-vacancy history, successful-application counter, and run statistics for the current tab.
- **Manual queue → Clear** removes saved queue entries.
- **Diagnostics → More → Clear saved log & metrics** removes the saved log and metrics. The assistant may then add a new service entry recording that the clear action completed, so Diagnostics may not remain completely empty. That entry uses the usual log fields, including the current path, tab ID, and interface language.
- Clearing site data for hh.ru removes all assistant data, but it may also sign you out of hh.ru.

Removing HH Apply Assistant from Tampermonkey does not guarantee that data already stored under hh.ru is deleted.
