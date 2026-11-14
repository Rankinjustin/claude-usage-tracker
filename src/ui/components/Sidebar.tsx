import { useState, type ReactNode } from 'react';
import type { Coverage, Overview } from '../api';
import { count, day, money } from '../format';
import { href, onLinkClick, type ViewName } from '../router';
import { CoverageBadge } from './CoverageBadge';
import { HideTextToggle } from './HideTextToggle';

const ICONS: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  sessions: <path d="M4 6h16M4 12h16M4 18h10" />,
  prompts: <path d="M5 5h14v10H9l-4 4z" />,
  agents: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1-4 4-6 7-6s6 2 7 6" /></>,
  tools: <path d="M14 6l4 4-8 8H6v-4z" />,
  models: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />,
  history: <path d="M3 17l5-5 4 3 8-8" />,
  savings: <><path d="M12 4l9 16H3z" /><path d="M12 10v4" /></>,
};

const Icon = ({ name }: { name: string }) => <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="9" width="2.5" height="5" rx="1" fill="#1d1a16" /><rect x="6.75" y="5" width="2.5" height="9" rx="1" fill="#1d1a16" /><rect x="11.5" y="2" width="2.5" height="12" rx="1" fill="#1d1a16" /></svg>
    </div>
  );
}

type Theme = 'system' | 'dark' | 'light';

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem('tt.theme');
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch { return 'system'; }
}

/** Applies the stored theme to <html>; "system" removes the attribute so prefers-color-scheme decides. */
export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const pick = (t: Theme): void => {
    setTheme(t);
    applyTheme(t);
    try {
      if (t === 'system') localStorage.removeItem('tt.theme'); else localStorage.setItem('tt.theme', t);
    } catch { /* storage blocked: applies to this page only */ }
  };
  return (
    <div className="mini-seg" role="group" aria-label="Theme">
      {(['system', 'dark', 'light'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => pick(t)}
          title={t === 'system' ? 'Follow the system setting' : undefined}>
          {t === 'system' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light'}
        </button>
      ))}
    </div>
  );
}

const STAGE3 = [['tools', 'Tools'], ['models', 'Models & effort'], ['history', 'History'], ['savings', 'Savings & alerts']];

export function Sidebar({ view, overview, todayTotal, coverage, live }: {
  view: ViewName; overview: Overview | null; todayTotal: number | null; coverage: Coverage | null; live: boolean;
}) {
  const agentSpend = overview ? (overview.total * overview.subagentPct) / 100 : null;
  const items: [ViewName, string, string | null][] = [
    ['overview', 'Overview', overview ? money(overview.total) : null],
    ['sessions', 'Sessions', overview ? count(overview.sessions) : null],
    ['prompts', 'Prompts', overview ? count(overview.prompts) : null],
    ['agents', 'Agents & skills', agentSpend !== null ? money(agentSpend) : null],
  ];
  return (
    <aside className="side">
      <div className="brand"><BrandMark />Token Tracker</div>
      <nav className="nav" aria-label="Views">
        {items.map(([key, label, amt]) => (
          <a key={key} href={href(key)} aria-current={view === key ? 'page' : undefined} onClick={onLinkClick}>
            <Icon name={key} />{label}{amt !== null && <span className="amt num">{amt}</span>}
          </a>
        ))}
        <div className="nav-sep" role="presentation" />
        {STAGE3.map(([key, label]) => (
          <span key={key} className="off" aria-disabled="true">
            <Icon name={key!} />{label}<span className="soon">coming soon</span>
          </span>
        ))}
      </nav>
      <div className="side-foot">
        <div className="status">
          <span className={`live${live ? '' : ' paused'}`}><i />{live ? 'Recording' : 'Reconnecting'}</span><br />
          {coverage?.installedAt && <>Since {day(coverage.installedAt)}<br /></>}
          {todayTotal !== null && <>Today so far: <b className="num">{money(todayTotal)}</b></>}
        </div>
        <CoverageBadge coverage={coverage} />
        <div className="switches">
          <HideTextToggle />
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
