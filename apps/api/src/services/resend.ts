import { requireProductEmailTransport } from "@midday/email/config";
import { Resend } from "resend";

let client: Resend | undefined;
let clientKey: string | undefined;

export function getResend(): Resend {
  const apiKey = requireProductEmailTransport();
  if (client && clientKey === apiKey) return client;

  client = new Resend(apiKey);
  clientKey = apiKey;
  return client;
}

// Keep existing consumers lazy: importing unrelated routes must not require
// an email provider. Cache only a successfully constructed client.
export const resend = {
  get emails() {
    return getResend().emails;
  },
  get contacts() {
    return getResend().contacts;
  },
};
