import { useTransformationRun } from "../../stores/transformationRun";

export function HarnessTimeline() {
  const { state } = useTransformationRun();

  if (state.events && state.events.events.length > 0) {
    return (
      <div className="flex flex-col p-4 space-y-4 overflow-y-auto">
        <h3 className="text-sm font-semibold text-neutral-200">
          Harness Event Timeline
        </h3>
        <div className="space-y-4 border-l border-neutral-700 ml-2 pl-4">
          {state.events.events.map((evt, idx) => (
            <div key={idx} className="flex flex-col text-sm relative">
              <div className="absolute w-2 h-2 rounded-full bg-neutral-500 -left-[21px] top-1.5" />
              <span className="text-neutral-500 text-xs">
                {evt.createdAt
                  ? new Date(evt.createdAt).toLocaleString()
                  : "Unknown time"}
              </span>
              <span className="font-medium text-neutral-300 flex items-center mt-1">
                {evt.type || "Unknown event"}
                <span className="ml-2 text-[10px] uppercase px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
                  {evt.status || "unknown"}
                </span>
              </span>
              {evt.message && (
                <span className="text-neutral-400 mt-1">{evt.message}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!state.harnessReady || state.harnessReady.status === "unavailable") {
    return (
      <div className="p-4 text-sm text-neutral-400">
        Harness unavailable. Evidence may be marked incomplete.
      </div>
    );
  }

  if (!state.events || state.events.events.length === 0) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        No harness events found for this run.
      </div>
    );
  }

  return null;
}
