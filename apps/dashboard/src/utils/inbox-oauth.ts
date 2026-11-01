import { getAccessToken } from "@/utils/session";

export type InboxOAuthInput = {
  provider: "gmail" | "outlook";
  redirectPath?: string;
};

/** A credentialed REST response sets the API host's HttpOnly callback nonce. */
export async function getInboxOAuthUrl(
  input: InboxOAuthInput,
): Promise<string> {
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in to connect an inbox account");
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/apps/${input.provider}/install-url`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "inbox",
        redirectPath: input.redirectPath,
      }),
    },
  );
  if (!response.ok) throw new Error("Unable to start inbox connection");
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("url" in data) ||
    typeof data.url !== "string"
  ) {
    throw new Error("Unable to start inbox connection");
  }
  try {
    if (new URL(data.url).protocol !== "https:") throw new Error();
  } catch {
    throw new Error("Unable to start inbox connection");
  }
  return data.url;
}
