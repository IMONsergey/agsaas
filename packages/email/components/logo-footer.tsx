import { Link, Section, Text } from "@react-email/components";
import { getProductEmailConfig } from "../config";

export function LogoFooter() {
  const { appUrl, productName } = getProductEmailConfig();
  return (
    <Section>
      <Text>
        <Link href={appUrl}>{productName}</Link>
      </Text>
    </Section>
  );
}
