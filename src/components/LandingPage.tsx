"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LandingPage({ isDev = false, demoEnabled = false }: { isDev?: boolean; demoEnabled?: boolean }) {
  const [demoEmail, setDemoEmail] = useState("");
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);

  const doDemoLogin = async () => {
    const email = demoEmail.trim();
    if (!email) { setDemoError("メールアドレスを入力してください"); return; }
    setDemoBusy(true); setDemoError(null);
    const res = await signIn("demo", { email, redirect: false, callbackUrl: "/" });
    setDemoBusy(false);
    if (res?.error) {
      setDemoError("このメールアドレスはデモ用として登録されていません");
    } else if (res?.url) {
      window.location.href = res.url;
    }
  };
  return (
    <div className="min-h-screen bg-white">
      {/* Hero */}
      <header className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-theme-50 via-white to-theme-50" />
        <div className="relative mx-auto max-w-5xl px-6 py-20 md:py-32">
          <div className="flex flex-col items-center text-center md:flex-row md:text-left md:gap-12">
            <div className="flex-1">
              <h1 className="text-5xl font-bold tracking-tight text-gray-900 md:text-6xl">
                history<span className="text-theme-500">-md</span>
              </h1>
              <p className="mt-4 text-xl text-gray-600 leading-relaxed">
                思考を整理し、アイデアを繋げる。
              </p>
              <p className="mt-2 text-base text-gray-500">
                ブロックベースのノート管理で、日々の記録からプロジェクト管理まで。
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  onClick={() => signIn("google")}
                  className="flex items-center justify-center gap-3 rounded-xl bg-theme-500 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-theme-500/25 transition hover:bg-theme-600 hover:shadow-xl hover:shadow-theme-500/30"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#fff" fillOpacity="0.8"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff" fillOpacity="0.9"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#fff" fillOpacity="0.7"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#fff" fillOpacity="0.85"/>
                  </svg>
                  Googleで始める
                </button>
                {isDev && (
                  <button
                    onClick={() => signIn("credentials", { redirect: true, callbackUrl: "/" })}
                    className="rounded-xl border-2 border-dashed border-theme-300 bg-theme-50 px-6 py-3.5 text-sm font-medium text-theme-600 transition hover:bg-theme-100"
                  >
                    Dev Login
                  </button>
                )}
              </div>
              {/* Demo login — enabled when DEMO_LOGIN_EMAILS is set in env */}
              {demoEnabled && (
                <div className="mt-5 rounded-lg border border-dashed border-gray-300 bg-white/70 p-3 max-w-md">
                  <div className="text-xs font-medium text-gray-600 mb-1.5">デモアカウントでログイン</div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="email"
                      value={demoEmail}
                      onChange={(e) => setDemoEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") doDemoLogin(); }}
                      placeholder="demo@example.com"
                      className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-theme-400"
                      disabled={demoBusy}
                    />
                    <button
                      onClick={doDemoLogin}
                      disabled={demoBusy}
                      className="rounded-md bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-60"
                    >{demoBusy ? "..." : "ログイン"}</button>
                  </div>
                  {demoError && <div className="mt-1.5 text-xs text-red-500">{demoError}</div>}
                  <div className="mt-1.5 text-[10px] text-gray-400">
                    許可されたデモ用メールのみ入場可・パスワードなし
                  </div>
                </div>
              )}
            </div>
            {/* Hero illustration */}
            <div className="mt-12 md:mt-0 flex-shrink-0">
              <svg width="280" height="240" viewBox="0 0 280 240" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Notebook */}
                <rect x="40" y="20" width="200" height="200" rx="16" fill="#FFF7ED" stroke="#FDBA74" strokeWidth="2"/>
                <rect x="40" y="20" width="24" height="200" rx="8" fill="#FB923C" opacity="0.15"/>
                {/* Lines */}
                <line x1="80" y1="60" x2="210" y2="60" stroke="#FDBA74" strokeWidth="2" strokeLinecap="round"/>
                <line x1="80" y1="85" x2="190" y2="85" stroke="#FED7AA" strokeWidth="2" strokeLinecap="round"/>
                <line x1="80" y1="110" x2="200" y2="110" stroke="#FED7AA" strokeWidth="2" strokeLinecap="round"/>
                {/* Block bullets */}
                <circle cx="75" cy="60" r="3" fill="#F97316"/>
                <circle cx="75" cy="85" r="3" fill="#FB923C" opacity="0.6"/>
                <circle cx="75" cy="110" r="3" fill="#FB923C" opacity="0.6"/>
                {/* Tag */}
                <rect x="80" y="130" width="50" height="22" rx="4" fill="#FEF3C7" stroke="#FBBF24" strokeWidth="1"/>
                <text x="92" y="145" fontSize="10" fill="#D97706" fontWeight="600">#tag</text>
                {/* Page link */}
                <rect x="140" y="130" width="70" height="22" rx="4" fill="#FFEDD5" stroke="#FB923C" strokeWidth="1"/>
                <text x="148" y="145" fontSize="10" fill="#EA580C" fontWeight="600">{"{{page}}"}</text>
                {/* Floating cards */}
                <g transform="translate(180, 160)">
                  <rect width="56" height="48" rx="8" fill="white" stroke="#FDBA74" strokeWidth="1.5" filter="url(#shadow)"/>
                  <line x1="12" y1="16" x2="44" y2="16" stroke="#FED7AA" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="26" x2="36" y2="26" stroke="#FEF3C7" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="36" x2="40" y2="36" stroke="#FEF3C7" strokeWidth="2" strokeLinecap="round"/>
                </g>
                {/* Connection line */}
                <path d="M175 150 Q200 155 195 170" stroke="#FB923C" strokeWidth="1.5" strokeDasharray="4 3" fill="none" opacity="0.5"/>
                <defs>
                  <filter id="shadow" x="-4" y="-2" width="64" height="56" filterUnits="userSpaceOnUse">
                    <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#F97316" floodOpacity="0.1"/>
                  </filter>
                </defs>
              </svg>
            </div>
          </div>
        </div>
      </header>

      {/* Features */}
      <section className="border-t border-theme-100 bg-white py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold text-gray-900">シンプルで強力なノート管理</h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-gray-500">日々の記録、プロジェクト管理、ナレッジベースをひとつに。</p>
          <div className="mt-14 grid gap-8 md:grid-cols-3">
            {/* Feature 1 */}
            <div className="rounded-2xl border border-theme-100 bg-theme-50/50 p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-theme-100">
                <svg className="h-6 w-6 text-theme-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h6" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900">ブロックエディタ</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                Markdown対応のブロック形式で思考を構造化。コードブロック、Mermaid図、GFMに完全対応。
              </p>
            </div>
            {/* Feature 2 */}
            <div className="rounded-2xl border border-theme-100 bg-theme-50/50 p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-theme-100">
                <svg className="h-6 w-6 text-theme-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900">ページ & タグ</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                階層的なページ構造とタグで情報を整理。相互リンクで知識のネットワークを構築。
              </p>
            </div>
            {/* Feature 3 */}
            <div className="rounded-2xl border border-theme-100 bg-theme-50/50 p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-theme-100">
                <svg className="h-6 w-6 text-theme-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900">アクション管理</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                タスクの進捗をページ横断で追跡。未完了アクションを一覧で確認、チェックで完了。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-theme-100 bg-gradient-to-b from-theme-50/50 to-white py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold text-gray-900">使い方はシンプル</h2>
          <div className="mt-14 flex flex-col items-center gap-4 md:flex-row md:justify-center md:gap-0">
            {[
              { step: "1", title: "書く", desc: "日付ごとにブロックを書く" },
              { step: "2", title: "繋げる", desc: "ページやタグでリンク" },
              { step: "3", title: "振り返る", desc: "情報が自動で集約" },
            ].map((item, i) => (
              <div key={item.step} className="flex items-center gap-4 md:gap-0">
                <div className="flex flex-col items-center text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-theme-500 text-2xl font-bold text-white shadow-lg shadow-theme-500/20">
                    {item.step}
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-gray-900">{item.title}</h3>
                  <p className="mt-1 text-sm text-gray-500 max-w-[140px]">{item.desc}</p>
                </div>
                {i < 2 && (
                  <svg className="hidden md:block mx-8 h-6 w-12 text-theme-300" fill="none" stroke="currentColor" viewBox="0 0 48 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 12h40m-6-6l6 6-6 6" />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-theme-100 bg-white py-8">
        <div className="mx-auto max-w-5xl px-6 text-center">
          <p className="text-lg font-bold text-gray-800">
            history<span className="text-theme-500">-md</span>
          </p>
          <p className="mt-1 text-sm text-gray-400">&copy; {new Date().getFullYear()} history-md</p>
        </div>
      </footer>
    </div>
  );
}
