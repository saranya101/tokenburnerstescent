"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createParlanceApi } from "../lib/parlance-api";
import { createExecutionResumeStore, CustomerFlowController, type CustomerFlowState } from "../lib/customer-flow";
import { browserPasskeyClient } from "../lib/passkey";

export function createBrowserExecutionResumeStore() {
  return createExecutionResumeStore({
    getItem: (key) => typeof window === "undefined" ? null : window.sessionStorage.getItem(key),
    setItem: (key, value) => { if (typeof window !== "undefined") window.sessionStorage.setItem(key, value); },
    removeItem: (key) => { if (typeof window !== "undefined") window.sessionStorage.removeItem(key); },
  });
}

export function useCustomerFlow() {
  const [state, setState] = useState<CustomerFlowState>({ phase: "RESTORING_EXECUTION" });
  const controller = useRef<CustomerFlowController | null>(null);
  if (!controller.current) controller.current = new CustomerFlowController(createParlanceApi(), browserPasskeyClient, setState, createBrowserExecutionResumeStore());
  useEffect(() => { void controller.current!.resumeActiveExecution(); }, []);
  return {
    state,
    submitMessage: useCallback((text: string, input?: Parameters<CustomerFlowController["submitMessage"]>[1]) => controller.current!.submitMessage(text, input), []),
    answerClarification: useCallback((clarification: Parameters<CustomerFlowController["answerClarification"]>[0], option: Parameters<CustomerFlowController["answerClarification"]>[1]) => controller.current!.answerClarification(clarification, option), []),
    answerClarificationText: useCallback((clarification: Parameters<CustomerFlowController["answerClarificationText"]>[0], answer: string) => controller.current!.answerClarificationText(clarification, answer), []),
    confirmMeaning: useCallback(() => controller.current!.confirmMeaning(), []),
    authorizeAndExecute: useCallback(() => controller.current!.authorizeAndExecute(), []),
    continueAuthorizedExecution: useCallback(() => controller.current!.continueAuthorizedExecution(), []),
    checkExecutionStatus: useCallback(() => controller.current!.checkExecutionStatus(), []),
    reviewUpdatedPlan: useCallback(() => controller.current!.reviewUpdatedPlan(), []),
    passkeyEnrolled: useCallback(() => controller.current!.passkeyEnrolled(), []),
    reset: useCallback(() => controller.current!.reset(), []),
  };
}
