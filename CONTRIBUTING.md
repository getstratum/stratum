# Contributing to Stratum

Thank you for your interest in contributing! This document covers how to get started.

## Ways to contribute

- **Bug reports** — open an issue using the bug report template
- **Feature requests** — open an issue using the feature request template
- **Pull requests** — code contributions are welcome
- **Documentation** — improvements to docs, examples, and guides
- **Community** — answer questions in Discussions

## Getting started

```bash
git clone https://github.com/getstratum/stratum.git
cd stratum
cp .env.example .env
# Add your API keys to .env
docker compose up -d --build
docker exec -it $(docker compose ps -q proxy) node /app/src/migrate.js
docker exec -it $(docker compose ps -q proxy) node /app/src/seed-passwords.js
```

Dashboard: http://localhost:3000 — login with `dev@acme.com` / `dev123`

## Making a pull request

1. Fork the repository
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Test locally with `docker compose up --build`
5. Open a pull request against `main`

## Project structure

```
proxy/      Node.js + Fastify gateway (API proxy, auth, policy enforcement)
dashboard/  Next.js admin UI + Playground
db/         SQL migrations (idempotent — safe to re-run)
docs/       Documentation (EN + ES)
scripts/    Utility scripts
```

## Code style

- JavaScript / JSX — no TypeScript (intentional, for simplicity)
- No linter enforced — follow the style of the surrounding code
- Comments in English

## Reporting a security vulnerability

Do **not** open a public issue for security vulnerabilities. Send a private report via GitHub's security advisory feature or email the maintainers directly.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
