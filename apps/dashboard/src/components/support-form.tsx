"use client";

import { Button } from "@midday/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@midday/ui/form";
import { Input } from "@midday/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { Textarea } from "@midday/ui/textarea";
import { useToast } from "@midday/ui/use-toast";
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { z } from "zod/v3";
import { sendSupportAction } from "@/actions/send-support-action";
import { useInstanceCapabilities } from "@/hooks/use-instance-capabilities";
import { useZodForm } from "@/hooks/use-zod-form";

const formSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  type: z.enum([
    "Transactions",
    "Vault",
    "Inbox",
    "Invoicing",
    "Tracker",
    "AI",
    "General",
  ]),
  message: z.string().trim().min(1).max(10_000),
  url: z.string().max(2048).optional(),
});

export function SupportForm() {
  const { toast } = useToast();
  const { data: capabilities, isPending } = useInstanceCapabilities();

  const form = useZodForm(formSchema, {
    defaultValues: {
      subject: undefined,
      type: undefined,
      priority: undefined,
      message: undefined,
    },
  });

  const sendSupport = useAction(sendSupportAction, {
    onSuccess: ({ data }) => {
      if (!data?.accepted) return;
      toast({
        duration: 2500,
        title: "Support ticket sent.",
        variant: "success",
      });

      form.reset();
    },
    onError: ({ error }) => {
      toast({
        duration: 3500,
        variant: "error",
        title: "Support request not confirmed",
        description: error.serverError ?? "Check the form and try again.",
      });
    },
  });

  if (!capabilities?.support.enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        {isPending
          ? "Checking support availability..."
          : "Support messaging is not configured for this installation. Contact your workspace administrator."}
      </p>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(sendSupport.execute)}
        className="space-y-8"
      >
        <FormField
          control={form.control}
          name="subject"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Subject</FormLabel>
              <FormControl>
                <Input
                  placeholder="Summary of the problem you have"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex space-x-4">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem className="w-full">
                <FormLabel>Product</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select Product" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="Transactions">Transactions</SelectItem>
                    <SelectItem value="Vault">Vault</SelectItem>
                    <SelectItem value="Inbox">Inbox</SelectItem>
                    <SelectItem value="Invoicing">Invoicing</SelectItem>
                    <SelectItem value="Tracker">Tracker</SelectItem>
                    <SelectItem value="AI">AI</SelectItem>
                    <SelectItem value="General">General</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="priority"
            render={({ field }) => (
              <FormItem className="w-full">
                <FormLabel>Severity</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select severity" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="message"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Message</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Describe the issue you're facing, along with any relevant information. Please be as detailed and specific as possible."
                  className="resize-none min-h-[150px]"
                  {...field}
                />
              </FormControl>

              <FormMessage />
            </FormItem>
          )}
        />

        <Button
          type="submit"
          disabled={
            sendSupport.status === "executing" || !form.formState.isValid
          }
        >
          {sendSupport.status === "executing" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Submit"
          )}
        </Button>
      </form>
    </Form>
  );
}
