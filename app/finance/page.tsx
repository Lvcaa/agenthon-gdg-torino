import { ChatScreen } from "../chat-screen";
import { FinancePanel, type Params } from "../role-panels";

export const dynamic = "force-dynamic";

export default async function FinancePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return <ChatScreen permission="finance" as={params.as} aside={FinancePanel({ params })} />;
}
