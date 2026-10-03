import { z } from "zod";

const VoiceInput = z.object({
  rawTranscript: z.string().min(1),
  provider: z.string().min(1),
  transcribedAt: z.string().datetime(),
}).strict();

export const ConversationalMessageInput = z.object({
  userId: z.string().min(1),
  text: z.string().min(1),
  inputMode: z.enum(["TYPED", "VOICE"]).optional(),
  voice: VoiceInput.optional(),
}).strict().superRefine((value, context) => {
  const mode = value.inputMode ?? "TYPED";
  if (mode === "VOICE" && value.voice === undefined) context.addIssue({ code: "custom", path: ["voice"], message: "Voice provenance is required" });
  if (mode === "TYPED" && value.voice !== undefined) context.addIssue({ code: "custom", path: ["voice"], message: "Typed input cannot include voice provenance" });
});

export type ConversationalInputProvenance =
  | { inputMode: "TYPED"; submittedText: string; edited: false }
  | { inputMode: "VOICE"; rawTranscript: string; submittedText: string; provider: string; transcribedAt: string; edited: boolean };

export function inputProvenance(value: z.infer<typeof ConversationalMessageInput>): ConversationalInputProvenance {
  if ((value.inputMode ?? "TYPED") === "TYPED") return { inputMode: "TYPED", submittedText: value.text, edited: false };
  const voice = value.voice!;
  return {
    inputMode: "VOICE", rawTranscript: voice.rawTranscript, submittedText: value.text,
    provider: voice.provider, transcribedAt: voice.transcribedAt, edited: voice.rawTranscript !== value.text,
  };
}
