import { Section } from "@react-email/components";
import { getProductEmailConfig } from "../config";
import { Button } from "./theme";

export function GetStarted() {
  return (
    <Section className="text-center mt-[50px] mb-[50px]">
      <Button href={getProductEmailConfig().appUrl}>Get started</Button>
    </Section>
  );
}
