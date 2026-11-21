import { ChatScreen } from "../chat-screen";

export const dynamic = "force-dynamic";

export default async function ManagerPage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const { as } = await searchParams;
  return <ChatScreen permission="manager" as={as} />;
}
