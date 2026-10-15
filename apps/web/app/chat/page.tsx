import { BankingShell } from "../../components/banking/banking-shell";
import { ChatExperience } from "../../components/chat/chat-experience";
import { connection } from "next/server";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  await connection();
  const draft = (await searchParams).draft;
  const initialRequest = typeof draft === "string" && draft.length <= 240 ? draft : "";
  return <BankingShell active="parlance"><ChatExperience initialRequest={initialRequest} financialExecutionAvailable={process.env.PARLANCE_PUBLIC_SAFE_MODE !== "true"} /></BankingShell>;
}
