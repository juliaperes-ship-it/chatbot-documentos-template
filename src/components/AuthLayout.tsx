import type { ReactNode } from "react";
import { APP } from "@/config";

type AuthLayoutProps = {
  children: ReactNode;
  title: string;
  description: string;
};

export function AuthLayout({ children, title, description }: AuthLayoutProps) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-muted/40 px-4 py-8 sm:px-6">
      <section className="w-full max-w-xl rounded-lg border bg-card px-5 py-10 text-card-foreground shadow-sm sm:px-12 sm:py-12">
        <header className="mb-9 text-center">
          {APP.logo ? (
            <img src={APP.logo} alt={APP.nome} className="mx-auto mb-8 h-14 w-auto" />
          ) : (
            <p className="mb-8 text-lg font-bold tracking-tight text-primary">{APP.nome}</p>
          )}
          <h1 className="text-3xl font-semibold leading-tight">{title}</h1>
          <p className="mt-2 text-base text-muted-foreground">{description}</p>
        </header>
        {children}
      </section>
    </main>
  );
}