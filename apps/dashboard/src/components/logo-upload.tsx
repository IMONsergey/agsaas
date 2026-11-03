"use client";

import { Avatar, AvatarImage } from "@midday/ui/avatar";
import { Spinner } from "@midday/ui/spinner";
import { useRef, useState } from "react";
import { useUpload } from "@/hooks/use-upload";
import { useUserQuery } from "@/hooks/use-user";
import {
  PUBLIC_IMAGE_ACCEPT,
  PUBLIC_IMAGE_NOTICE,
  publicImagePath,
} from "@/utils/public-image-upload";

type Props = {
  logoUrl?: string | null;
  onUpload?: (url: string) => void;
  size?: number;
};

export const LogoUpload = ({ logoUrl: initialLogoUrl, onUpload }: Props) => {
  const [logo, setLogo] = useState(initialLogoUrl);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { data: user } = useUserQuery();
  const inputRef = useRef<HTMLInputElement>(null);

  const { isLoading, uploadFile } = useUpload();

  const handleUpload = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const { files } = evt.target;
    const selectedFile = files as FileList;

    if (!selectedFile[0]) return;

    setUploadError(null);
    try {
      const { url } = await uploadFile({
        bucket: "apps",
        path: publicImagePath(selectedFile[0], user?.teamId ?? "", "app-logo"),
        file: selectedFile[0] as File,
      });

      if (url) {
        setLogo(url);
        onUpload?.(url);
      }
    } catch {
      setUploadError(
        "Upload failed. Use a supported image up to 5 MiB and an owner account with a verified session.",
      );
    }
  };

  return (
    <div className="space-y-2">
      <Avatar
        className="rounded-none w-16 h-16 flex items-center justify-center bg-accent cursor-pointer"
        onClick={() => inputRef?.current?.click()}
      >
        {isLoading ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <AvatarImage
            src={logo ?? undefined}
            alt="Logo"
            width={64}
            height={64}
          />
        )}

        <input
          ref={inputRef}
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
};
