import { Section, Text } from "@react-email/components";
import { getProductEmailConfig } from "../config";

/** Text identity does not contact an upstream CDN when a recipient opens mail. */
export function Logo() {
  const { productName } = getProductEmailConfig();
  return (
    <Section className="mt-[32px]">
      <Text className="text-[20px] font-semibold text-center">
        {productName}
      </Text>
    </Section>
  );
}
