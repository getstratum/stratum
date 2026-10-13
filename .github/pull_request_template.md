## What and why

<!-- What does this change, and what problem does it solve? Link the issue. -->

## Checklist

- [ ] PR title follows Conventional Commits (`feat(gateway): ...`)
- [ ] Commits are signed off (`git commit -s`)
- [ ] Tests cover the change
- [ ] No new dependency or network call on the gateway request path (or an ADR explains it)
- [ ] No prompt or response content in logs or metrics
- [ ] Sync contract changes update `api/sync/` schema, examples and both planes
