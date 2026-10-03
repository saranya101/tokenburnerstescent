"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createParlanceApi } from "../lib/parlance-api";
import { PasskeyOnboardingController, type PasskeyOnboardingState } from "../lib/passkey-onboarding";
import { browserPasskeyClient } from "../lib/passkey";

export function usePasskeyOnboarding() {
  const [state, setState] = useState<PasskeyOnboardingState>({ phase: "LOADING" });
  const controller = useRef<PasskeyOnboardingController | null>(null);
  if (!controller.current) controller.current = new PasskeyOnboardingController(createParlanceApi(), browserPasskeyClient, setState);
  useEffect(() => { void controller.current!.load(); }, []);
  return { state, enroll: useCallback(() => controller.current!.enroll(), []), reload: useCallback(() => controller.current!.load(), []) };
}
