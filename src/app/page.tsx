import { auth } from "@/lib/auth";
import LandingPage from "@/components/LandingPage";
import MainAppLoader from "@/components/MainAppLoader";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return <LandingPage isDev={process.env.NODE_ENV === "development"} />;
  }

  const user = session.user as any;
  return <MainAppLoader user={user} isAdmin={user.role === "admin"} />;
}
