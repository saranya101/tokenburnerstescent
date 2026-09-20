import { ExecutionTimeline } from "../../../components/placeholders";
export default async function ExecutionPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <><p>Execution {id}</p><ExecutionTimeline /></>; }
