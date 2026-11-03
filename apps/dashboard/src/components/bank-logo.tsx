import { Avatar, AvatarFallback, AvatarImage } from "@midday/ui/avatar";
import { cn } from "@midday/ui/cn";
import { useState } from "react";

type Props = {
  src: string | null;
  alt: string;
  size?: number;
};

export function BankLogo({ src, alt, size = 34 }: Props) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showingFallback = !src || failedSource === src;

  return (
    <Avatar
      style={{ width: size, height: size }}
      className={cn(!showingFallback && "border border-border")}
    >
      {src && !showingFallback ? (
        <AvatarImage
          src={src}
          alt={alt}
          className="object-contain bg-white"
          onError={() => setFailedSource(src)}
        />
      ) : null}
      <AvatarFallback
        className="bg-muted text-xs font-medium"
        role="img"
        aria-label={alt}
      >
        {alt.trim().slice(0, 2).toUpperCase() || "B"}
      </AvatarFallback>
    </Avatar>
  );
}
