/** URLs belong to this installation. No request may fall back to an upstream service. */
export function getAppUrl() {
  return (
    process.env.DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "http://localhost:3001")
  );
}

export function getEmailUrl() {
  return process.env.EMAIL_URL || getAppUrl();
}

export function getCdnUrl() {
  return process.env.CDN_URL || getAppUrl();
}

export function getApiUrl() {
  return (
    process.env.API_URL ||
    process.env.MIDDAY_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:3003"
  );
}
