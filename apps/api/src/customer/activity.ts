import { CustomerActivityV1, FinancialPlanStepV1, type CustomerActivityItemV1 } from "@parlance/contracts";
import type { PrismaClient } from "@parlance/db";

export interface CustomerActivityReadService {
  list(userId: string): Promise<CustomerActivityV1>;
}

type SettledStep = {
  occurredAt: Date;
  step: unknown;
};

const accountLabel = (sourceAccountId: string, currency: string): string => sourceAccountId === "acc-sgd" ? "SGD Account" : sourceAccountId === "acc-usd" ? "USD Account" : `${currency} Account`;

export function presentCustomerActivity(input: SettledStep, beneficiaries: ReadonlyMap<string, string>, assets: ReadonlyMap<string, string>): CustomerActivityItemV1 | undefined {
  const parsed = FinancialPlanStepV1.safeParse(input.step);
  if (!parsed.success) return undefined;
  const step = parsed.data;
  if (step.action === "TRANSFER") {
    return {
      occurredAt: input.occurredAt.toISOString(),
      description: `Transfer to ${beneficiaries.get(step.parameters.beneficiaryId) ?? "beneficiary"}`,
      accountLabel: accountLabel(step.parameters.sourceAccountId, step.parameters.amount.currency),
      amount: step.parameters.amount,
      direction: "DEBIT",
      status: "COMPLETED",
    };
  }
  if (step.action === "BUY_ASSET") {
    return {
      occurredAt: input.occurredAt.toISOString(),
      description: `Buy ${step.parameters.quantity} ${assets.get(step.parameters.assetId) ?? "investment"}`,
      accountLabel: accountLabel(step.parameters.sourceAccountId, step.parameters.settlementCurrency),
      amount: { currency: step.parameters.settlementCurrency, minorUnits: step.parameters.authorizedTotalMinor },
      direction: "DEBIT",
      status: "COMPLETED",
    };
  }
  return undefined;
}

export class PrismaCustomerActivityReadService implements CustomerActivityReadService {
  constructor(private readonly db: PrismaClient) {}

  async list(userId: string): Promise<CustomerActivityV1> {
    const runs = await this.db.executionRun.findMany({
      where: { userId, status: "COMPLETED" },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { steps: { where: { status: "SETTLED" }, select: { updatedAt: true, planStep: true } } },
    });
    const settled = runs.flatMap((run) => run.steps.map(({ updatedAt, planStep }) => ({
      occurredAt: updatedAt,
      step: { id: planStep.stepKey, sequence: planStep.sequence, action: planStep.action, dependsOn: planStep.dependsOn, reversible: planStep.reversible, parameters: planStep.parameters },
    })));
    const beneficiaryIds = settled.flatMap(({ step }) => {
      const parsed = FinancialPlanStepV1.safeParse(step); return parsed.success && parsed.data.action === "TRANSFER" ? [parsed.data.parameters.beneficiaryId] : [];
    });
    const assetIds = settled.flatMap(({ step }) => {
      const parsed = FinancialPlanStepV1.safeParse(step); return parsed.success && parsed.data.action === "BUY_ASSET" ? [parsed.data.parameters.assetId] : [];
    });
    const [beneficiaries, assets] = await Promise.all([
      this.db.beneficiary.findMany({ where: { userId, OR: [{ id: { in: beneficiaryIds } }, { providerRef: { in: beneficiaryIds } }] }, select: { id: true, providerRef: true, name: true } }),
      this.db.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, symbol: true } }),
    ]);
    const beneficiaryNames = new Map(beneficiaries.flatMap((item) => [[item.id, item.name], ...(item.providerRef ? [[item.providerRef, item.name] as const] : [])]));
    const assetSymbols = new Map(assets.map((item) => [item.id, item.symbol]));
    const items = settled
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .flatMap((item) => presentCustomerActivity(item, beneficiaryNames, assetSymbols) ?? [])
      .slice(0, 10);
    return CustomerActivityV1.parse({ items });
  }
}
