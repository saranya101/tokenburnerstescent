import { ApprovalPanel, FinancialPlanCard, GoalContractCard } from "../../../components/placeholders";
export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <div className="grid gap-4"><p>Goal {id}</p><GoalContractCard /><FinancialPlanCard /><ApprovalPanel /></div>; }
