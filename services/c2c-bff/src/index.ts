import { loadConfig } from './config';
import { startServer } from './server';

function main(): void {
  const config = loadConfig();
  startServer({ config });
  const upstreamSummary = [
    `orchestrator=${config.orchestratorUrl ? config.orchestratorUrl : 'unset'}`,
    `evidence=${config.evidenceUrl ? config.evidenceUrl : 'unset'}`,
    `diagnosticFixtures=${config.enableDiagnosticFixtures ? 'enabled' : 'disabled'}`,
  ].join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `[c2c-bff] listening on http://localhost:${config.port} (${upstreamSummary}, repoRoot=${config.repoRoot}, staticRoot=${config.staticRoot})`,
  );
}

main();
