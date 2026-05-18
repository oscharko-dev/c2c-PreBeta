// Studio-IDE-4 (#245): map a generated-artifact file path to a Monaco
// language id. Used by GeneratedJavaEditorPane to drive syntax highlighting
// and to decide which artifacts open in editable mode (`java`) vs.
// readonly mode (everything else).
//
// The set of supported extensions intentionally covers the artifact kinds
// the BFF emits today (`.java`, `.json`, `.xml`, `.md`). Anything else
// falls through to `plaintext`, which Monaco renders without highlighting
// rather than refusing to mount.

export type GeneratedArtifactLanguage =
  | "java"
  | "json"
  | "xml"
  | "markdown"
  | "plaintext";

const EXTENSION_TO_LANGUAGE: Readonly<
  Record<string, GeneratedArtifactLanguage>
> = {
  java: "java",
  json: "json",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
};

export function detectLanguageFromPath(
  filePath: string | null | undefined,
): GeneratedArtifactLanguage {
  if (!filePath) {
    return "plaintext";
  }
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === basename.length - 1) {
    return "plaintext";
  }
  const ext = basename.slice(lastDot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

export function isEditableLanguage(
  language: GeneratedArtifactLanguage,
): boolean {
  return language === "java";
}
