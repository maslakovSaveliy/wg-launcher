## What and why

<!-- One or two sentences. Link the issue or the plan task. -->

## Definition of Done

- [ ] Verification was actually run and its output is pasted below (tests, checks, manual steps). No "should work".
- [ ] Behavior changes have tests written first. If there is no code behavior change, say so.
- [ ] Docs are updated (`docs/`, README, and `MEMORY.md` when a verified fact, decision or gotcha changed).
- [ ] Documentation claims are tagged `Verified (YYYY-MM-DD, source)`, `Assumed` or `Unverified`. No unsupported OS is
      marked verified.
- [ ] No secrets, tokens, personal data or machine-specific paths in the diff.
- [ ] Security invariants in [AGENTS.md](../AGENTS.md) are respected: game content is untrusted, no preload or IPC in
      game windows, IPC sender and arguments validated, permissions and navigation limited.
- [ ] Data-safety invariants in [AGENTS.md](../AGENTS.md) are respected: no live Chromium profile copies, backup before
      import, failures never destroy existing saves, archives checked.
- [ ] New dependencies follow the dependency and license policy (name the license and why it is needed).
- [ ] Commit messages follow Conventional Commits.
- [ ] I agree to the [Contributor License Agreement](../CLA.md) (outside contributors).

## Verification output

```text
<!-- Paste the command(s) and their real output. -->
```
