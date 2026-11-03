"use client";

import {
  PUBLIC_IMAGE_ACCEPT,
  PUBLIC_IMAGE_NOTICE,
  publicImagePath,
} from "@/utils/public-image-upload";

import { Avatar, AvatarFallback, AvatarImage } from "@midday/ui/avatar";
import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { forwardRef, useRef, useState } from "react";
import { useUpload } from "@/hooks/use-upload";
import { useTRPC } from "@/trpc/client";

type Props = {
  userId: string;
  avatarUrl?: string | null;
  onUpload?: (url: string) => void;
  size?: number;
  className?: string;
};

export const AvatarUpload = forwardRef<HTMLInputElement, Props>(
  (
    { userId, avatarUrl: initialAvatarUrl, size = 65, onUpload, className },
    ref,
  ) => {
    const [avatar, setAvatar] = useState(initialAvatarUrl);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const trpc = useTRPC();
    const queryClient = useQueryClient();

    const updateUserMutation = useMutation(
      trpc.user.update.mutationOptions({
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: trpc.user.me.queryKey(),
          });
        },
      }),
    );

    const { isLoading, uploadFile } = useUpload();

    const handleUpload = async (evt: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = evt.target;
      const selectedFile = files as FileList;

      const file = selectedFile[0];
      if (!file) return;
      setUploadError(null);
      try {
        const { url } = await uploadFile({
          bucket: "avatars",
          path: publicImagePath(file, userId, "user-avatar"),
          file,
        });

        if (url) {
          updateUserMutation.mutate({ avatarUrl: url });
          setAvatar(url);
          onUpload?.(url);
        }
      } catch {
        setUploadError(
          "Upload failed. Choose a PNG, JPEG, WebP or GIF up to 5 MiB and verify your session.",
        );
      }
    };

    const fileInputRef = ref || inputRef;

    return (
      <div className="space-y-2">
        <Avatar
          className={cn(
            "rounded-full flex items-center justify-center bg-accent cursor-pointer border border-border",
            className,
          )}
          style={{ width: size, height: size }}
          onClick={() => {
            if ("current" in fileInputRef && fileInputRef.current) {
              fileInputRef.current.click();
            }
          }}
        >
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <>
              <AvatarImage src={avatar ?? undefined} />
              <AvatarFallback>
                <Icons.AccountCircle className="size-5" />
              </AvatarFallback>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={PUBLIC_IMAGE_ACCEPT}
            style={{ display: "none" }}
            multiple={false}
            onChange={handleUpload}
          />
        </Avatar>
        <p className="max-w-xs text-xs text-muted-foreground">
          {PUBLIC_IMAGE_NOTICE}
        </p>
        {uploadError && (
          <p role="alert" className="text-xs text-destructive">
            {uploadError}
          </p>
        )}
      </div>
    );
  },
);

AvatarUpload.displayName = "AvatarUpload";
