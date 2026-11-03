"use client";

import { countries } from "@midday/location/countries-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { ComboboxDropdown } from "@midday/ui/combobox-dropdown";
import { useUserMutation, useUserQuery } from "@/hooks/use-user";
import { useI18n } from "@/locales/client";

export function LocaleSettings() {
  const t = useI18n();
  const { data: user } = useUserQuery();
  const updateUserMutation = useUserMutation();

  // A locale is a formatting choice, not a unique country identifier.
  // Several countries use "en"; choosing the first would display Anguilla.
  const localeNames = new Intl.DisplayNames(["en"], { type: "language" });
  const localeItems = [
    ...new Set([
      ...Object.values(countries).map((country) => country.default_locale),
      ...(user?.locale ? [user.locale] : []),
    ]),
  ]
    .map((locale) => ({
      id: locale,
      label: `${localeNames.of(locale) ?? locale} (${locale})`,
      value: locale,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <Card className="flex flex-col gap-4 sm:flex-row justify-between sm:items-center">
      <CardHeader>
        <CardTitle>{t("locale.title")}</CardTitle>
        <CardDescription>
          Choose how numbers and dates are formatted. This does not change your
          country or the interface language.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="w-[250px]">
          <ComboboxDropdown
            placeholder={t("locale.placeholder")}
            selectedItem={localeItems.find(
              (item) => item.value === user?.locale,
            )}
            searchPlaceholder={t("locale.searchPlaceholder")}
            items={localeItems}
            className="text-xs py-1"
            onSelect={(item) => {
              updateUserMutation.mutate({ locale: item.value });
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
