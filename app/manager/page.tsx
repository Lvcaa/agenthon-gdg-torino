import { ChatScreen } from "../chat-screen";
import { ManagerPanel, type Params } from "../role-panels";

export const dynamic = "force-dynamic";

export default async function ManagerPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return <ChatScreen permission="manager" as={params.as} aside={ManagerPanel({ params })} />;
}
