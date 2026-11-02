import { requireProductEmailTransport } from "@midday/email/config";
import { Resend } from "resend";

let client: Resend | undefined;
let clientKey: string | undefined;
function provider(): Resend {
  const key = requireProductEmailTransport();
  if (!client || clientKey !== key) {
    client = new Resend(key);
    clientKey = key;
  }
  return client;
}
export const resend = {
  get emails() {
    return provider().emails;
  },
  get batch() {
    return provider().batch;
  },
  get contacts() {
    return provider().contacts;
  },
};
