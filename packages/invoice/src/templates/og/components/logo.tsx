import { isInlineLogo } from "../../../utils/logo";

type Props = {
  src?: string | null;
  customerName: string;
};

export function Logo({ src, customerName }: Props) {
  if (!isInlineLogo(src)) return null;
  return <img src={src} alt={customerName} width={112} height={112} />;
}
