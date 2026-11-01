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
import { useSearchParams } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod/v3";
import { signInWithPasswordAction } from "@/actions/sign-in-with-password-action";
import { runAuthRequest } from "@/utils/auth-flow";

const formSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1, "Enter your password.").max(1024),
});

export function PasswordSignIn() {
  const signIn = useAction(signInWithPasswordAction);
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isLoading, setLoading] = useState(false);
  const pending = useRef(false);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    if (pending.current || signIn.isExecuting) return;
    await runAuthRequest({
      request: async () => {
        const result = await signIn.executeAsync({
          ...values,
          redirectTo: searchParams.get("return_to") || "/",
        });
        return { error: result?.serverError ?? result?.validationErrors };
      },
      setPending: (value) => {
        pending.current = value;
        setLoading(value);
      },
      onError: () => {
        toast({
          title: "Unable to sign in",
          description: "Check your email and password and try again.",
          variant: "error",
        });
      },
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="w-full">
        <div className="flex flex-col space-y-4">
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
                    disabled={isLoading || signIn.isExecuting}
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
                    disabled={isLoading || signIn.isExecuting}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <SubmitButton
            type="submit"
            className="bg-primary px-6 py-4 text-secondary font-medium flex space-x-2 h-[40px] w-full"
            isSubmitting={isLoading || signIn.isExecuting}
          >
            Sign in
          </SubmitButton>
        </div>
      </form>
    </Form>
  );
}
