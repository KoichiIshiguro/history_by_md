"use client";

import dynamic from "next/dynamic";

const MainApp = dynamic(() => import("@/components/MainApp"), { ssr: false });

interface Props {
  user: { id: string; name?: string | null; email?: string | null; image?: string | null; role: string };
  isAdmin: boolean;
}

export default function MainAppLoader(props: Props) {
  return <MainApp {...props} />;
}
