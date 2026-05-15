import { useState, useEffect, useCallback, useRef } from 'react';

interface UseResizablePaneOptions {
  id: string;
  initialSize: number;
  minSize?: number;
  maxSize?: number;
  direction?: 'horizontal' | 'vertical';
  reverse?: boolean;
}

export function useResizablePane({
  id,
  initialSize,
  minSize = 100,
  maxSize = 1200,
  direction = 'horizontal',
  reverse = false
}: UseResizablePaneOptions) {
  const [size, setSize] = useState(initialSize);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startPos: number; startSize: number } | null>(null);
  const latestSize = useRef(size);
  latestSize.current = size;

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(`c2c-resize-${id}`);
      if (stored && !isNaN(Number(stored))) {
        setSize(Number(stored));
      }
    } catch {
      // ignore
    }
  }, [id]);

  const saveSize = useCallback((newSize: number) => {
    setSize(newSize);
    try {
      sessionStorage.setItem(`c2c-resize-${id}`, String(newSize));
    } catch {
      // ignore
    }
  }, [id]);

  const startResize = useCallback((e: React.MouseEvent | React.TouchEvent | React.KeyboardEvent) => {
    if ('key' in e) {
      const step = 20;
      let isDecrease = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      let isIncrease = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      
      if (reverse) {
        isDecrease = e.key === 'ArrowRight' || e.key === 'ArrowDown';
        isIncrease = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      }

      if (isDecrease) {
        e.preventDefault();
        saveSize(Math.max(minSize, latestSize.current - step));
      } else if (isIncrease) {
        e.preventDefault();
        saveSize(Math.min(maxSize, latestSize.current + step));
      }
      return;
    }

    e.preventDefault();
    setIsResizing(true);
    const pos = 'touches' in e 
      ? (direction === 'horizontal' ? e.touches[0].clientX : e.touches[0].clientY)
      : (direction === 'horizontal' ? (e as React.MouseEvent).clientX : (e as React.MouseEvent).clientY);
    resizeRef.current = { startPos: pos, startSize: latestSize.current };
  }, [direction, minSize, maxSize, saveSize, reverse]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!resizeRef.current) return;
      const pos = 'touches' in e 
        ? (direction === 'horizontal' ? e.touches[0].clientX : e.touches[0].clientY)
        : (direction === 'horizontal' ? (e as MouseEvent).clientX : (e as MouseEvent).clientY);
      let delta = pos - resizeRef.current.startPos;
      if (reverse) delta = -delta;
      const newSize = Math.min(Math.max(resizeRef.current.startSize + delta, minSize), maxSize);
      setSize(newSize);
    };

    const handleUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove);
    window.addEventListener('touchend', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
    };
  }, [isResizing, minSize, maxSize, direction, reverse]);

  useEffect(() => {
    if (!isResizing && resizeRef.current) {
      try {
        sessionStorage.setItem(`c2c-resize-${id}`, String(latestSize.current));
      } catch {
        // ignore
      }
      resizeRef.current = null;
    }
  }, [isResizing, id]);

  return { size, minSize, maxSize, isResizing, startResize };
}
