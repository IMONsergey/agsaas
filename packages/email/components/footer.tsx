import { Hr, Link, Section, Text } from "@react-email/components";
import { getProductEmailConfig } from "../config";
import { getEmailInlineStyles, getEmailThemeClasses } from "./theme";

export function Footer() {
  const config = getProductEmailConfig();
  const themeClasses = getEmailThemeClasses();
  const styles = getEmailInlineStyles("light");
  return (
    <Section className="w-full">
      <Hr
        className={themeClasses.border}
        style={{ borderColor: styles.container.borderColor }}
      />
      <Text
        className={`text-[13px] leading-relaxed ${themeClasses.mutedText}`}
        style={{ color: styles.mutedText.color }}
      >
        <Link href={config.appUrl} style={{ color: styles.mutedText.color }}>
          {config.productName}
        </Link>
        {" · "}
        <Link
          href={`${config.appUrl}/settings/notifications`}
          style={{ color: styles.mutedText.color }}
        >
          Notification settings
        </Link>
      </Text>
    </Section>
  );
}
