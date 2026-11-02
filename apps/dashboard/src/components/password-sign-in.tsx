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
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { useRef } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod/v3";
import { signInWithPasswordAction } from "@/actions/sign-in-with-password-action";

const formSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1, "Enter your password.").max(1024),
});

export function PasswordSignIn({
  recoveryEnabled = false,
}: {
  recoveryEnabled?: boolean;
}) {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const pending = useRef(false);
  const signIn = useAction(signInWithPasswordAction, {
    onError: () => {
      toast({
        title: "Unable to sign in",
        description: "Check your email and password and try again.",
        variant: "error",
      });
    },
    onSettled: () => {
      pending.current = false;
    },
  });
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", password: "" },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    if (pending.current || signIn.isPending) return;
    pending.current = true;
    // The action redirects on success. Let the hook distinguish navigation
    // from authentication and transport errors through its callbacks.
    signIn.execute({
      ...values,
      redirectTo: searchParams.get("return_to") || "/",
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="w-full">
        <div className="flex flex-col space-y-4">
          {searchParams.get("password_reset") === "1" && (
            <p role="status" className="text-sm text-primary">
              Your password was updated. Sign in again.
            </p>
          )}
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-primary font-normal">
                  Email address
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="Enter email address"
                    disabled={signIn.isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-primary font-normal">
                  Password
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="password"
                    autoComplete="current-password"
                    placeholder="Enter password"
                    disabled={signIn.isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <SubmitButton
            type="submit"
            className="bg-primary px-6 py-4 text-secondary font-medium flex space-x-2 h-[40px] w-full"
            isSubmitting={signIn.isPending}
          >
            Sign in
          </SubmitButton>
          {recoveryEnabled ? (
            <Link
              href="/forgot-password"
              className="text-sm text-primary underline underline-offset-4 text-center"
            >
              Forgot password?
            </Link>
          ) : (
            <p className="text-xs text-muted-foreground text-center">
              Password reset emails are not enabled. Contact your workspace
              owner if you cannot sign in.
            </p>
          )}
        </div>
      </form>
    </Form>
  );
}
