import type { BankStateSnapshotV1, GoalContractV1 } from "@parlance/contracts";
import { accountLabel, formatMinorUnits } from "../../lib/banking-state";
import { presentGoal } from "../../lib/customer-presentation";
import { Icon } from "../ui/icon";

type RefusalDetails = Readonly<Record<string, unknown>> | undefined;

type ProtectedBalanceFigures = {
  accountName: string;
  current?: string;
  minimum: string;
  projected: string;
  shortfall: string;
  condition: string;
};

function minorUnits(value: unknown): bigint | undefined {
  return typeof value === "string" && /^\d+$/u.test(value) ? BigInt(value) : undefined;
}

export function protectedBalanceFigures(goal: GoalContractV1, details: RefusalDetails, state?: BankStateSnapshotV1): ProtectedBalanceFigures | undefined {
  const accountId = details?.accountId;
  const currency = details?.currency;
  const bankStateVersion = details?.bankStateVersion;
  const required = minorUnits(details?.requiredMinorUnits);
  const projected = minorUnits(details?.projectedMinorUnits);
  if (typeof accountId !== "string" || typeof currency !== "string" || required === undefined || projected === undefined || projected >= required) return undefined;

  const constraintIndex = goal.constraints.findIndex((constraint) => constraint.type === "MIN_AVAILABLE_BALANCE"
    && constraint.accountId === accountId
    && constraint.money.currency === currency
    && minorUnits(constraint.money.minorUnits) === required);
  if (constraintIndex < 0) return undefined;

  const account = typeof bankStateVersion === "number" && state?.stateVersion === bankStateVersion
    ? state.accounts.find((candidate) => candidate.id === accountId && candidate.currency === currency)
    : undefined;
  return {
    accountName: account ? accountLabel(account) : "Protected account",
    ...(account ? { current: formatMinorUnits(currency, account.availableMinorUnits) } : {}),
    minimum: formatMinorUnits(currency, required),
    projected: formatMinorUnits(currency, projected),
    shortfall: formatMinorUnits(currency, required - projected),
    condition: presentGoal(goal).constraints[constraintIndex]!,
  };
}

export function ProtectedBalanceRefusalCard({ goal, details, state, onAmend, onStartOver }: {
  goal: GoalContractV1;
  details: RefusalDetails;
  state?: BankStateSnapshotV1;
  onAmend(): void;
  onStartOver(): void;
}) {
  const figures = protectedBalanceFigures(goal, details, state);
  if (!figures) return null;

  return <section className="product-card protected-balance-card" aria-live="polite">
    <div className="protected-balance-heading">
      <span><Icon name="shield" /></span>
      <div><p>Request stopped safely</p><h2>Your protected balance comes first.</h2></div>
    </div>
    <p className="protected-balance-lead">This investment would leave your {figures.accountName} below the minimum you asked us to protect.</p>
    <div className="protected-condition"><Icon name="check" /><div><small>Your instruction</small><strong>{figures.condition}</strong></div></div>
    <dl className="protected-balance-comparison">
      {figures.current && <div><dt>Available now</dt><dd>{figures.current}</dd><small>Live account balance</small></div>}
      <div className="is-projected"><dt>Projected after this request</dt><dd>{figures.projected}</dd><small>{figures.shortfall} below your minimum</small></div>
      <div className="is-protected"><dt>Protected minimum</dt><dd>{figures.minimum}</dd><small>Your confirmed condition</small></div>
    </dl>
    <div className="protected-balance-note"><Icon name="shield" /><p><strong>No transaction occurred.</strong> No plan was created, and nothing was submitted for approval or execution.</p></div>
    <div className="card-actions"><button className="button secondary" type="button" onClick={onStartOver}>Start over</button><button className="button bank-primary" type="button" onClick={onAmend}>Amend request</button></div>
  </section>;
}
