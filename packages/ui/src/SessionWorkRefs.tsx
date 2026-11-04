import type { SessionWork, SessionWorkRef } from "@agent-console/shared/lineage";
import { openExternalTerminalUrl } from "./terminalLinks.ts";

export function SessionWorkRefs({ title, work }: { readonly title?: string | null; readonly work?: SessionWork | null }) {
  if (!work) return null;
  const inTitle = (ref: SessionWorkRef) => new RegExp(`#${ref.number}(?![A-Za-z0-9_])`).test(title ?? "");
  const program = work.program && !inTitle(work.program) ? [work.program] : [];
  const issues = work.issues.filter(ref => !inTitle(ref));
  const refs = [...program, ...issues.slice(0, 3)];
  const remaining = Math.max(0, issues.length - 3);
  if (!refs.length && !remaining) return null;
  return <span className="session-work-refs" onClick={event => event.stopPropagation()}>
    {refs.map((ref, index) => {
      const label = `${ref.repository.split("/").at(-1)}#${ref.number}`;
      const safeRepository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repository);
      const url = `https://github.com/${ref.repository}/issues/${ref.number}`;
      return ref.provider === "github" && safeRepository
        ? <a key={index} className="control-reference" href={url} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void openExternalTerminalUrl(url); }}>{label}</a>
        : <span key={index} className="control-reference">{label}</span>;
    })}
    {remaining ? <span>+{remaining}</span> : null}
  </span>;
}
