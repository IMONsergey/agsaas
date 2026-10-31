import { Resend } from "resend";

let client: Resend | undefined;

export function getResend(): Resend {
  if (client) return client;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required for email operations");
  }

  client = new Resend(apiKey);
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
