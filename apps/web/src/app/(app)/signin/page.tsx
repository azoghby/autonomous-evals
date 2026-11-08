import { Suspense } from "react";
import { SignInForm } from "@/components/app/signin-form";

export const metadata = { title: "Sign in · Standard Evals" };

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
