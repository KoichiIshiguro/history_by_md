import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { getDb } from "./db";

const providers: any[] = [
  Google({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  }),
];

if (process.env.NODE_ENV === "development") {
  providers.push(
    Credentials({
      id: "credentials",
      name: "Dev Login",
      credentials: {},
      async authorize() {
        return { id: "dev-user", email: "dev@localhost", name: "Dev User", image: null };
      },
    })
  );
}

/**
 * Demo login — passwordless, email-whitelisted.
 *
 * Enabled in any env (including production) when `DEMO_LOGIN_EMAILS` is set
 * to a comma-separated allow-list. The entered email must match an allowed
 * entry AND already exist in the `users` table (i.e. seeded via
 * `npm run seed:demo`). Meant for sales demos — no password, but scope is
 * strictly limited to the pre-seeded demo accounts.
 */
const demoEmails = (process.env.DEMO_LOGIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (demoEmails.length > 0) {
  providers.push(
    Credentials({
      id: "demo",
      name: "Demo Login",
      credentials: { email: { label: "Demo Email", type: "email" } },
      async authorize(creds) {
        const email = String(creds?.email || "").trim().toLowerCase();
        if (!email || !demoEmails.includes(email)) return null;
        const db = getDb();
        const row = db
          .prepare("SELECT id, email, name, image FROM users WHERE lower(email) = ?")
          .get(email) as { id: string; email: string; name: string | null; image: string | null } | undefined;
        if (!row) return null; // must be pre-seeded
        return { id: row.id, email: row.email, name: row.name ?? "Demo", image: row.image };
      },
    })
  );
}

export const demoLoginEnabled = demoEmails.length > 0;

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers,
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
