# The ESLint scanner image. Build once, from this directory:
#
#   docker build -t prism-eslint:9.17.0 services/runner/eslint
#
# The runner starts it without network access and with the repository mounted read-only,
# so everything ESLint needs is installed here at build time.
FROM node:22-alpine

WORKDIR /prism
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY eslint.config.mjs run.mjs ./

USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "/prism/run.mjs"]
