import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaStore } from "../src/store/prismaStore.js";
import { currentTotpCode, encryptSecret, generateTotpSecret, hashRecoveryCode } from "../src/auth/totp.js";
import type { Session } from "../src/domain.js";

const url = process.env.POBOX_TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL security concurrency", () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const other = new PrismaClient({ datasourceUrl: url });
  const first = new PrismaStore(prisma), second = new PrismaStore(other);
  const users: string[] = [];
  let userId: string;
  let session: Session;
  beforeEach(async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", totpEnabled: true, totpSecretEncrypted: encryptSecret(generateTotpSecret()) } });
    userId = user.id; users.push(userId);
    session = await first.createSessionForUser(userId);
    await prisma.recoveryCode.create({ data: { userId, codeHash: hashRecoveryCode("ABCDE-12345") } });
  });
  afterAll(async () => {
    const where = { userId: { in: users } };
    await prisma.$transaction([prisma.session.deleteMany({ where }), prisma.authChallenge.deleteMany({ where }), prisma.recoveryCode.deleteMany({ where }), prisma.user.deleteMany({ where: { id: { in: users } } })]);
    await prisma.$disconnect(); await other.$disconnect();
  });
  it("allows only one use of a recovery code across independent challenges and clients", async () => {
    const a = await prisma.authChallenge.create({ data: { id: randomUUID(), userId, expiresAt: new Date(Date.now() + 60000) } });
    const b = await prisma.authChallenge.create({ data: { id: randomUUID(), userId, expiresAt: new Date(Date.now() + 60000) } });
    const results = await Promise.allSettled([first.verifySecondFactor(a.id, "ABCDE-12345"), second.verifySecondFactor(b.id, "ABCDE-12345")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.session.count({ where: { userId } })).toBe(2);
    expect(await prisma.authChallenge.count({ where: { userId } })).toBe(1);
  });
  it("confirms a pending authenticator once and revokes other sessions", async () => {
    await expect(first.beginTotpSetup(session)).rejects.toThrow();
    const setup = await first.beginTotpSetup(session, "ABCDE-12345");
    const stale = await second.createSessionForUser(userId);
    const results = await Promise.allSettled([first.confirmTotpSetup(session, currentTotpCode(setup.secret)), second.confirmTotpSetup(session, currentTotpCode(setup.secret))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.recoveryCode.count({ where: { userId } })).toBe(10);
    await expect(second.getSession(stale.id)).rejects.toThrow();
    expect((await second.getSession(session.id)).secondFactorVerified).toBe(true);
  });
});
