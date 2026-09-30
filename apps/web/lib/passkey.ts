import type { AuthenticationCredentialJSON, AuthenticationOptionsJSON, RegistrationCredentialJSON, RegistrationOptionsJSON } from "./parlance-api";

export class PasskeyCancelledError extends Error {
  readonly name = "PasskeyCancelledError";
  constructor() { super("PASSKEY_CANCELLED"); }
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(normalized); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function toBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export async function requestPasskey(options: AuthenticationOptionsJSON): Promise<AuthenticationCredentialJSON> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("PASSKEY_NOT_SUPPORTED");
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: {
      challenge: fromBase64Url(options.challenge), ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.rpId === undefined ? {} : { rpId: options.rpId }), ...(options.userVerification === undefined ? {} : { userVerification: options.userVerification }),
      ...(options.allowCredentials === undefined ? {} : { allowCredentials: options.allowCredentials.map((item) => ({ ...item, id: fromBase64Url(item.id) })) }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") throw new PasskeyCancelledError();
    throw error;
  }
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new Error("PASSKEY_INVALID_RESPONSE");
  const response = credential.response;
  const attachment = credential.authenticatorAttachment === "platform" || credential.authenticatorAttachment === "cross-platform" ? credential.authenticatorAttachment : undefined;
  return {
    id: credential.id, rawId: toBase64Url(credential.rawId), type: "public-key",
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON), authenticatorData: toBase64Url(response.authenticatorData), signature: toBase64Url(response.signature),
      ...(response.userHandle === null ? {} : { userHandle: toBase64Url(response.userHandle) }),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
  };
}

export async function registerPasskey(options: RegistrationOptionsJSON): Promise<RegistrationCredentialJSON> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("PASSKEY_NOT_SUPPORTED");
  const { challenge, user, excludeCredentials, ...remainingOptions } = options;
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey: {
      ...remainingOptions, challenge: fromBase64Url(challenge), user: { ...user, id: fromBase64Url(user.id) },
      ...(excludeCredentials === undefined ? {} : { excludeCredentials: excludeCredentials.map((item) => ({ ...item, id: fromBase64Url(item.id) })) }),
    } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") throw new PasskeyCancelledError();
    throw error;
  }
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) throw new Error("PASSKEY_INVALID_RESPONSE");
  const response = credential.response;
  const attachment = credential.authenticatorAttachment === "platform" || credential.authenticatorAttachment === "cross-platform" ? credential.authenticatorAttachment : undefined;
  return {
    id: credential.id, rawId: toBase64Url(credential.rawId), type: "public-key",
    response: { clientDataJSON: toBase64Url(response.clientDataJSON), attestationObject: toBase64Url(response.attestationObject), transports: response.getTransports() as AuthenticatorTransport[] },
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
  };
}

export interface PasskeyClient {
  request(options: AuthenticationOptionsJSON): Promise<AuthenticationCredentialJSON>;
  register(options: RegistrationOptionsJSON): Promise<RegistrationCredentialJSON>;
}
export const browserPasskeyClient: PasskeyClient = { request: requestPasskey, register: registerPasskey };
