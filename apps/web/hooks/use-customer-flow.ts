"use client";

import { useCallback, useRef, useState } from "react";
import { createParlanceApi } from "../lib/parlance-api";
import { CustomerFlowController, type CustomerFlowState } from "../lib/customer-flow";
import { browserPasskeyClient } from "../lib/passkey";

export function useCustomerFlow() {
  const [state, setState] = useState<CustomerFlowState>({ phase: "COMPOSE" });
  const controller = useRef<CustomerFlowController | null>(null);
  if (!controller.current) controller.current = new CustomerFlowController(createParlanceApi(), browserPasskeyClient, setState);
  return {
    state,
    submitMessage: useCallback((text: string) => controller.current!.submitMessage(text), []),
    answerClarification: useCallback((clarification: Parameters<CustomerFlowController["answerClarification"]>[0], option: Parameters<CustomerFlowController["answerClarification"]>[1]) => controller.current!.answerClarification(clarification, option), []),
    answerClarificationText: useCallback((clarification: Parameters<CustomerFlowController["answerClarificationText"]>[0], answer: string) => controller.current!.answerClarificationText(clarification, answer), []),
    confirmMeaning: useCallback(() => controller.current!.confirmMeaning(), []),
    authorizeAndExecute: useCallback(() => controller.current!.authorizeAndExecute(), []),
    passkeyEnrolled: useCallback(() => controller.current!.passkeyEnrolled(), []),
    reset: useCallback(() => controller.current!.reset(), []),
  };
}
