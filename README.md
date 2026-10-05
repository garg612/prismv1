# PRism

PRism reviews GitHub pull requests. For each pull request it runs code scanners (Semgrep and
ESLint), uses a model per scanner to separate real issues from noise, generates a fix for every
issue it shows, checks each fix by scanning again, and lets the repository owner apply the fixes
as one fix pull request. After the fix is merged it re-checks the pull request.

## How a review runs

1. GitHub sends a webhook when a pull request is opened or updated (`src/app/api/webhooks/github`).
2. The review pipeline starts (`src/inngest/functions/review-run.ts`).
3. The runner service scans the changed code with every enabled scanner (`services/runner`).
4. Each scanner's model scores its findings; findings are shown or filtered out as noise (`src/modules/triage`).
5. A fix is generated and validated for every shown finding (`src/inngest/functions/process-finding.ts`, `src/modules/fix`).
6. An AI review adds optional suggestions about logic (`src/modules/logic-review`).
7. A report is posted on the pull request, and the review appears under `/dashboard/reviews`.
8. The owner applies or rejects fixes; applied fixes go to one fix pull request (`src/modules/github/lib/apply-fix.ts`).

## Folder structure

```
src/
  app/                  Routes only: pages and API endpoints
    api/                Webhooks, runner callback, feedback, auth, Inngest endpoint
    dashboard/          Dashboard pages (repositories, reviews, insights, settings, subscription)
  inngest/              Background pipeline
    client.ts
    functions/          review-run (the review), process-finding (one fix), generate-report, indexing
  modules/              Feature code, one folder per feature
    scanners/           Scanner registry, plus one folder per scanner (semgrep/, eslint/)
    triage/             Scoring findings with each scanner's model; show or filter out
    fix/                Fix generation, guards, which findings get a fix
    validation/         Deciding whether a fix passed its re-scan and tests
    logic-review/       Optional AI suggestions
    review/             Review pages: data loading (lib/), server actions (actions/), UI (components/)
    metrics/            Insights numbers and charts
    github/             GitHub API calls, applying fixes, webhook verification
    runner/             Client for the runner service
    ai/                 Repository indexing and retrieval
    auth/ dashboard/ repository/ settings/ payment/ retention/
  components/           Shared UI (ui/ holds the design-system components)
  lib/                  Shared infrastructure: database, auth, AI models, rate limits, feature flags
services/
  runner/               Separate service that downloads the code and runs scanners in Docker
    src/                Server, scanners, fix validation
    eslint/             The ESLint Docker image and PRism's own ESLint config
    tests/              Runner tests (Jest)
prisma/                 Database schema, migrations, demo seed
rules/semgrep/          The Semgrep rules PRism runs
tests/                  App tests (Vitest), grouped by area
  scanners/ triage/ fixes/ pipeline/ review/ rag/ security/
  live/                 Tests that need real services
scripts/                Maintenance scripts
  e2e/full-pipeline.ts  End-to-end test against a real pull request
docs/                   Notes and past audit reports
```

Inside a module: `lib/` is logic, `actions/` is server actions, `components/` is UI.

## Running it

Three processes run side by side:

```bash
npm run dev                                   # the app, http://localhost:3000
npx inngest-cli@latest dev                    # the pipeline (Inngest dev server)
cd services/runner && npx tsx --env-file=../../.env src/index.ts   # the runner, port 4000 (needs Docker)
```

Settings live in `.env`. `PRISM_SCANNERS` lists the scanners that run (for example `SEMGREP,ESLINT`).
`FIX_MAX_PER_RUN` limits how many findings get a fix in one review (default 25).

For a demo with seeded data and no external services, see [DEMO.md](DEMO.md).

## Checks

```bash
npm run typecheck                 # app and runner
npm run lint
npm test                          # app tests
cd services/runner && npm test    # runner tests
npm run test:e2e -- <puppeteer-core dir> <screenshot dir>   # full pipeline on a real pull request
```
