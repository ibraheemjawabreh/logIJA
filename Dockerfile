# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — Builder
# Installs all dependencies and compiles TypeScript to JavaScript.
###############################################################################
FROM node:24-alpine AS builder
WORKDIR /app

# Install all dependencies (dev + prod) needed to compile TypeScript
COPY package*.json ./
RUN npm ci

# Copy only what tsc needs; tests and tooling configs are excluded via .dockerignore
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npm run build

###############################################################################
# Stage 2 — Production runner
# Minimal image: no dev tools, no source files, no TypeScript.
###############################################################################
FROM node:24-alpine AS runner
WORKDIR /app

# Create a non-root user before installing packages
RUN addgroup --system appgroup \
 && adduser  --system --ingroup appgroup appuser

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled application from the builder stage
COPY --from=builder /app/dist ./dist

# Copy SQL migrations — runMigrations() reads these at runtime during startup.
# The path is resolved relative to dist/database/migrate.js via import.meta.url,
# so migrations/ must be present at /app/migrations inside the container.
COPY migrations ./migrations

# Transfer ownership so the non-root user can read all files
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 8080

CMD ["node", "dist/server.js"]
