/** True only for the dashboard URL this tool itself builds; guards the shell-launched browser opener. */
export function isSafeDashboardUrl(url: string): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+\/\?key=[0-9a-f]+$/.test(url);
}
