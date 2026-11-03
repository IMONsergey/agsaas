import type { Metadata } from "next";
import { AccountSessions } from "@/components/account-sessions";
import { ChangePassword } from "@/components/change-password";
import { MfaSettingsList } from "@/components/mfa-settings-list";
import { AddNewDeviceModal } from "@/components/modals/add-new-device";
import { SecurityHistory } from "@/components/security-history";
import { getPasswordCapabilities } from "@/utils/password-config.server";

export const metadata: Metadata = {
  title: "Security | AGSaaS",
};

export default async function Security() {
  return (
    <div className="space-y-12">
      {getPasswordCapabilities().passwordChange.enabled && <ChangePassword />}
      <MfaSettingsList />
      <AccountSessions />
      <SecurityHistory />
      <AddNewDeviceModal />
    </div>
  );
}
