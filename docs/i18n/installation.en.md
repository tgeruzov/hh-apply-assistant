# Installation and updates

The supported setup is desktop Google Chrome with a current Tampermonkey release. Other userscript managers and mobile browsers are not part of the current test setup.

## 1. Install Tampermonkey

Install the extension from the [official Tampermonkey website](https://www.tampermonkey.net/) and make sure it is enabled in Chrome.

In Chrome 138 or newer:

1. Open `chrome://extensions`.
2. Find Tampermonkey and select **Details**.
3. Turn on **Allow User Scripts**.

Current Chrome versions do not require the global **Developer mode** setting solely for Tampermonkey. Older Chrome and Chromium versions may use **Developer mode** instead; see the [Chrome User Scripts API documentation](https://developer.chrome.com/docs/extensions/reference/api/userScripts#enable-usage-of-the-userscripts-api) and [Tampermonkey FAQ Q209](https://www.tampermonkey.net/faq.php?locale=en&q=Q209).

## 2. Check Site access

Open Tampermonkey's **Details** page in Chrome. **On all sites** is the simplest setting. If you prefer **On specific sites**, allow hh.ru and `raw.githubusercontent.com`; otherwise the assistant or its update checks may not work.

## 3. Install HH Apply Assistant

Open the canonical Raw link:

**[Install HH Apply Assistant](https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js)**

Tampermonkey should open an installation page for **HH Apply Assistant**. Review it and select **Install**.

If Chrome shows the source code instead, do not copy fragments from the page. Check that Tampermonkey and **Allow User Scripts** are enabled, then reopen the link. See [Troubleshooting](troubleshooting.en.md#the-raw-link-shows-source-code) if it still does not open in Tampermonkey.

## 4. Verify the installation

1. Open the Tampermonkey Dashboard and confirm that **HH Apply Assistant** is listed and enabled.
2. Sign in to hh.ru.
3. Open [vacancy search](https://hh.ru/search/vacancy) and reload the page.
4. Confirm that the **HH Apply Assistant** panel appears on the right. In a narrow window, open it from the vertical tab at the edge of the page.
5. Open **Diagnostics** and select **Check page**.

The panel is expected on vacancy search pages, individual vacancy pages, and hh.ru application or questionnaire pages. It is not expected on the hh.ru home page or unrelated sections.

## Manual installation

Use this only if the Raw link is not handled by Tampermonkey:

1. Open the Tampermonkey Dashboard and create a new script.
2. Copy the complete contents of [hh-apply-assistant.user.js](../../hh-apply-assistant.user.js) into the editor, replacing its template.
3. Save the script and make sure its Dashboard toggle is enabled.
4. Reload a supported hh.ru page.

Keep only one enabled copy of HH Apply Assistant to avoid duplicate panels or confusing update behavior.

## Updates and removal

Tampermonkey can check for updates from the canonical Raw link. You can also use its Dashboard update check or reopen the install link. If no update is found, verify Site access for `raw.githubusercontent.com`.

Remove the assistant from the Tampermonkey Dashboard. Uninstalling it does not necessarily remove data already stored on hh.ru; see [Data and privacy](PRIVACY.en.md#deleting-local-data).
