'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '../lib/apiClient';
import { Sample } from '../types/reference-program';

export function useReferencePrograms() {
  const [programs, setPrograms] = useState<Sample[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    
    async function loadPrograms() {
      setIsLoading(true);
      setError(null);
      const result = await apiClient.getSamples();
      
      if (!mounted) return;
      
      if (result.ok) {
        setPrograms(result.data);
      } else {
        setError(result.message);
      }
      setIsLoading(false);
    }
    
    loadPrograms();
    return () => {
      mounted = false;
    };
  }, []);

  return { programs, isLoading, error };
}
