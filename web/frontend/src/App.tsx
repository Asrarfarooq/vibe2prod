import { usePathname } from "./lib/router";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectPage } from "./pages/ProjectPage";
import { RunPage } from "./pages/RunPage";
import { NotFound } from "./pages/NotFound";

const ID = "([A-Za-z0-9_-]{1,64})";
const PROJECT = new RegExp(`^/projects/${ID}/?$`);
const RUN = new RegExp(`^/projects/${ID}/runs/${ID}/?$`);

export function App() {
  const path = usePathname();
  if (path === "/" || path === "") return <ProjectsPage />;
  const p = PROJECT.exec(path);
  if (p) return <ProjectPage key={p[1]} id={p[1]} />;
  const r = RUN.exec(path);
  if (r) return <RunPage key={`${r[1]}/${r[2]}`} projectId={r[1]} id={r[2]} />;
  return <NotFound />;
}
