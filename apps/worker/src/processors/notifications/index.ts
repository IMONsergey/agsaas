import { ActivityNotificationFlushProcessor } from "./activity-notification-flush";
import { NotificationProcessor } from "./notification";
import { ReconcileNotificationDispatchesProcessor } from "./reconcile-notification-dispatches";

/**
 * Export all notification processors (for type imports)
 */
export { ActivityNotificationFlushProcessor } from "./activity-notification-flush";
export { NotificationProcessor } from "./notification";

/**
 * Notification processor registry
 * Maps job names to processor instances
 */
export const notificationProcessors = {
  "activity-notification-flush": new ActivityNotificationFlushProcessor(),
  notification: new NotificationProcessor(),
  "reconcile-notification-dispatches":
    new ReconcileNotificationDispatchesProcessor(),
};
