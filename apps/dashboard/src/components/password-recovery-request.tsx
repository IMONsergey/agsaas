"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@midday/ui/form";
import { Input } from "@midday/ui/input";
import { SubmitButton } from "@midday/ui/submit-button";
import { useToast } from "@midday/ui/use-toast";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod/v3";
import { requestPasswordRecoveryAction } from "@/actions/request-password-recovery-action";
import { runAuthRequest } from "@/utils/auth-flow";

const formSchema = z.object({ email: z.string().trim().email().max(320) });

export function PasswordRecoveryRequest() {
  const request = useAction(requestPasswordRecoveryAction);
  const { toast } = useToast();
  const [isLoading, setLoading] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const pending = useRef(false);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    if (pending.current || request.isExecuting) return;
    await runAuthRequest({
      request: async () => {
        const result = await request.executeAsync(values);
        return { error: result?.data?.accepted ? undefined : true };
      },
      setPending: (value) => {
        pending.current = value;
        setLoading(value);
      },
      onSuccess: () => {
        form.reset();
        setAccepted(true);
      },
      onError: () =>
        toast({
          title: "Unable to request a reset link",
          description:
            "Please try again later or contact your workspace owner.",
          variant: "error",
        }),
    });
  }

  if (accepted)
    return (
      <p role="status" className="text-sm text-center">
        If the account is eligible, check your email for a reset link. Open the
        link in this same browser.
      </p>
    );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email address</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={isLoading || request.isExecuting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <SubmitButton
          type="submit"
          className="w-full"
          isSubmitting={isLoading || request.isExecuting}
        >
          Send reset link
        </SubmitButton>
      </form>
    </Form>
  );
}
