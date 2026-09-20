import type { ReactNode } from "react";
function Box({ title, children }: { title: string; children?: ReactNode }) { return <section className="card"><h3>{title}</h3>{children ?? <p>TODO: connect durable API data.</p>}</section>; }
export const ChatInput = () => <Box title="Chat input"><input aria-label="Message" placeholder="Describe a financial goal" className="text-black" /></Box>;
export const IntentPreview = () => <Box title="Intent preview" />; export const AmbiguityPrompt = () => <Box title="Ambiguity prompt" />;
export const GoalContractCard = () => <Box title="Goal contract" />; export const FinancialPlanCard = () => <Box title="Financial plan" />;
export const ApprovalPanel = () => <Box title="Approval" />; export const ExecutionTimeline = () => <Box title="Execution timeline" />;
export const OpportunityCard = () => <Box title="Opportunity" />; export const OpsExecutionTable = () => <Box title="Executions" />;
export const AuditTimeline = () => <Box title="Audit trail" />;
