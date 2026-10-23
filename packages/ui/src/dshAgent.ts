// DSH runs as its own `dsh` agent kind, reached only through a daemon launch
// profile. The retired `hermes` base kind is not DSH: a session or profile still
// recorded on it is treated like any other unknown agent.
export function isDshAgent(agent: string | null | undefined): boolean {
  return agent === "dsh";
}
