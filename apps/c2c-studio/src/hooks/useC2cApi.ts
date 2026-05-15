import { useEffect, useState } from 'react';
import { apiClient } from '../lib/apiClient';
import { ApiErrorKind, HealthResponse, ModeResponse } from '../types/api';

type StudioErrorKind = ApiErrorKind | 'backend';

export interface StudioApiState {
  health: HealthResponse | null;
  mode: ModeResponse | null;
  error: string | null;
  errorKind: StudioErrorKind | null;
  loading: boolean;
}

const initialState: StudioApiState = {
  health: null,
  mode: null,
  error: null,
  errorKind: null,
  loading: true,
};

export function useC2cApi(): StudioApiState {
  const [state, setState] = useState<StudioApiState>(initialState);

  useEffect(() => {
    let active = true;

    async function load() {
      const healthResult = await apiClient.getHealth();

      if (!active) {
        return;
      }

      if (!healthResult.ok) {
        setState({
          health: null,
          mode: null,
          loading: false,
          error: healthResult.message,
          errorKind: healthResult.details?.kind ?? 'backend',
        });
        return;
      }

      const modeResult = await apiClient.getMode();

      if (!active) {
        return;
      }

      if (!modeResult.ok) {
        setState({
          health: healthResult.data,
          mode: null,
          loading: false,
          error: modeResult.message,
          errorKind: modeResult.details?.kind ?? 'backend',
        });
        return;
      }

      setState({
        health: healthResult.data,
        mode: modeResult.data,
        loading: false,
        error: null,
        errorKind: null,
      });
    }

    void load();

    return () => {
      active = false;
    };
  }, []);

  return state;
}
