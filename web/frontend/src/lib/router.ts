import { useEffect, useState } from "react";

export function navigate(to: string, opts?: { replace?: boolean }): void {
  if (to === window.location.pathname) return;
  if (opts?.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function usePathname(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

export const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
export const runPath = (projectId: string, runId: string) => `${projectPath(projectId)}/runs/${encodeURIComponent(runId)}`;
