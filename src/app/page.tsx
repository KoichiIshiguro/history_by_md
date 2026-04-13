import { auth } from "@/lib/auth";
import LoginPage from "@/components/LoginPage";
import MainApp from "@/components/MainApp";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return <LoginPage />;
  }

  const user = session.user as any;
  return <MainApp user={user} isAdmin={user.role === "admin"} />;
}
