# Contributing to calendrome

Thanks for your interest in contributing! calendrome is currently maintained by [@mklute101](https://github.com/mklute101) as a personal project. Outside contributions are welcome via the fork-and-pull-request workflow described below.

## Workflow

1. **Fork** the repository to your own GitHub account.
2. **Clone** your fork locally and create a feature branch:
   ```bash
   git checkout -b feat/short-description
   ```
3. **Make your changes.** Keep PRs focused — one logical change per PR.
4. **Run the test suite** before pushing:
   ```bash
   npm install
   npm test
   ```
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/) — required by repo rules:
   ```
   feat: add weekly summary export
   fix(scheduler): handle DST transitions
   docs: clarify install steps
   ```
   Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
6. **Push** to your fork and open a pull request against `main`.

## What to expect

- All PRs require maintainer review before merge. Direct pushes to `main` are restricted to the repo owner.
- The maintainer will respond when they can — this is a side project, not a 24/7 service.
- Substantial changes are easier to land if you open an issue first to discuss the approach.

## Code style

- TypeScript, formatted by the project's existing config (Prettier / ESLint where applicable).
- No new dependencies without a clear justification in the PR description.
- New behavior should come with tests in `tests/`.

## Reporting bugs

Open an issue with: what you expected, what happened, steps to reproduce, and your environment (OS, Node version). For security vulnerabilities, see [SECURITY.md](SECURITY.md) — please don't open a public issue.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](LICENSE).
