'use client';

import { useC2cApi } from '../../hooks/useC2cApi';

export function StudioShell() {
  const { health, mode, error, loading } = useC2cApi();

  if (loading) {
    return <div className="p-4">Loading C2C Studio...</div>;
  }

  if (error || !health || health.status !== 'ok') {
    return (
      <div className="p-4 border-l-4 border-red-500 bg-red-50 text-red-900">
        <h2 className="font-bold">Backend Unavailable</h2>
        <p>Transformation actions disabled.</p>
        {error && <p className="text-sm mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 text-white p-4 flex justify-between items-center">
        <h1 className="text-xl font-bold">c2c Transformation Studio</h1>
        <div className="text-sm">
          Status: <span className="text-green-400">Connected</span>
        </div>
      </header>
      <main className="flex-1 p-4">
        <h2 className="text-lg font-semibold mb-4">Mode Information</h2>
        <pre className="bg-gray-100 p-4 rounded text-sm overflow-auto">
          {JSON.stringify(mode, null, 2)}
        </pre>
      </main>
    </div>
  );
}