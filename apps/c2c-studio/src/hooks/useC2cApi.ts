import { useState, useEffect } from 'react';
import { apiClient } from '../lib/apiClient';
import { HealthResponse, ModeResponse } from '../types/api';

export function useC2cApi() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [mode, setMode] = useState<ModeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [healthResult, modeResult] = await Promise.all([
        apiClient.getHealth(),
        apiClient.getMode(),
      ]);

      if (!healthResult.ok) {
        setError(healthResult.message || 'Failed to load health');
      } else {
        setHealth(healthResult.data);
      }

      if (!modeResult.ok) {
        if (!error) setError(modeResult.message || 'Failed to load mode');
      } else {
        setMode(modeResult.data);
      }

      setLoading(false);
    }
    load();
  }, [error]);

  return { health, mode, error, loading };
}