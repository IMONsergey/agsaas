import { getAppUrl } from "@midday/utils/envs";
import {
  Body,
  Container,
  Heading,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { Footer } from "../components/footer";
import { Logo } from "../components/logo";
import {
  Button,
  EmailThemeProvider,
  getEmailInlineStyles,
  getEmailThemeClasses,
} from "../components/theme";
import { getI18n } from "../locales";

interface Props {
  email?: string;
  invitedByEmail?: string;
  invitedByName?: string;
  teamName?: string;
  ip?: string;
  locale: string;
  appUrl?: string;
  productName?: string;
}

const baseAppUrl = getAppUrl();

export const InviteEmail = ({
  invitedByEmail = "bukinoshita@example.com",
  invitedByName = "Pontus Abrahamsson",
  email = "pontus@lostisland.co",
  teamName = "Acme Co",
  ip,
  locale = "en",
  appUrl = baseAppUrl,
  productName = "Midday",
}: Props) => {
  const { t } = getI18n({ locale });
  const inviteLink = `${appUrl}/teams`;
  const themeClasses = getEmailThemeClasses();
  const lightStyles = getEmailInlineStyles("light");

  return (
    <EmailThemeProvider
      preview={<Preview>{t("invite.preview", { teamName })}</Preview>}
    >
      <Body
        className={`my-auto mx-auto font-sans ${themeClasses.body}`}
        style={lightStyles.body}
      >
        <Container
          className={`my-[40px] mx-auto p-[20px] max-w-[600px] ${themeClasses.container}`}
          style={{
            borderStyle: "solid",
            borderWidth: 1,
            borderColor: lightStyles.container.borderColor,
          }}
        >
          {productName === "Midday" ? (
            <Logo />
          ) : (
            <Text className="text-[18px] font-semibold text-center">
              {productName}
            </Text>
          )}
          <Heading
            className={`font-serif mx-0 my-[30px] p-0 text-[24px] font-normal text-center ${themeClasses.heading}`}
            style={{ color: lightStyles.text.color }}
          >
            {t("invite.title1")} <strong>{teamName}</strong>{" "}
            {t("invite.title2")} <strong>{productName}</strong>
          </Heading>

          <Text
            className={`text-[14px] leading-[24px] ${themeClasses.text}`}
            style={{ color: lightStyles.text.color }}
          >
            {invitedByName} (
            <Link
              href={`mailto:${invitedByEmail}`}
              className={`no-underline ${themeClasses.link}`}
              style={{ color: lightStyles.text.color }}
            >
              {invitedByEmail}
            </Link>
            ) {t("invite.link1")} <strong>{teamName}</strong>{" "}
            {t("invite.link2")} <strong>{productName}</strong>.
          </Text>
          <Section className="mb-[42px] mt-[32px] text-center">
            <Button href={inviteLink}>{t("invite.join")}</Button>
          </Section>

          <Text
            className={`text-[14px] leading-[24px] break-all ${themeClasses.mutedText}`}
            style={{ color: lightStyles.mutedText.color }}
          >
            {t("invite.link3")}:{" "}
            <Link
              href={inviteLink}
              className={`underline ${themeClasses.mutedLink}`}
              style={{ color: lightStyles.mutedText.color }}
            >
              {inviteLink}
            </Link>
          </Text>

          <br />
          <Section>
            <Text
              className={`text-[12px] leading-[24px] ${themeClasses.mutedText}`}
              style={{ color: lightStyles.mutedText.color }}
            >
              {t("invite.footer1")}{" "}
              <span
                className={themeClasses.text}
                style={{ color: lightStyles.text.color }}
              >
                {email}
              </span>
              .{" "}
              {ip ? (
                <>
                  {t("invite.footer2")}{" "}
                  <span
                    className={themeClasses.text}
                    style={{ color: lightStyles.text.color }}
                  >
                    {ip}
                  </span>{" "}
                  .{" "}
                </>
              ) : null}
              {t("invite.footer4")}
            </Text>
          </Section>

          <br />

          {productName === "Midday" ? (
            <Footer />
          ) : (
            <Text className="text-[12px] text-center">{productName}</Text>
          )}
        </Container>
      </Body>
    </EmailThemeProvider>
  );
};

export default InviteEmail;
