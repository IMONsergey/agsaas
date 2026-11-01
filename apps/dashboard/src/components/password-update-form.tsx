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
import { useRouter } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod/v3";
import { changePasswordAction } from "@/actions/change-password-action";
import { resetPasswordAction } from "@/actions/reset-password-action";
import { runAuthRequest } from "@/utils/auth-flow";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/utils/password-policy";

export function PasswordUpdateForm({ mode }: { mode: "change" | "reset" }) {
  const change = useAction(changePasswordAction);
  const reset = useAction(resetPasswordAction);
  const { toast } = useToast();
  const router = useRouter();
  const pending = useRef(false);
  const [isLoading, setLoading] = useState(false);
  const formSchema = z
    .object({
      currentPassword: z.string().max(1024),
      password: z
        .string()
        .min(
          MIN_PASSWORD_LENGTH,
          `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
        )
        .max(MAX_PASSWORD_LENGTH),
      confirmPassword: z.string().max(MAX_PASSWORD_LENGTH),
    })
    .superRefine((values, ctx) => {
      if (mode === "change" && !values.currentPassword)
        ctx.addIssue({
          code: "custom",
          path: ["currentPassword"],
          message: "Enter your current password.",
        });
      if (values.password !== values.confirmPassword)
        ctx.addIssue({
          code: "custom",
          path: ["confirmPassword"],
          message: "Passwords do not match.",
        });
    });
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: "", password: "", confirmPassword: "" },
  });
  const executing = isLoading || change.isExecuting || reset.isExecuting;

  async function onSubmit(values: z.infer<typeof formSchema>) {
    if (pending.current || executing) return;
    await runAuthRequest({
      request: async () => {
        const result =
          mode === "change"
            ? await change.executeAsync({
                currentPassword: values.currentPassword,
                password: values.password,
              })
            : await reset.executeAsync({ password: values.password });
        return { error: result?.data?.updated ? undefined : true };
      },
      setPending: (value) => {
        pending.current = value;
        setLoading(value);
      },
      onSuccess: () => {
        form.reset();
        if (mode === "reset") {
          router.replace("/login?password_reset=1");
          router.refresh();
        } else
          toast({
            title: "Password updated",
            description: "Use your new password the next time you sign in.",
          });
      },
      onError: () =>
        toast({
          title: "Unable to update your password",
          description:
            mode === "change"
              ? "Check your current password, or sign in again and verify your identity."
              : "Choose a different password, or request a new reset link and verify your identity.",
          variant: "error",
        }),
    });
  }

  const fields = [
    ...(mode === "change"
      ? [
          {
            name: "currentPassword" as const,
            label: "Current password",
            autoComplete: "current-password",
          },
        ]
      : []),
    {
      name: "password" as const,
      label: "New password",
      autoComplete: "new-password",
    },
    {
      name: "confirmPassword" as const,
      label: "Confirm new password",
      autoComplete: "new-password",
    },
  ];
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {fields.map(({ name, label, autoComplete }) => (
          <FormField
            key={name}
            control={form.control}
            name={name}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{label}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="password"
                    autoComplete={autoComplete}
                    disabled={executing}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          Use at least {MIN_PASSWORD_LENGTH} characters and a password you do
          not use elsewhere.
        </p>
        <SubmitButton type="submit" isSubmitting={executing}>
          {mode === "change" ? "Change password" : "Reset password"}
        </SubmitButton>
      </form>
    </Form>
  );
}
