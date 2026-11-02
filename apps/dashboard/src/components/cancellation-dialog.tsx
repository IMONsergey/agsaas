"use client";

import { track } from "@midday/events/client";
import { LogEvents } from "@midday/events/events";
import { AnimatedSizeContainer } from "@midday/ui/animated-size-container";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import { SubmitButton } from "@midday/ui/submit-button";
import { Textarea } from "@midday/ui/textarea";
import { useToast } from "@midday/ui/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";

type CancellationReason =
  | "too_expensive"
  | "missing_features"
  | "unused"
  | "switched_service"
  | "other";

type Step = 1 | 2 | 3 | "done";

const REASONS: { value: CancellationReason; label: string }[] = [
  { value: "too_expensive", label: "Too expensive" },
  { value: "missing_features", label: "Missing a feature I need" },
  { value: "unused", label: "Not using it enough" },
  { value: "switched_service", label: "Switching to another tool" },
  { value: "other", label: "Other" },
];

const stepTransition = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};

type CancellationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CancellationDialog({
  open,
  onOpenChange,
}: CancellationDialogProps) {
  const [step, setStep] = useState<Step>(1);
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [comment, setComment] = useState("");

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: user } = useUserQuery();
  const isTrialing = user?.team?.subscriptionStatus === "trialing";
  const { toast } = useToast();

  const cancelMutation = useMutation(
    trpc.billing.cancelSubscription.mutationOptions({
      onError: (error) =>
        toast({
          title: "Cancellation failed",
          description: error.message,
          variant: "error",
        }),
      onSuccess: () => {
        setStep("done");

        queryClient.invalidateQueries({
          queryKey: trpc.user.me.queryKey(),
        });

        track({
          event: LogEvents.SubscriptionCanceled.name,
          channel: LogEvents.SubscriptionCanceled.channel,
          reason: reason!,
        });
      },
    }),
  );

  const reset = useCallback(() => {
    setStep(1);
    setReason(null);
    setComment("");
    cancelMutation.reset();
  }, [cancelMutation]);

  const handleClose = useCallback(
    (value: boolean) => {
      if (!value) {
        if (step === "done") {
          queryClient.invalidateQueries({
            queryKey: trpc.user.me.queryKey(),
          });
        }
        setTimeout(reset, 200);
      }
      onOpenChange(value);
    },
    [step, onOpenChange, reset, queryClient, trpc],
  );

  const handleReasonSelect = useCallback((value: CancellationReason) => {
    setReason(value);
    setStep(2);
  }, []);

  const handleCancel = useCallback(() => {
    if (!reason) return;
    cancelMutation.mutate({ reason, comment: comment || undefined });
  }, [reason, comment, cancelMutation]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md overflow-hidden" hideClose>
        <AnimatedSizeContainer height>
          <div className="p-6">
            <AnimatePresence mode="wait" initial={false}>
              {step === 1 && (
                <motion.div key="step-1" {...stepTransition}>
                  <StepOne reason={reason} onSelect={handleReasonSelect} />
                </motion.div>
              )}

              {step === 2 && reason && (
                <motion.div key="step-2" {...stepTransition}>
                  <StepTwo
                    reason={reason}
                    comment={comment}
                    onCommentChange={setComment}
                    onStillCancel={() => setStep(3)}
                    onBack={() => {
                      setReason(null);
                      setComment("");
                      setStep(1);
                    }}
                  />
                </motion.div>
              )}

              {step === 3 && (
                <motion.div key="step-3" {...stepTransition}>
                  <StepThree
                    isSubmitting={cancelMutation.isPending}
                    isTrialing={isTrialing}
                    onConfirm={handleCancel}
                    onKeepPlan={() => handleClose(false)}
                    onBack={() => setStep(2)}
                  />
                </motion.div>
              )}

              {step === "done" && (
                <motion.div key="step-done" {...stepTransition}>
                  <StepDone
                    isTrialing={isTrialing}
                    onClose={() => handleClose(false)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </AnimatedSizeContainer>
      </DialogContent>
    </Dialog>
  );
}

function StepOne({
  reason,
  onSelect,
}: {
  reason: CancellationReason | null;
  onSelect: (value: CancellationReason) => void;
}) {
  return (
    <div>
      <DialogHeader className="mb-6">
        <DialogTitle className="text-base font-medium mb-0">
          We'd love to understand why
        </DialogTitle>
        <DialogDescription>
          Your feedback helps us improve the workspace.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        {REASONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "w-full text-left text-sm p-3 border transition-colors hover:bg-accent",
              reason === value ? "border-primary bg-accent" : "border-border",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepTwo({
  reason,
  comment,
  onCommentChange,
  onStillCancel,
  onBack,
}: {
  reason: CancellationReason;
  comment: string;
  onCommentChange: (value: string) => void;
  onStillCancel: () => void;
  onBack: () => void;
}) {
  const prompt: Record<CancellationReason, string> = {
    too_expensive:
      "You can share feedback about pricing before confirming cancellation.",
    missing_features:
      "What feature would have made the workspace more useful for you?",
    unused: "What kept you from using the workspace?",
    switched_service:
      "Which tool are you switching to? This helps us understand where we can improve.",
    other: "Is there anything else you would like us to know?",
  };
  return (
    <div>
      <DialogHeader className="mb-6">
        <DialogTitle className="text-base font-medium mb-0">
          Before you go
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <p className="text-sm text-[#878787]">{prompt[reason]}</p>
        <Textarea
          placeholder="Tell us more..."
          className="resize-none h-[100px]"
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
        />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onBack}>
            Back
          </Button>
          <Button variant="outline" className="flex-1" onClick={onStillCancel}>
            Continue to cancellation
          </Button>
        </div>
      </div>
    </div>
  );
}

function StepThree({
  isSubmitting,
  isTrialing,
  onConfirm,
  onKeepPlan,
  onBack,
}: {
  isSubmitting: boolean;
  isTrialing: boolean;
  onConfirm: () => void;
  onKeepPlan: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <DialogHeader className="mb-6">
        <DialogTitle className="text-base font-medium mb-0">
          Confirm cancellation
        </DialogTitle>
        <DialogDescription>
          {isTrialing
            ? "Your trial will remain active until it ends. You won't be charged."
            : "Your plan will remain active until the end of your current billing period. You won't be charged again."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <SubmitButton
          variant="outline"
          className="w-full text-destructive hover:text-destructive"
          isSubmitting={isSubmitting}
          onClick={onConfirm}
        >
          Confirm cancellation
        </SubmitButton>

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onBack}
            disabled={isSubmitting}
          >
            Back
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={onKeepPlan}
            disabled={isSubmitting}
          >
            Keep my plan
          </Button>
        </div>
      </div>
    </div>
  );
}

function StepDone({
  isTrialing,
  onClose,
}: {
  isTrialing: boolean;
  onClose: () => void;
}) {
  return (
    <div>
      <DialogHeader className="mb-6">
        <DialogTitle className="text-base font-medium mb-0">
          Subscription canceled
        </DialogTitle>
        <DialogDescription>
          {isTrialing
            ? "Your trial remains active until it ends. After that, you'll need to subscribe to continue using AGSaaS. Your data will be kept safe."
            : "Your plan remains active until the end of your billing period. Your data will be kept safe — you can resubscribe anytime."}
        </DialogDescription>
      </DialogHeader>

      <Button className="w-full" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
