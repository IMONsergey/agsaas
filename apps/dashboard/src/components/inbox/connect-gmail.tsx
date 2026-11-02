"use client";

import { Icons } from "@midday/ui/icons";
import { SubmitButton } from "@midday/ui/submit-button";
import { useInboxOAuth } from "@/hooks/use-inbox-oauth";
import { useInstanceCapabilities } from "@/hooks/use-instance-capabilities";

type Props = {
  redirectPath?: string;
};

export function ConnectGmail({ redirectPath }: Props) {
  const { data: capabilities } = useInstanceCapabilities();
  const configured = capabilities?.integrations.gmail?.enabled === true;

  const connectMutation = useInboxOAuth();

  return (
    <SubmitButton
      className="px-4 font-medium h-[40px] w-full"
      variant="outline"
      data-track="Inbox Email Connected"
      data-provider="gmail"
      onClick={() =>
        connectMutation.mutate({ provider: "gmail", redirectPath })
      }
      disabled={!configured}
      title={configured ? undefined : "Not configured for this installation"}
      isSubmitting={connectMutation.isPending}
    >
      <div className="flex items-center space-x-2">
        <Icons.Gmail />
        <span>Connect Gmail</span>
      </div>
    </SubmitButton>
  );
}
