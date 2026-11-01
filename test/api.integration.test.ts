import "reflect-metadata";
import { beforeAll, afterAll, test, expect } from "vitest";
import { NestFactory } from "@nestjs/core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
const require = createRequire(import.meta.url);
const { AppModule } = require("../dist/app");
const { configure } = require("../dist/platform");
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  owner = randomUUID(),
  member = randomUUID();
function token(sub = owner, tenantId = tenant, role = "admin") {
  return jwt.sign({ sub, tenantId, role }, process.env.JWT_SECRET!, {
    issuer: "portfolio-auth",
    audience: "portfolio-api",
    expiresIn: 300,
  });
}
let app: Awaited<ReturnType<typeof NestFactory.create>>;
let api: ReturnType<typeof request>;
beforeAll(async () => {
  process.env.JWT_SECRET = "integration-only-signing-key-".repeat(3);
  process.env.PLATFORM_ADMIN_SUB = owner;
  app = await NestFactory.create(AppModule, { logger: false });
  configure(app);
  await app.listen(0, "127.0.0.1");
  api = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});
test("versioned employee APIs enforce roles and tenant isolation with durable announcements", async () => {
  const auth = { Authorization: `Bearer ${token()}` };
  const created = await api
    .post("/v1/employees")
    .set(auth)
    .send({
      userId: member,
      name: "Employee",
      email: `${randomUUID()}@example.test`,
    })
    .expect(201);
  expect(Array.isArray((await api.get("/v1/employees").set(auth)).body)).toBe(
    true,
  );
  expect((await api.get("/v2/employees").set(auth)).body.total).toBe(1);
  await api
    .patch(`/v1/employees/${created.body.id}`)
    .set("Authorization", `Bearer ${token(randomUUID(), otherTenant)}`)
    .send({ name: "Attack" })
    .expect(404);
  const staff = { Authorization: `Bearer ${token(member, tenant, "member")}` };
  await api.get("/v2/employees").set(staff).expect(403);
  expect((await api.get("/v1/me").set(staff)).body.name).toBe("Employee");
  await api
    .post("/v1/announcements")
    .set(auth)
    .send({ title: "Team news", body: "Updated handbook" })
    .expect(201);
  const { Delivery } = require("../dist/app");
  await app.get(Delivery).run();
  expect((await api.get("/v1/notifications").set(staff)).body[0].status).toBe(
    "delivered",
  );
});
