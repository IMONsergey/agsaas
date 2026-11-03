import { DocumentationIndex } from "@/components/documentation-index";
import { InformationPage } from "@/components/information-page";
import { getDocsData } from "@/lib/docs";
export const metadata = { title: "Workspace guide" };
export default function Page() {
  return (
    <InformationPage
      title="Workspace guide"
      intro="Instructions for the workflows and capabilities of this AGSaaS installation."
    >
      <DocumentationIndex
        guides={getDocsData().map((doc) => ({
          slug: doc.slug,
          title: doc.metadata.title,
          description: doc.metadata.description,
        }))}
      />
    </InformationPage>
  );
}
