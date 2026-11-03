import { ImageResponse } from "next/og";
export const runtime = "nodejs";
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const title = (params.get("title") || "AGSaaS").slice(0, 160);
  const description = (
    params.get("description") || "Your business workspace"
  ).slice(0, 240);
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: 64,
        background: "#151a23",
        color: "#fff",
      }}
    >
      <div style={{ display: "flex", fontSize: 32 }}>AGSaaS</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", fontSize: 64 }}>{title}</div>
        <div style={{ display: "flex", fontSize: 28, color: "#b8bec7" }}>
          {description}
        </div>
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
