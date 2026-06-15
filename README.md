# Jarvis

A deterministic WhatsApp bot, built **core-first**: a small, strong runtime exposes
capabilities ("directives") and commands are thin consumers of them.

Being rebuilt from scratch with a clean history. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the branch / commit / PR flow.

## Stack

- Node.js 24+ (ESM)
- WhatsApp via Baileys (planned)
- Storage via the built-in `node:sqlite` (planned)

## Status

Early. The core and a first set of commands are under construction.

## Develop

```bash
npm test    # node:test suite
```
