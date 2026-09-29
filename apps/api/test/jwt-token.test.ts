import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { describe, expect, it } from "vitest";

describe("Fastify JWT integration", () => {
  it("signs and verifies an access token with the upgraded provider", async () => {
    const app = Fastify();

    try {
      await app.register(fastifyJwt, {
        secret: "unit-test-secret-with-at-least-32-bytes",
      });
      await app.ready();

      const token = app.jwt.sign(
        { type: "access", tenantId: "tenant-1", sessionId: "session-1" },
        { sub: "user-1", expiresIn: "1m" },
      );
      const claims = app.jwt.verify(token);

      expect(claims).toMatchObject({
        type: "access",
        tenantId: "tenant-1",
        sessionId: "session-1",
        sub: "user-1",
      });
    } finally {
      await app.close();
    }
  });
});
