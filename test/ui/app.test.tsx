// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/ui/App';

// ---- fixtures (shapes follow src/query/views.ts) ----

const parts = (cost: Record<string, number>) => ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'thinking',
  'advisor'].map((key) => ({ key, tokens: 1000, cost: cost[key] ?? 0, pct: 0 }));

const overviewData = (over: Record<string, unknown> = {}) => ({
  total: 137.2, prevTotal: 100, tokens: 9_800_000, calls: 1551, unpricedCalls: 0, sessions: 13, prompts: 118,
  cacheHitPct: 94, parts: parts({ cacheRead: 40, cacheWrite1h: 60, output: 37.2 }),
  daily: [{ day: '2026-11-12', cost: 60, parts: {} }, { day: '2026-11-13', cost: 77.2, parts: {} }],
  heat: [{ weekday: 4, hour: 14, cost: 20 }], subagentPct: 28, mainAvgCtx: 90000,
  takeaway: 'Cache reads and writes were 73% of spend.', ...over,
});

const coverageData = (over: Record<string, unknown> = {}) => ({
  installedAt: '2026-11-10T09:00:00.000Z', sessionsComplete: 10, sessionsPartial: 0, filesMissingBeforeIndexed: 0,
  backfillProgress: { done: 40, total: 40, startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:02:00.000Z' },
  ...over,
});

const PROMPT_TEXT = 'Can you perform a code review on my ballpark manager app?';

const promptsData = [
  { uuid: 'u1', sessionId: 's1', sessionTitle: 'Ballpark manager', ts: '2026-11-12T14:27:00.000Z', text: PROMPT_TEXT,
    cost: 1.41, agentCost: 5.86, total: 7.27, calls: 49, durationMs: 2_472_000, multipleOfMedian: 4.1 },
  { uuid: 'u2', sessionId: 's1', sessionTitle: 'Ballpark manager', ts: '2026-11-12T15:00:00.000Z', text: 'What are you doing?',
    cost: 0.5, agentCost: 0, total: 0.5, calls: 3, durationMs: 20_000, multipleOfMedian: 0.3 },
];

const sessionsData = [
  { id: 's1', title: 'Ballpark manager', project: 'C:\\Users\\someone\\ballpark', start: '2026-11-12T14:00:00.000Z',
    durationMin: 95, calls: 120, cost: 12.5, agentCost: 5.86, peakCtx: 180000, startCtx: 20000, compactions: 1,
    models: ['opus-5-5'] },
];

const agentsData = [
  { type: 'main', kind: 'main', runs: 13, calls: 900, cost: 98.5, pct: 72, perRun: 7.5, avgCtx: 90000,
    avgDurationMs: 0, errorRate: 0, sparkline: [], flaggedRuns: 0 },
  { type: 'general-purpose', kind: 'built-in', runs: 22, calls: 300, cost: 31.11, pct: 22, perRun: 1.41,
    avgCtx: 117000, avgDurationMs: 540000, errorRate: 0, sparkline: [1, 1.2, 0.9, 6.8, 1.1], flaggedRuns: 1 },
  { type: 'cet-test-runner', kind: 'custom', runs: 15, calls: 60, cost: 0.07, pct: 0.1, perRun: 0.005,
    avgCtx: 28000, avgDurationMs: 60000, errorRate: 0, sparkline: [0.005, 0.004], flaggedRuns: 0 },
];

const runRow = { id: 'r1', agentType: 'general-purpose', description: 'Review ballpark manager', start: '2026-11-12T14:40:00.000Z',
  durationMs: 1_020_000, cost: 3.12, calls: 11, promptUuid: 'u1', promptText: PROMPT_TEXT, flagged: true };

const agentDetailData = { stats: agentsData[1], runs: [runRow], medianCost: 1.2 };

const promptDetailData = {
  prompt: promptsData[0],
  summary: { cost: 1.41, agentCost: 5.86, durationMs: 2_472_000, tokens: 9_800_000, cacheReadPct: 94, apiCalls: 49,
    advisorCalls: 2, toolCalls: 112, failed: 6, denied: 1 },
  parts: parts({ cacheRead: 1.84, cacheWrite1h: 3.3, output: 2.02, advisor: 0.11 }).map(({ pct, ...p }) => p),
  byPart: [{ label: 'general-purpose', cost: 5.86 }, { label: 'Main thread', cost: 1.41 }],
  runs: [runRow],
  tools: [{ label: 'Read', calls: 61, failed: 0 }, { label: 'Bash', calls: 15, failed: 6 }],
};

// ---- fetch and EventSource mocks ----

let routes: Record<string, () => unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close(): void { /* nothing */ }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function apiPath(url: string): string {
  return new URL(url, 'http://127.0.0.1').pathname.replace(/^\/api\//, '');
}

function calls(path: string): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => apiPath(u) === path);
}

