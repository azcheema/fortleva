import Link from "next/link";

import { requireMemberSession } from "@/auth/session";

import { SignOutButton } from "./sign-out-button";

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireMemberSession();

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200">
        <nav className="mx-auto flex max-w-3xl items-center gap-6 px-8 py-3 text-sm">
          <span className="font-semibold">Fortleva</span>
          <Link href="/dashboard" className="hover:underline">
            Dashboard
          </Link>
          <Link href="/members" className="hover:underline">
            Members
          </Link>
          <Link href="/account" className="hover:underline">
            Account
          </Link>
          <span className="ml-auto text-neutral-500">{session.user.email}</span>
          <SignOutButton />
        </nav>
      </header>
      {children}
    </div>
  );
}
