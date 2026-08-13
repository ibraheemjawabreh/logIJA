import type { FastifyInstance } from "fastify";

/**
 * The health route accepts a `checkDb` dependency rather than importing the
 * pool directly. This makes the route testable via Fastify injection without
 * requiring a real database connection in unit tests.
 */
// ibraheem is here too

export interface HealthDeps {
  checkDb: () => Promise<boolean>;
}

export async function healthRoute(app: FastifyInstance, opts: HealthDeps): Promise<void> {
  app.get("/health", async (_request, reply) => {
    let dbOk: boolean;
    try {
      dbOk = await opts.checkDb();
    } catch {
      dbOk = false;
    }

    if (!dbOk) {
      return reply.status(503).send({ status: "unavailable" });
    }
    return reply.status(200).send({ status: "ok" });
  });
}
