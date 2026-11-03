"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import { useConnectParams } from "@/hooks/use-connect-params";
import { useInstanceCapabilities } from "@/hooks/use-instance-capabilities";
import { useTeamQuery } from "@/hooks/use-team";
import { BankSearchContent } from "../bank-search-content";
import { HostedBankConsents } from "../hosted-bank-consents";

export function ConnectTransactionsModal() {
  const { step, setParams } = useConnectParams();
  const { data: team } = useTeamQuery();
  const { data: capabilities } = useInstanceCapabilities();

  const isOpen = step === "connect";

  const handleOnClose = () => {
    setParams({
      step: null,
      countryCode: null,
      search: null,
      ref: null,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOnClose}>
      <DialogContent>
        <div className="p-4">
          <DialogHeader>
            <DialogTitle>Connect bank account</DialogTitle>

            <DialogDescription>
              Connect using the providers configured for this installation, or
              use{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setParams({ step: "import" })}
              >
                manual import
              </button>{" "}
              to add a statement.
            </DialogDescription>

            <div className="pt-4">
              <HostedBankConsents
                enabled={isOpen}
                showUnavailable
                defaultCountryCode={team?.countryCode ?? ""}
                onVerified={handleOnClose}
              />
              {capabilities?.banking.enabled && (
                <BankSearchContent
                  enabled={isOpen}
                  defaultCountryCode={team?.countryCode ?? ""}
                />
              )}
            </div>
          </DialogHeader>
        </div>
      </DialogContent>
    </Dialog>
  );
}
