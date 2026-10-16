import type { ClarificationItem, EntityGrounder } from "@parlance/intent-engine";

/** Fallback choices are loaded on the server from the customer's eligible records. */
export async function withEligiblePayees(items: readonly ClarificationItem[], grounder: EntityGrounder): Promise<ClarificationItem[]> {
  if (!items.some((item) => item.field.includes("recipientReference") && item.options.length === 0) || !grounder.eligibleBeneficiaries) return [...items];
  const payees = await grounder.eligibleBeneficiaries();
  return items.map((item) => item.field.includes("recipientReference") && item.options.length === 0
    ? { ...item, options: payees.map((payee) => ({ entityType: payee.entityType, entityId: payee.entityId, displayName: payee.canonicalName })) }
    : item);
}
