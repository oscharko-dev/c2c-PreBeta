export const REVEAL_COBOL_EVENT = "c2c:reveal-cobol" as const;
export const REVEAL_JAVA_EVENT = "c2c:reveal-java" as const;

export interface RevealCobolDetail {
  cobolFile: string;
  cobolLine: number;
}

export interface RevealJavaDetail {
  javaFile: string;
  javaLine: number;
}

function dispatchRevealEvent<TDetail>(type: string, detail: TDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TDetail>(type, { detail }));
}

export function dispatchRevealCobol(detail: RevealCobolDetail): void {
  dispatchRevealEvent(REVEAL_COBOL_EVENT, detail);
}

export function dispatchRevealJava(detail: RevealJavaDetail): void {
  dispatchRevealEvent(REVEAL_JAVA_EVENT, detail);
}
