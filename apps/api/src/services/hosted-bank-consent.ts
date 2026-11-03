import type { HostedConsentActor } from "@midday/db/bank-consent";
import type { DatabaseOrTransaction } from "@midday/db/client";
import {
  acceptHostedBankConsent,
  beginHostedBankConsent,
  claimHostedBankExchange,
  getHostedBankConsent,
  hostedBankConsentView,
  markHostedBankConsentUncertain,
  openHostedBankConsent,
  retainHostedBankAccess,
  retainHostedBankGrant,
  retainHostedBankLink,
} from "@midday/db/queries/hosted-bank-consents";
import {
  createHostedPlaidTransport,
  hostedPlaidConfiguration,
} from "./plaid-hosted-consent";

export async function startHostedBankConsent(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
  input: { requestId: string; country: "US" | "CA" },
) {
  const config = hostedPlaidConfiguration();
  const { row, created } = await beginHostedBankConsent(db, {
    ...scope,
    ...input,
    environment: config.environment,
    clientFingerprint: config.clientFingerprint,
  });
  if (!created) return hostedBankConsentView(row, true);
  try {
    const link = await createHostedPlaidTransport(config).create({
      id: row.id,
      country: input.country,
    });
    await retainHostedBankLink(db, {
      id: row.id,
      claimToken: row.claimToken!,
      ...link,
    });
  } catch (error) {
    await markHostedBankConsentUncertain(db, row.id, row.claimToken!);
    throw error;
  }
  // Recheck current owner/session after provider IO before returning a capability URL.
  return hostedBankConsentView(
    await getHostedBankConsent(db, scope, row.id),
    true,
  );
}

export async function completeHostedBankConsent(
  db: DatabaseOrTransaction,
  scope: HostedConsentActor,
  id: string,
) {
  const provider = createHostedPlaidTransport(hostedPlaidConfiguration());
  let row = await getHostedBankConsent(db, scope, id);
  if (row.status === "awaiting_consent") {
    const evidence = await provider.evidence(openHostedBankConsent(row), row);
    if (!evidence) return hostedBankConsentView(row);
    const claim = await claimHostedBankExchange(db, scope, { id, ...evidence });
    row = claim.row;
    if (claim.claimed) {
      try {
        const receipt = await provider.exchange(evidence.publicToken);
        row = await retainHostedBankAccess(db, {
          id,
          claimToken: row.claimToken!,
          ...receipt,
        });
      } catch (error) {
        await markHostedBankConsentUncertain(db, id, row.claimToken!);
        throw error;
      }
    }
  }
  if (row.status === "grant_received") {
    // Only idempotent reads are retried after an account metadata outage.
    const payload = openHostedBankConsent(row);
    const metadata = await provider.accounts(payload);
    row = await retainHostedBankGrant(db, {
      id,
      claimToken: row.claimToken!,
      accessToken: payload.accessToken!,
      itemId: payload.itemId!,
      ...metadata,
    });
  }
  if (row.status === "verified")
    row = await acceptHostedBankConsent(db, scope, id);
  return hostedBankConsentView(row);
}
