import { InformationPage } from "@/components/information-page";
export const metadata = { title: "Terms of use" };
export const dynamic = "force-dynamic";
export default function Page() {
  const text = process.env.AGSAAS_TERMS_TEXT?.trim();
  const operator = process.env.AGSAAS_OPERATOR_NAME?.trim();
  const contact = process.env.AGSAAS_OPERATOR_CONTACT?.trim();
  return (
    <InformationPage title="Terms of use">
      {text && operator && contact ? (
        <>
          <p>Operator: {operator}</p>
          <p>Contact: {contact}</p>
          <div className="whitespace-pre-wrap">{text}</div>
        </>
      ) : (
        <>
          <p>
            The operator has not published the approved terms of use for this
            installation.
          </p>
          <p>
            Public commercial signup is not offered. Existing invited users
            should contact their workspace administrator for the applicable
            agreement, data handling information and support contact.
          </p>
          <p>
            This page does not apply the terms or privacy commitments of Midday
            Labs AB to AGSaaS.
          </p>
        </>
      )}
    </InformationPage>
  );
}
