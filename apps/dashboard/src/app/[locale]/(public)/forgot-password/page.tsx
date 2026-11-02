import type { Metadata } from "next";
import { AuthFormLayout } from "@/components/auth-form-layout";
import { PasswordRecoveryRequest } from "@/components/password-recovery-request";
import { getPasswordCapabilities } from "@/utils/password-config.server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Reset password | AGSaaS",
  robots: { index: false, follow: false },
};

export default async function ForgotPassword({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const enabled = getPasswordCapabilities().passwordRecovery.enabled;
  return (
    <AuthFormLayout
      title="Reset your password"
      description="Request a password reset link for your account."
    >
      {enabled ? (
        <div className="space-y-4">
          {error === "invalid_link" && (
            <p role="alert" className="text-sm text-destructive">
              This reset link is invalid or has expired. Request a new link and
              open it in the same browser.
            </p>
          )}
          <PasswordRecoveryRequest />
        </div>
      ) : (
        <p role="status" className="text-sm text-center text-muted-foreground">
          Password reset emails are not enabled for this installation. Contact
          your workspace owner if you cannot sign in.
        </p>
      )}
    </AuthFormLayout>
  );
}