beforeEach(() => {
  routes = {
    overview: () => overviewData(),
    coverage: () => coverageData(),
    sessions: () => sessionsData,
    prompts: () => promptsData,
    agents: () => agentsData,
    'agents/general-purpose': () => agentDetailData,
    'prompts/u1': () => promptDetailData,
  };
  fetchMock = vi.fn(async (url: string) => {
    const route = routes[decodeURIComponent(apiPath(url))];
    if (!route) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(route()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('dashboard', () => {
  it('sidebar marks active view from hash', async () => {
    window.location.hash = '#sessions';
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Views' });
    const link = within(nav).getByRole('link', { name: /Sessions/ });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: /Overview/ }).getAttribute('aria-current')).toBeNull();
    const tools = within(nav).getByText('Tools').closest('[aria-disabled]');
    expect(tools?.getAttribute('aria-disabled')).toBe('true');
    expect(within(nav).getAllByText('coming soon').length).toBe(4);
  });

  it('range control refetches with new range', async () => {
    window.location.hash = '#overview';
    render(<App />);
    await waitFor(() => expect(calls('overview').some((u) => u.includes('range=week'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(calls('overview').some((u) => u.includes('range=month'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Month' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking a tile opens detail panel with its id in hash', async () => {
    window.location.hash = '#agents';
    render(<App />);
    const tile = await screen.findByRole('link', { name: /general-purpose/ });
    expect(screen.queryByRole('link', { name: /^main/ })).toBeNull();
    fireEvent.click(tile);
    await waitFor(() => expect(window.location.hash).toBe('#agents/general-purpose'));
    const panel = await screen.findByRole('complementary', { name: 'Detail' });
    await within(panel).findByText('Cost per run');
    expect(within(panel).getByRole('img', { name: /Cost per run/ })).toBeTruthy();
  });

  it('hide text masks prompt text', async () => {
    window.location.hash = '#prompts';
    render(<App />);
    await screen.findAllByText(PROMPT_TEXT);
    fireEvent.click(screen.getByRole('button', { name: /Hide text/ }));
    await waitFor(() => expect(screen.queryAllByText(PROMPT_TEXT).length).toBe(0));
    expect(screen.getAllByText('•••').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Ballpark manager').length).toBe(0);
    expect(localStorage.getItem('tt.hideText')).toBe('1');
  });

  it('prompt detail shows total = main + agents', async () => {
    window.location.hash = '#prompts/u1';
    render(<App />);
    const panel = await screen.findByRole('complementary', { name: 'Detail' });
    const total = await within(panel).findByTestId('prompt-total');
    expect(total.textContent).toBe('$7.27');
    expect(within(panel).getByText('$1.41 main + $5.86 agents')).toBeTruthy();
  });

  it('live event refetches current view', async () => {
    window.location.hash = '#sessions';
    render(<App />);
    await screen.findAllByText('Ballpark manager');
    const before = calls('sessions').length;
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');
    act(() => FakeEventSource.instances[0]!.emit({ changed: ['s1'] }));
    act(() => FakeEventSource.instances[0]!.emit({ changed: ['s2'] }));
    // Updates are coalesced: two events inside the window give one refetch, about a second later.
    await waitFor(() => expect(calls('sessions').length).toBe(before + 1), { timeout: 3000 });
    await new Promise((res) => setTimeout(res, 1200));
    expect(calls('sessions').length).toBe(before + 1);
  });

  it('coverage badge shows partial sessions count', async () => {
    routes.coverage = () => coverageData({ sessionsPartial: 3 });
    window.location.hash = '#overview';
    render(<App />);
    expect(await screen.findByText('3 partial sessions')).toBeTruthy();
  });

  it('empty store shows a designed empty state with backfill progress', async () => {
    routes.overview = () => overviewData({ total: 0, prevTotal: 0, tokens: 0, calls: 0, sessions: 0, prompts: 0,
      daily: [], heat: [], parts: parts({}), takeaway: 'No usage recorded yet.' });
    routes.coverage = () => coverageData({ sessionsComplete: 0, installedAt: null,
      backfillProgress: { done: 12, total: 40, startedAt: new Date().toISOString() } });
    window.location.hash = '#overview';
    render(<App />);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByText(/12 of 40/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Daily spend/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Month' })).toBeTruthy();
  });

  it('dead backfill does not lock the dashboard', async () => {
    const intervals = vi.spyOn(window, 'setInterval');
    routes.overview = () => overviewData({ total: 0, calls: 0, daily: [], heat: [], parts: parts({}),
      takeaway: 'No usage in this period.' });
    routes.coverage = () => coverageData({ backfillProgress: { done: 3, total: 40,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } });
    window.location.hash = '#overview';
    render(<App />);
    expect(await screen.findByText(/No usage in this period\./)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/Reading your Claude Code history/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Month' })).toBeTruthy();
    expect(intervals.mock.calls.some((c) => c[1] === 3000)).toBe(false);
  });

  it('range control stays usable during a backfill', async () => {
    routes.coverage = () => coverageData({ backfillProgress: { done: 12, total: 40, startedAt: new Date().toISOString() } });
    window.location.hash = '#overview';
    render(<App />);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(await screen.findByRole('img', { name: /Daily spend/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(calls('overview').some((u) => u.includes('range=month'))).toBe(true));
  });

  it('unmount closes the event stream and stops backfill polling', async () => {
    const close = vi.spyOn(FakeEventSource.prototype, 'close');
    const clear = vi.spyOn(window, 'clearInterval');
    routes.coverage = () => coverageData({ backfillProgress: { done: 1, total: 40, startedAt: new Date().toISOString() } });
    window.location.hash = '#overview';
    const view = render(<App />);
    await screen.findByRole('progressbar');
    view.unmount();
    expect(close).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });
});
