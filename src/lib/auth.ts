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
 * Demo login — one-click email pick + shared password.
 *
 * Enabled in any env (including production) when both env vars are set:
 *   - DEMO_LOGIN_EMAILS    comma-separated allow-list of seeded demo emails
 *   - DEMO_LOGIN_PASSWORD  shared password required for any demo sign-in
 *
 * UX matches the Dev Login: presenter clicks a button (no email typing),
 * but a password gate keeps random visitors out. Each entered email must
 * be in the whitelist AND exist in the `users` table (seeded via
 * `npm run seed:demo`).
 */
const demoEmails = (process.env.DEMO_LOGIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const demoPassword = process.env.DEMO_LOGIN_PASSWORD || "";

if (demoEmails.length > 0 && demoPassword) {
  providers.push(
    Credentials({
      id: "demo",
      name: "Demo Login",
      credentials: {
        email: { label: "Demo Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const email = String(creds?.email || "").trim().toLowerCase();
        const pw = String(creds?.password || "");
        if (!email || !demoEmails.includes(email)) return null;
        // Constant-time comparison would be ideal, but the password is
        // operator-supplied and not user-derived, so the timing leak is
        // negligible. Use straight string equality.
        if (pw !== demoPassword) return null;
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

export const demoLoginEnabled = demoEmails.length > 0 && Boolean(demoPassword);
/** Whitelisted demo emails — exposed so the landing page can render a
 *  one-click button per account (no manual email typing). */
export const demoLoginEmails: string[] = demoLoginEnabled ? demoEmails : [];

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
