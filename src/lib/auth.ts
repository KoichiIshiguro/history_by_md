import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getDb } from "./db";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;
      const db = getDb();
      const existing = db
        .prepare("SELECT id, role FROM users WHERE email = ?")
        .get(user.email) as { id: string; role: string } | undefined;
      if (!existing) {
        // Check if this is the first user (make them admin)
        const count = db.prepare("SELECT COUNT(*) as cnt FROM users").get() as {
          cnt: number;
        };
        const role = count.cnt === 0 ? "admin" : "user";
        db.prepare(
          "INSERT INTO users (id, email, name, image, role) VALUES (?, ?, ?, ?, ?)"
        ).run(user.id || crypto.randomUUID(), user.email, user.name, user.image, role);
      } else {
        db.prepare("UPDATE users SET name = ?, image = ?, updated_at = datetime('now') WHERE id = ?").run(
          user.name,
          user.image,
          existing.id
        );
      }
      return true;
    },
    async session({ session }) {
      if (session.user?.email) {
        const db = getDb();
        const dbUser = db
          .prepare("SELECT id, role FROM users WHERE email = ?")
          .get(session.user.email) as { id: string; role: string } | undefined;
        if (dbUser) {
          (session.user as any).id = dbUser.id;
          (session.user as any).role = dbUser.role;
        }
      }
      return session;
    },
  },
});
