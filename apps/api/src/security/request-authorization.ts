import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ApiServices } from "../app.js";
import type { BundlePlanRepository } from "../orchestration/ports.js";

const PRINCIPAL_HEADER = "x-parlance-customer-id";
const INTERNAL_TOKEN_HEADER = "x-parlance-internal-token";
const OPS_TOKEN_HEADER = "x-parlance-ops-token";
const PrincipalId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type CustomerPrincipal = Readonly<{ userId: string }>;
export type ApiAuthorizationConfig = Readonly<{ internalApiToken?: string; opsApiToken?: string; bankApiToken?: string }>;

declare module "fastify" {
  interface FastifyRequest {
    customerPrincipal?: CustomerPrincipal;
  }
}

export function apiAuthorizationFromEnvironment(): ApiAuthorizationConfig {
  const internalApiToken = configured(process.env.PARLANCE_INTERNAL_API_TOKEN);
  const opsApiToken = configured(process.env.PARLANCE_OPS_API_TOKEN);
  const bankApiToken = configured(process.env.PARLANCE_BANK_API_TOKEN);
  return {
    ...(internalApiToken ? { internalApiToken } : {}),
    ...(opsApiToken ? { opsApiToken } : {}),
    ...(bankApiToken ? { bankApiToken } : {}),
  };
}

export function authenticateCustomer(request: FastifyRequest, config: ApiAuthorizationConfig): CustomerPrincipal | undefined {
  const expected = configured(config.internalApiToken);
  const supplied = singleHeader(request.headers[INTERNAL_TOKEN_HEADER]);
  const userId = singleHeader(request.headers[PRINCIPAL_HEADER]);
  if (!expected || !supplied || !safeEqual(supplied, expected) || !userId || !PrincipalId.test(userId)) return undefined;
  return { userId };
}

export function authenticateOperator(request: FastifyRequest, config: ApiAuthorizationConfig): boolean {
  const expected = configured(config.opsApiToken);
  const supplied = singleHeader(request.headers[OPS_TOKEN_HEADER]);
  return expected !== undefined && supplied !== undefined && safeEqual(supplied, expected);
}

export function customerAuthorizationConfigured(config: ApiAuthorizationConfig): boolean {
  return configured(config.internalApiToken) !== undefined && apiSecurityConfigurationValid(config);
}

export function operatorAuthorizationConfigured(config: ApiAuthorizationConfig): boolean {
  return configured(config.opsApiToken) !== undefined && apiSecurityConfigurationValid(config);
}

export function apiSecurityConfigurationReady(config: ApiAuthorizationConfig): boolean {
  return configured(config.internalApiToken) !== undefined && configured(config.opsApiToken) !== undefined
    && configured(config.bankApiToken) !== undefined && apiSecurityConfigurationValid(config);
}

function apiSecurityConfigurationValid(config: ApiAuthorizationConfig): boolean {
  const values = [config.internalApiToken, config.opsApiToken, config.bankApiToken].map(configured).filter((value): value is string => value !== undefined);
  return values.every((value, index) => values.slice(index + 1).every((other) => !safeEqual(value, other)));
}

function configured(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export class CustomerOwnership {
  constructor(private readonly services: ApiServices) {}

  async clarification(id: string, principal: CustomerPrincipal): Promise<void> {
    this.requireOwner((await this.services.repository.getClarification(id))?.userId, principal);
  }

  async bundleClarification(id: string, principal: CustomerPrincipal): Promise<void> {
    this.requireOwner((await this.services.repository.getBundleClarification(id))?.userId, principal);
  }

  async goalCandidate(id: string, principal: CustomerPrincipal): Promise<void> {
    this.requireOwner((await this.services.repository.getGoalCandidate(id))?.userId, principal);
  }

  async bundleCandidate(id: string, principal: CustomerPrincipal): Promise<void> {
    this.requireOwner((await this.services.repository.getBundleCandidate(id))?.userId, principal);
  }

  async goal(id: string, principal: CustomerPrincipal): Promise<void> {
    const stored = await this.services.repository.getConfirmedGoal(id);
    if (!stored || stored.contract.id !== id) return this.notFound();
    this.requireOwner(stored.contract.userId, principal);
  }

  async bundle(id: string, principal: CustomerPrincipal): Promise<void> {
    const repository = this.services.repository as ApiServices["repository"] & Partial<BundlePlanRepository>;
    const stored = await repository.getConfirmedGoalBundle?.(id);
    if (!stored || stored.contract.bundleId !== id) return this.notFound();
    this.requireOwner(stored.userId, principal);
  }

  async plan(id: string, principal: CustomerPrincipal): Promise<void> {
    const plan = await this.services.repository.getPlan(id);
    if (!plan) return this.notFound();
    if (plan.ownerType === "BUNDLE") return this.bundle(plan.plan.goalContractId, principal);
    return this.goal(plan.plan.goalContractId, principal);
  }

  async registrationChallenge(id: string, principal: CustomerPrincipal): Promise<void> {
    this.requireOwner((await this.services.repository.getWebAuthnChallenge(id))?.userId, principal);
  }

  async execution(id: string, principal: CustomerPrincipal): Promise<void> {
    const execution = await this.services.repository.getExecution(id);
    if (!execution) return this.notFound();
    const storedApproval = await this.services.repository.getApproval(execution.approvalId);
    if (!storedApproval || storedApproval.approval.financialPlanId !== execution.result.planId) return this.notFound();
    this.requireOwner(storedApproval.approval.userId, principal);
    await this.plan(storedApproval.approval.financialPlanId, principal);
  }

  private requireOwner(ownerId: string | undefined, principal: CustomerPrincipal): void {
    if (!ownerId || ownerId !== principal.userId) this.notFound();
  }

  private notFound(): never {
    throw new Error("CUSTOMER_RESOURCE_NOT_FOUND");
  }
}
