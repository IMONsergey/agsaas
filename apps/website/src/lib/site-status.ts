export type ProbeResult = {
  name: string;
  state: "available" | "degraded" | "unknown";
};
export type SiteStatus = { checkedAt: string; probes: ProbeResult[] };
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export async function checkSiteStatus(
  apiUrl: string,
  dashboardUrl: string,
  fetcher: Fetcher = fetch,
): Promise<SiteStatus> {
  const probes = await Promise.all([
    (async (): Promise<ProbeResult> => {
      try {
        const response = await fetcher(`${apiUrl}/health/ready`, {
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        const data = await response.json();
        return {
          name: "API dependencies",
          state:
            response.ok && data?.status === "ok" ? "available" : "degraded",
        };
      } catch {
        return { name: "API dependencies", state: "unknown" };
      }
    })(),
    (async (): Promise<ProbeResult> => {
      try {
        const response = await fetcher(`${dashboardUrl}/login`, {
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(4000),
        });
        return {
          name: "Workspace sign-in page",
          state: response.status === 200 ? "available" : "degraded",
        };
      } catch {
        return { name: "Workspace sign-in page", state: "unknown" };
      }
    })(),
  ]);
  return { checkedAt: new Date().toISOString(), probes };
}
