import type { Metadata } from "next";
import { Suspense } from "react";
import { NotificationDeliveryStatus } from "@/components/notification-delivery-status";
import { NotificationsSettingsList } from "@/components/notifications-settings-list";

export const metadata: Metadata = {
  title: "Notifications | AGSaaS",
};

export default async function Notifications() {
  return (
    <div className="space-y-6">
      <Suspense>
        <NotificationsSettingsList />
      </Suspense>
      <NotificationDeliveryStatus />
    </div>
  );
}
