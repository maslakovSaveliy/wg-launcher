# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem.

Direct link: <https://github.com/maslakovSaveliy/wg-launcher/security/advisories/new>

**Do not open public issues, pull requests or discussions for security problems.**

A useful report contains:

- what is affected and what an attacker can do;
- steps or a proof of concept to reproduce it;
- the commit or version, and the operating system;
- any suggested fix.

wg-launcher is maintained by an individual. Reports are handled on a best-effort basis; no response time is
guaranteed. Good-faith research is welcome. Please do not access data that is not yours and do not disrupt other
people's systems.

## Supported versions

No version has been released yet. This section will list the supported versions once releases exist.

## Scope

In scope:

- **Launcher client**: main process, IPC handlers and their argument validation, preload bridge, the launcher UI
  and its content security policy, deep-link and shortcut arguments.
- **Snapshot handling**: parsing, validating, exporting and restoring snapshot archives (path traversal, links,
  oversize or decompression bombs, hash and manifest forgery), and any way a restore can destroy existing saves.
- **Game isolation**: anything that lets a loaded game escape its window or session, reach Node.js, the
  filesystem or launcher IPC, read another game's storage, or bypass the permission and navigation policies.

Out of scope:

- Vulnerabilities in third-party games or websites themselves. Their content is untrusted by design; report those
  to their authors.
- Bugs in Electron, Chromium or other upstream projects. Report them upstream; tell us if our configuration makes
  them worse.
- Issues that need an already compromised machine or administrator access.
- A game using up CPU or memory inside its own window without affecting the launcher.

## Disclosure

Fixes are published together with a GitHub security advisory. Credit is given to the reporter unless they ask
otherwise.
