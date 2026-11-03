import { getPublicLogoUrl } from "../../../utils/logo";

type Props = {
  logo: string;
  customerName: string;
};

export function Logo({ logo, customerName }: Props) {
  const src = getPublicLogoUrl(logo);
  if (!src) return null;
  return (
    <div className="max-w-[300px]">
      <img
        src={src}
        alt={customerName}
        style={{
          height: 80,
          objectFit: "contain",
        }}
      />
    </div>
  );
}
