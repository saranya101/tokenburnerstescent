import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MockIntentInterpreter } from "@parlance/intent-engine";
const MessageInput = z.object({ userId: z.string().min(1), text: z.string().min(1) });
export async function receiveMessage(value: unknown) { const input = MessageInput.parse(value); const intentDraft = await new MockIntentInterpreter().interpretUserRequest(input); return { id: randomUUID(), status: "AWAITING_GOAL_CONFIRMATION", intentDraft, notice: "Mock interpreter only; no financial plan has been created." }; }
export function placeholder(resource: string, id?: string) { return { resource, id, status: "NOT_IMPLEMENTED", todo: "Persist and orchestrate this workflow in PostgreSQL." }; }
