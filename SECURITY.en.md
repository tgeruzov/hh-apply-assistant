# Security Policy

## Supported versions

Security fixes target the latest GitHub Release and the current state of `main`. Older releases are not maintained on separate security branches.

## Report a vulnerability

Use **Security → Report a vulnerability** in the canonical GitHub repository. GitHub Private Vulnerability Reporting is the project's primary confidential reporting channel.

If that button is not available, this project currently has no private fallback channel configured. Do not publish vulnerability details, proof-of-concept code, cookies, tokens, cover letters, personal data, or diagnostic exports in a public issue. No private email or external security form is currently offered.

A useful report includes:

- the affected HH Apply Assistant version or commit;
- the browser and Tampermonkey version;
- the impact and conditions required;
- minimal reproduction steps;
- a safe proof of concept, when necessary.

No fixed response deadline is promised.

## Security issue or ordinary bug?

Security issues include unexpected execution outside supported hh.ru pages, expanded browser permissions, disclosure of locally stored or exported data, unsafe handling of page content or links, uncontrolled applications, and compromise of the install or update source.

A broken selector, an unconfirmed application, or a UI regression without security impact belongs in the [English bug report form](https://github.com/tgeruzov/hh-auto-responder/issues/new?template=bug_report_en.yml).

See [Data and privacy](PRIVACY.en.md) for the data stored by the assistant and the contents of exported files.
