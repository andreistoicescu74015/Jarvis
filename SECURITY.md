# Security policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/andreistoicescu74015/Jarvis/security/advisories/new)
(repository Security tab -> Report a vulnerability). Do not open a public issue for
security problems.

The report will be acknowledged and, once a fix is ready, disclosure is coordinated.

## Supported versions

Early development: only the latest `main` is supported.

## Notes

Jarvis is an unofficial WhatsApp client (Baileys). It stores data locally and sends
nothing to the cloud. Never commit real secrets or session data (`.env` and `data/`
are gitignored).
