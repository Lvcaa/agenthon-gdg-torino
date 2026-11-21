import { ChatScreen } from "../chat-screen";
import { EmployeePanel, type Params } from "../role-panels";

export const dynamic = "force-dynamic";

export default async function EmployeePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return <ChatScreen permission="employee" as={params.as} aside={EmployeePanel({ params })} />;
}
