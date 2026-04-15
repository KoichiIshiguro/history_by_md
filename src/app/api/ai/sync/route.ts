import { auth } from "@/lib/auth";
import { syncVectors, checkDailyLimit, incrementUsage } from "@/lib/ai";

export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;

  if (!checkDailyLimit(userId, "sync")) {
    return Response.json({ error: "日次同期上限に達しました" }, { status: 429 });
  }

  try {
    incrementUsage(userId, "sync");
    const result = await syncVectors(userId);
    if (result.errors.length > 0) {
      console.error("AI sync partial errors:", result.errors);
    }
    return Response.json(result);
  } catch (e: any) {
    console.error("AI sync error:", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
