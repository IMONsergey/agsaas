type Props = {
  developerName?: string | null;
  website?: string | null;
  redirectUri: string;
};

function safeWebsite(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function redirectDestination(value: string) {
  try {
    const url = new URL(value);
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return "Unavailable";
  }
}

/** Client names and familiar icons are not proof of developer identity. */
export function OAuthApplicationIdentity({
  developerName,
  website,
  redirectUri,
}: Props) {
  const name = developerName?.trim() || "Developer not provided";
  const href = safeWebsite(website);
  return (
    <span className="flex flex-col gap-2 text-[#878787] text-sm mb-8 break-all">
      <span>
        Developer (self-reported):{" "}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {name}
          </a>
        ) : (
          name
        )}
      </span>
      <span>Returns to {redirectDestination(redirectUri)}</span>
    </span>
  );
}
