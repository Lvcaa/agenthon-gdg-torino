import { ChatScreen } from "../chat-screen";

export const dynamic = "force-dynamic";

export default async function EmployeePage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const { as } = await searchParams;
  return <ChatScreen permission="employee" as={as} />;
}
