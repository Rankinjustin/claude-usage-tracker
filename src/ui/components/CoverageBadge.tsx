import type { Coverage } from '../api';
import { plural } from '../format';

/**
 * Shows how many sessions may be missing history: a transcript file disappeared before all of it was read, so
 * the recorded rows are kept but the unread part was never seen. Transcripts Claude Code removed after they
 * were fully indexed are not counted; nothing from them is missing.
 */
export function CoverageBadge({ coverage }: { coverage: Coverage | null }) {
  if (!coverage || coverage.sessionsPartial === 0) return null;
  return (
    <span className="coverage" title="A transcript file was removed before all of it was read. What was recorded is kept; the rest was not seen.">
      {plural(coverage.sessionsPartial, 'partial session')}
    </span>
  );
}
