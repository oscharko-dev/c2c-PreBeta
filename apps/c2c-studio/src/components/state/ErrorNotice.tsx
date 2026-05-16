import React from 'react';
import { W02UiErrorCode } from '../../types/api';
import { W02_ERROR_DESCRIPTIONS, W02_ERROR_LABELS } from '../run/agentActivity';

interface ErrorNoticeProps {
  message?: string;
  // Issue #173: when a W0.2 failure code is supplied, the notice renders the
  // closed-set label and explanation so users see why a run is blocked
  // instead of a generic message.
  failureCode?: W02UiErrorCode | null;
}

export function ErrorNotice({ message, failureCode }: ErrorNoticeProps) {
  if (failureCode) {
    return (
      <div
        className="p-3 mb-4 rounded border border-red-200 bg-red-100 text-red-800 text-sm"
        role="alert"
        data-testid="error-notice"
      >
        <div className="font-semibold">{W02_ERROR_LABELS[failureCode]}</div>
        <p className="mt-1 text-xs opacity-90">{W02_ERROR_DESCRIPTIONS[failureCode]}</p>
        {message && message !== W02_ERROR_DESCRIPTIONS[failureCode] ? (
          <p className="mt-1 font-mono text-[11px] opacity-80">{message}</p>
        ) : null}
        <p className="mt-1 font-mono text-[10px] opacity-60">code: {failureCode}</p>
      </div>
    );
  }

  return (
    <div
      className="p-3 mb-4 bg-red-100 text-red-800 border border-red-200 rounded text-sm"
      role="alert"
      data-testid="error-notice"
    >
      {message ?? 'An error occurred.'}
    </div>
  );
}
