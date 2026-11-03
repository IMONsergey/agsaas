"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@midday/ui/avatar";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { Spinner } from "@midday/ui/spinner";
import { useRef, useState } from "react";
import { useTeamMutation, useTeamQuery } from "@/hooks/use-team";
import { useUpload } from "@/hooks/use-upload";
import { prepareLogoImage } from "@/utils/prepare-logo-image";
import {
  PUBLIC_IMAGE_ACCEPT,
  PUBLIC_IMAGE_NOTICE,
  publicImagePath,
} from "@/utils/public-image-upload";

export function CompanyLogo() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { isLoading, uploadFile } = useUpload();
  const { data } = useTeamQuery();
  const { mutate: updateTeam } = useTeamMutation();

  const handleUpload = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const { files } = evt.target;
    const selectedFile = files as FileList;

    const file = selectedFile[0];
    if (!file) return;
    setUploadError(null);
    try {
      const prepared = await prepareLogoImage(file);
      const { url } = await uploadFile({
        bucket: "avatars",
        path: publicImagePath(prepared, data?.id ?? "", "team-logo"),
        file: prepared,
      });

      if (url) {
        updateTeam({ logoUrl: url });
      }
    } catch {
      setUploadError(
        "Upload failed. Use a supported image up to 5 MiB and an owner account with a verified session.",
      );
    }
  };

  return (
    <Card>
      <div className="flex justify-between items-center pr-6">
        <CardHeader>
          <CardTitle>Company logo</CardTitle>
          <CardDescription>
            This is your company's logo. Click on the logo to upload a custom
            one from your files.
          </CardDescription>
        </CardHeader>

        <Avatar
          className="rounded-none w-16 h-16 flex items-center justify-center bg-accent cursor-pointer"
          onClick={() => inputRef?.current?.click()}
        >
          {isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <>
              <AvatarImage
                src={data?.logoUrl ?? undefined}
                alt={data?.name ?? undefined}
                width={64}
                height={64}
              />
              <AvatarFallback>
                <span className="text-md">{data?.name?.charAt(0)}</span>
              </AvatarFallback>
            </>
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
      </div>
      <CardFooter className="flex-col items-start gap-2">
        <p>{PUBLIC_IMAGE_NOTICE}</p>
        {uploadError && (
          <p role="alert" className="text-destructive">
            {uploadError}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
