import { BankingShell } from "../../components/banking/banking-shell";
import { ChatExperience } from "../../components/chat/chat-experience";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const draft = (await searchParams).draft;
  const initialRequest = typeof draft === "string" && draft.length <= 240 ? draft : "";
  return <BankingShell active="parlance"><ChatExperience initialRequest={initialRequest} /></BankingShell>;
}
