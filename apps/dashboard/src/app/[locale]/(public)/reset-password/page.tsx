import type { Metadata } from "next";
import Link from "next/link";
import { AuthFormLayout } from "@/components/auth-form-layout";
import { PasswordUpdateForm } from "@/components/password-update-form";
import { requirePasswordSession } from "@/utils/password-session.server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Choose password | AGSaaS",
  robots: { index: false, follow: false },
};

export default async function ResetPassword() {
  let allowed = false;
  try {
    await requirePasswordSession({ recovery: true });
    allowed = true;
  } catch {
    /* The form must not accept an ordinary login as recovery. */
  }
  return (
    <AuthFormLayout
      title="Choose a new password"
      description="Complete your password reset after verifying your identity."
    >
      {allowed ? (
        <PasswordUpdateForm mode="reset" />
      ) : (
        <div className="space-y-4 text-sm text-center">
          <p role="alert">
            This reset session is unavailable or has expired. Request a new link
            and complete any required identity verification.
          </p>
          <Link
            href="/forgot-password"
            className="underline underline-offset-4"
          >
            Request a new reset link
          </Link>
        </div>
      )}
    </AuthFormLayout>
  );
}
