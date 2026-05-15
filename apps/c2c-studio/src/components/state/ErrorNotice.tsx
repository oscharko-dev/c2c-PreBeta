import React from 'react';

interface ErrorNoticeProps {
  message: string;
}

export function ErrorNotice({ message }: ErrorNoticeProps) {
  return (
    <div className="p-3 mb-4 bg-red-100 text-red-800 border border-red-200 rounded text-sm">
      {message}
    </div>
  );
}
