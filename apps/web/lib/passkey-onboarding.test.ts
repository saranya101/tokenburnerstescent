import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ParlanceApi, RegistrationCredentialJSON, RegistrationOptionsJSON } from "./parlance-api";
import { PasskeyOnboardingController } from "./passkey-onboarding";
import { PasskeyCancelledError, type PasskeyClient } from "./passkey";

const options = { challenge: "challenge", user: { id: "handle", name: "customer", displayName: "Customer" } } as RegistrationOptionsJSON;
const credential: RegistrationCredentialJSON = { id: "credential", rawId: "credential", type: "public-key", response: { clientDataJSON: "client", attestationObject: "attestation", transports: [] }, clientExtensionResults: {} };

function setup(input: { status?: "NOT_ENROLLED" | "READY"; registerError?: Error; verifyError?: Error } = {}) {
  const api = {
    passkeyStatus: vi.fn().mockResolvedValue({ status: input.status ?? "NOT_ENROLLED", userVerification: "required" }),
    registrationOptions: vi.fn().mockResolvedValue({ challengeId: "challenge-1", options }),
    verifyRegistration: input.verifyError ? vi.fn().mockRejectedValue(input.verifyError) : vi.fn().mockResolvedValue({ verified: true }),
  } as unknown as ParlanceApi;
  const passkey = { request: vi.fn(), register: input.registerError ? vi.fn().mockRejectedValue(input.registerError) : vi.fn().mockResolvedValue(credential) } as unknown as PasskeyClient;
  const flow = new PasskeyOnboardingController(api, passkey); return { api, passkey, flow };
}

beforeEach(() => vi.clearAllMocks());

it("loads enrolled status without issuing another registration challenge", async () => {
  const values = setup({ status: "READY" }); await values.flow.load(); expect(values.flow.state.phase).toBe("READY"); expect(values.api.registrationOptions).not.toHaveBeenCalled();
});

it("completes registration using only the server challenge and browser credential", async () => {
  const values = setup(); await values.flow.load(); await values.flow.enroll();
  expect(values.flow.state.phase).toBe("READY"); expect(values.passkey.register).toHaveBeenCalledWith(options); expect(values.api.verifyRegistration).toHaveBeenCalledWith("challenge-1", credential);
});

it.each([
  [new PasskeyCancelledError(), "CANCELLED"],
  [new Error("PASSKEY_NOT_SUPPORTED"), "UNAVAILABLE"],
] as const)("handles browser enrollment failure %s", async (error, phase) => {
  const values = setup({ registerError: error }); await values.flow.load(); await values.flow.enroll(); expect(values.flow.state.phase).toBe(phase); expect(values.api.verifyRegistration).not.toHaveBeenCalled();
});

it.each([
  ["WEBAUTHN_REGISTRATION_CHALLENGE_EXPIRED", "EXPIRED"],
  ["WEBAUTHN_REGISTRATION_VERIFICATION_FAILED", "FAILED"],
] as const)("handles server enrollment failure %s and remains retryable", async (error, phase) => {
  const values = setup({ verifyError: new Error(error) }); await values.flow.load(); await values.flow.enroll(); expect(values.flow.state.phase).toBe(phase);
  values.api.verifyRegistration = vi.fn().mockResolvedValue({ verified: true }); await values.flow.enroll(); expect(values.flow.state.phase).toBe("READY");
});

it("contains no biometric-specific customer claims", () => {
  const source = readFileSync(join(process.cwd(), "components/security/passkey-setup-card.tsx"), "utf8"); expect(source).not.toMatch(/Touch ID|Face ID|fingerprint/iu);
});
