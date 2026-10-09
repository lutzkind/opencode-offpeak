# Contributing

Contributions are welcome. Keep the implementation focused on one OpenCode v2 plugin and preserve these invariants:

- Peak-price requests fail closed unless a visible, unexpired task override was explicitly requested.
- OFF pauses queue automation and never creates an override.
- Queued work resumes in its stored OpenCode session; it does not silently start over.
- Ambiguous provider outcomes after a crash are not replayed automatically.
- Pricing windows have one canonical policy definition and use its IANA timezone.
- No prompt, code, queue, or usage telemetry is added.

Before opening a pull request:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

Include tests for state transitions, guard behavior, or policy changes. If changing a built-in policy, cite the authoritative current provider page, record the verification date, and update the policy tests and changelog.

Keep OpenCode compatibility narrow and evidence-based. The current supported range is documented in `README.md`; update it only after typechecking against the target API and verifying the package through OpenCode's plugin loader.
