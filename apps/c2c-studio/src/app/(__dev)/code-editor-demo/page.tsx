import { notFound } from "next/navigation";

import { CodeEditorDemoClient } from "./CodeEditorDemoClient";

export const dynamic = "force-dynamic";

export default function CodeEditorDemoPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <CodeEditorDemoClient />;
}
