import type { ParlanceApi } from "./parlance-api";
import { PasskeyCancelledError, type PasskeyClient } from "./passkey";

export type PasskeyOnboardingState =
  | { phase: "LOADING" }
  | { phase: "NOT_ENROLLED" }
  | { phase: "ENROLLING" }
  | { phase: "READY" }
  | { phase: "CANCELLED" }
  | { phase: "EXPIRED" }
  | { phase: "UNAVAILABLE" }
  | { phase: "FAILED" };

type Listener = (state: PasskeyOnboardingState) => void;
const code = (error: unknown): string => error instanceof Error ? error.message : "REGISTRATION_FAILED";

export class PasskeyOnboardingController {
  state: PasskeyOnboardingState = { phase: "LOADING" };
  constructor(private readonly api: ParlanceApi, private readonly passkey: PasskeyClient, private readonly listener: Listener = () => undefined) {}
  private transition(state: PasskeyOnboardingState): void { this.state = state; this.listener(state); }

  async load(): Promise<void> {
    this.transition({ phase: "LOADING" });
    try { this.transition({ phase: (await this.api.passkeyStatus()).status === "READY" ? "READY" : "NOT_ENROLLED" }); }
    catch { this.transition({ phase: "FAILED" }); }
  }

  async enroll(): Promise<void> {
    if (!["NOT_ENROLLED", "CANCELLED", "EXPIRED", "UNAVAILABLE", "FAILED"].includes(this.state.phase)) return;
    this.transition({ phase: "ENROLLING" });
    try {
      const issued = await this.api.registrationOptions();
      const credential = await this.passkey.register(issued.options);
      await this.api.verifyRegistration(issued.challengeId, credential);
      this.transition({ phase: "READY" });
    } catch (error) {
      const reason = code(error);
      if (error instanceof PasskeyCancelledError) this.transition({ phase: "CANCELLED" });
      else if (reason === "WEBAUTHN_REGISTRATION_CHALLENGE_EXPIRED") this.transition({ phase: "EXPIRED" });
      else if (reason === "PASSKEY_NOT_SUPPORTED") this.transition({ phase: "UNAVAILABLE" });
      else if (reason === "PASSKEY_ALREADY_ENROLLED") this.transition({ phase: "READY" });
      else this.transition({ phase: "FAILED" });
    }
  }
}
