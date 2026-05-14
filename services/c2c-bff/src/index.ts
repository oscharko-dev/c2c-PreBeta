import { loadConfig } from './config';
import { startServer } from './server';

function main(): void {
  const config = loadConfig();
  startServer({ config });
  const upstreamSummary = [
    `orchestrator=${config.orchestratorUrl ? config.orchestratorUrl : 'mock'}`,
    `evidence=${config.evidenceUrl ? config.evidenceUrl : 'mock'}`,
  ].join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `[c2c-bff] listening on http://localhost:${config.port} (${upstreamSummary}, repoRoot=${config.repoRoot}, staticRoot=${config.staticRoot})`,
  );
}

main();
