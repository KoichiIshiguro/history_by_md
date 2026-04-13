import { auth } from "@/lib/auth";
import LandingPage from "@/components/LandingPage";
import MainApp from "@/components/MainApp";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return <LandingPage isDev={process.env.NODE_ENV === "development"} />;
  }

  const user = session.user as any;
  return <MainApp user={user} isAdmin={user.role === "admin"} />;
}
