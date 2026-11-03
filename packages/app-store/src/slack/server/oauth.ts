export const getInstallUrl = ({ state }: { state: string }) => {
  const SLACK_OAUTH_REDIRECT_URL = process.env.SLACK_OAUTH_REDIRECT_URL;
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Slack OAuth is not configured");
  if (!SLACK_OAUTH_REDIRECT_URL) {
    throw new Error("SLACK_OAUTH_REDIRECT_URL is required");
  }

  const scopes = [
      "app_mentions:read", // Required for @mentions that start assistant threads
      "assistant:write", // Required for Slack assistant status and titles
      "incoming-webhook", // Fallback for private channels when bot can't post
      "chat:write", // Required for posting messages
      "chat:write.public", // Required for posting to public channels
      "groups:history", // Required for message.groups event subscription and to read messages in private channels
      "groups:read", // Required for private channel metadata
      "channels:history", // Required for message.channels event subscription and to read messages in public channels
      "channels:read", // Required for public channel metadata
      "channels:join", // Required to auto-join public channels to receive message events
      "files:read", // Required to download files via url_private_download URLs
      "im:history", // Required for direct-message assistant chats
      "im:read", // Required for DM metadata
      "mpim:history", // Required for multi-person DM assistant chats
      "mpim:read", // Required for MPIM metadata
      "reactions:read", // Required to react to and inspect thread state
      "reactions:write", // Required to add/remove emoji reactions to messages
      "users:read", // Required for views.publish to publish App Home views
  ];
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({ client_id: clientId, scope: scopes.join(","), redirect_uri: SLACK_OAUTH_REDIRECT_URL, state }).toString();
  return url.toString();
};
