import type { Coverage } from '../api';
import { plural } from '../format';

/**
 * Shows how many sessions may be missing history: their transcript file disappeared after it was indexed,
 * so the recorded rows are kept but anything written after that point was never seen.
 */
export function CoverageBadge({ coverage }: { coverage: Coverage | null }) {
  if (!coverage || coverage.sessionsPartial === 0) return null;
  return (
    <span className="coverage" title="A transcript file was removed after it was indexed. What was recorded is kept; later activity in it was not seen.">
      {plural(coverage.sessionsPartial, 'partial session')}
    </span>
  );
}
