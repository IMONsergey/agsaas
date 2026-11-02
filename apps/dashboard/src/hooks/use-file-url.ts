import { useMemo } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { authenticatedFileUrl } from "@/utils/authenticated-file-url";

type FileUrlOptions =
  | {
      type: "proxy" | "download";
      filePath: string;
      filename?: string;
    }
  | {
      type: "invoice";
      invoiceId: string;
      isReceipt?: boolean;
      preview?: boolean;
    }
  | {
      type: "url";
      url: string;
    };

/**
 * Hook to get an authenticated file URL with fileKey.
 * Handles both constructing URLs from file paths and adding fileKey to existing URLs.
 *
 * @param options - Either file path options or an existing URL
 * @returns Object with `url` (authenticated URL), `isLoading`, and `hasFileKey` state
 */
export function useFileUrl(options: FileUrlOptions | null) {
  const { data: user, isLoading } = useUserQuery();
  const fileKey =
    user?.fileKey && user.fileKeyExpiresAt && user.fileKeyExpiresAt > Date.now()
      ? user.fileKey
      : null;

  const result = useMemo(() => {
    if (!options) {
      return {
        url: null as string | null,
        isLoading,
        hasFileKey: !!fileKey,
      };
    }

    if (options.type === "url") {
      const url = authenticatedFileUrl(
        options.url,
        process.env.NEXT_PUBLIC_API_URL,
        fileKey,
      );
      return { url, isLoading, hasFileKey: !!url };
    }

    // For other types, we need fileKey
    if (!fileKey) {
      return {
        url: null as string | null,
        isLoading,
        hasFileKey: false,
      };
    }

    if (options.type === "invoice") {
      // Build invoice download URL
      const baseUrl = `${process.env.NEXT_PUBLIC_API_URL}/files/download/invoice`;
      const url = new URL(baseUrl);
      url.searchParams.set("id", options.invoiceId);
      url.searchParams.set("fk", fileKey);
      if (options.isReceipt) {
        url.searchParams.set("type", "receipt");
      }
      if (options.preview) {
        url.searchParams.set("preview", "true");
      }
      return {
        url: url.toString(),
        isLoading: false,
        hasFileKey: true,
      };
    }

    // Build URL from file path
    const { type, filePath, filename } = options;
    const endpointPath = type === "download" ? `${type}/file` : type;
    const baseUrl = `${process.env.NEXT_PUBLIC_API_URL}/files/${endpointPath}`;
    const url = new URL(baseUrl);

    if (type === "download") {
      url.searchParams.set("path", filePath);
      if (filename) {
        url.searchParams.set("filename", filename);
      }
    } else {
      url.searchParams.set("filePath", filePath);
    }

    url.searchParams.set("fk", fileKey);

    return {
      url: url.toString(),
      isLoading: false,
      hasFileKey: true,
    };
  }, [options, fileKey, isLoading]);

  return result;
}
