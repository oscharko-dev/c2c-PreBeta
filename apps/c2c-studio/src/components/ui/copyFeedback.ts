'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export async function copyToClipboard(value: string): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.clipboard === 'undefined' ||
    typeof navigator.clipboard.writeText !== 'function'
  ) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function useCopyFeedback(resetDelayMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const showCopied = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }

    setCopied(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setCopied(false);
    }, resetDelayMs);
  }, [resetDelayMs]);

  return { copied, showCopied };
}
