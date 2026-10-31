import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { Database } from "../../client";
import {
  apiKeys,
  customers,
  customerTags,
  documents,
  documentTags,
  invoices,
  invoiceTemplates,
  tags,
  teams,
  trackerEntries,
  trackerProjects,
  transactions,
  users,
  usersOnTeam,
} from "../../schema";

function tenantIds() {
  return {
    teamId: randomUUID(),
    userId: randomUUID(),
    customerId: randomUUID(),
    tagId: randomUUID(),
    templateId: randomUUID(),
    invoiceId: randomUUID(),
    projectId: randomUUID(),
    entryId: randomUUID(),
    transactionId: randomUUID(),
    documentId: randomUUID(),
    documentTagId: randomUUID(),
    apiKeyId: randomUUID(),
  };
}

export type TenantFixtureIds = ReturnType<typeof tenantIds>;
export type TenantIsolationFixture = {
  own: TenantFixtureIds;
  other: TenantFixtureIds;
};

/** Only pass the database returned by the guarded local test harness. */
export async function createTenantIsolationFixture(
  db: Database,
): Promise<TenantIsolationFixture> {
  const fixture = { own: tenantIds(), other: tenantIds() };
  const tenants = [fixture.own, fixture.other];

  await db.transaction(async (tx) => {
    await tx.insert(teams).values(
      tenants.map((tenant) => ({
        id: tenant.teamId,
        name: `Tenant ${tenant.teamId}`,
        inboxId: tenant.teamId,
        baseCurrency: "USD",
      })),
    );
    await tx.insert(users).values(
      tenants.map((tenant) => ({
        id: tenant.userId,
        teamId: tenant.teamId,
        fullName: "Fixture user",
        email: `${tenant.userId}@example.test`,
      })),
    );
    await tx.insert(usersOnTeam).values(
      tenants.map((tenant) => ({
        teamId: tenant.teamId,
        userId: tenant.userId,
        role: "owner" as const,
      })),
    );
    await tx.insert(tags).values(
      tenants.map((tenant) => ({
        id: tenant.tagId,
        teamId: tenant.teamId,
        name: "Fixture tag",
      })),
    );
    await tx.insert(customers).values(
      tenants.map((tenant) => ({
        id: tenant.customerId,
        teamId: tenant.teamId,
        name: "Original customer",
        email: `${tenant.customerId}@example.test`,
        token: "original-customer-token",
      })),
    );
    await tx.insert(customerTags).values(
      tenants.map((tenant) => ({
        customerId: tenant.customerId,
        teamId: tenant.teamId,
        tagId: tenant.tagId,
      })),
    );
    await tx.insert(invoiceTemplates).values(
      tenants.map((tenant) => ({
        id: tenant.templateId,
        teamId: tenant.teamId,
        name: "Fixture template",
        currency: "USD",
      })),
    );
    await tx.insert(invoices).values(
      tenants.map((tenant) => ({
        id: tenant.invoiceId,
        teamId: tenant.teamId,
        userId: tenant.userId,
        customerId: tenant.customerId,
        templateId: tenant.templateId,
        invoiceNumber: "FIXTURE-001",
        amount: 100,
        currency: "USD",
        token: "original-invoice-token",
        status: "draft" as const,
      })),
    );
    await tx.insert(trackerProjects).values(
      tenants.map((tenant) => ({
        id: tenant.projectId,
        teamId: tenant.teamId,
        customerId: tenant.customerId,
        name: "Original project",
        rate: 100,
        currency: "USD",
      })),
    );
    await tx.insert(trackerEntries).values(
      tenants.map((tenant) => ({
        id: tenant.entryId,
        teamId: tenant.teamId,
        projectId: tenant.projectId,
        assignedId: tenant.userId,
        start: "2026-01-01T10:00:00.000Z",
        stop: "2026-01-01T11:00:00.000Z",
        date: "2026-01-01",
        duration: 3600,
      })),
    );
    await tx.insert(transactions).values(
      tenants.map((tenant) => ({
        id: tenant.transactionId,
        teamId: tenant.teamId,
        internalId: tenant.transactionId,
        name: "Fixture transaction",
        date: "2026-01-01",
        method: "payment" as const,
        amount: 100,
        currency: "USD",
        taxRate: 10,
        taxType: "vat",
      })),
    );
    await tx.insert(documents).values(
      tenants.map((tenant) => ({
        id: tenant.documentId,
        teamId: tenant.teamId,
        ownerId: tenant.userId,
        name: "fixture.pdf",
        title: "Fixture document",
        body: "Fixture content",
        pathTokens: [tenant.teamId, "fixture.pdf"],
      })),
    );
    await tx.insert(documentTags).values(
      tenants.map((tenant) => ({
        id: tenant.documentTagId,
        teamId: tenant.teamId,
        name: "Fixture document tag",
        slug: "fixture-document-tag",
      })),
    );
    await tx.insert(apiKeys).values(
      tenants.map((tenant) => ({
        id: tenant.apiKeyId,
        teamId: tenant.teamId,
        userId: tenant.userId,
        name: "Original key",
        keyEncrypted: "fixture-not-a-real-api-key",
        keyHash: tenant.apiKeyId,
        scopes: ["customers.read"],
      })),
    );
  });

  return fixture;
}

export async function removeTenantIsolationFixture(
  db: Database,
  fixture: TenantIsolationFixture,
): Promise<void> {
  // Only these randomly generated fixture tenants and their cascading rows.
  // Never truncate shared tables or use an ambient database connection.
  await db
    .delete(teams)
    .where(inArray(teams.id, [fixture.own.teamId, fixture.other.teamId]));
  await db
    .delete(users)
    .where(inArray(users.id, [fixture.own.userId, fixture.other.userId]));
}
