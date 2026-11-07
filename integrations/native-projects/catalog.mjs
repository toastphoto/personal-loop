export function failure(code) {
  return Object.assign(new Error(code), { code });
}
export function projectKey(provider, host, nativeId) {
  return [provider, host, nativeId].map(encodeURIComponent).join(":");
}
const string = (value) => typeof value === "string" && value.length > 0;
export function safeError(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,70}$/.test(error.code)
    ? error.code
    : "PROVIDER_UNAVAILABLE";
}

export class ProjectCatalog {
  constructor(connectors, { host = "local" } = {}) {
    this.connectors = connectors;
    this.host = host;
    this.projects = new Map();
  }
  async readProvider(provider) {
    try {
      const backend = this.connectors[provider];
      if (!backend || !Object.hasOwn(this.connectors, provider)) throw failure("UNKNOWN_PROVIDER");
      const result = await backend.listProjects();
      if (!Array.isArray(result?.projects)) throw failure("INVALID_PROVIDER_RESPONSE");
      const found = new Set();
      const projects = result.projects.map((p) => {
        if (!string(p.nativeId) || !string(p.name)) throw failure("INVALID_PROJECT_IDENTITY");
        const host = p.host ?? this.host;
        const key = projectKey(provider, host, p.nativeId);
        if (found.has(key)) throw failure("DUPLICATE_PROJECT_IDENTITY");
        found.add(key);
        return {
          key,
          provider,
          host,
          nativeId: p.nativeId,
          name: p.name,
          roots: Array.isArray(p.roots) ? p.roots.filter(string) : [],
          capabilities: p.capabilities ?? { read: true, continue: false, cancel: false },
          ...(p.nativeState !== undefined ? { nativeState: p.nativeState } : {}),
        };
      });
      return {
        provider,
        status: "connected",
        complete: result.complete === true,
        observedAt: result.observedAt ?? new Date().toISOString(),
        projects,
      };
    } catch (error) {
      return { provider, status: "unavailable", complete: false, errorCode: safeError(error), projects: [] };
    }
  }
  async refresh() {
    const entries = await Promise.all(Object.keys(this.connectors).map((provider) => this.readProvider(provider)));
    this.projects.clear();
    for (const entry of entries) for (const project of entry.projects) this.projects.set(project.key, project);
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      complete: entries.length > 0 && entries.every((e) => e.complete),
      providers: entries.map(({ projects, ...entry }) => ({ ...entry, projectCount: projects.length })),
      projects: [...this.projects.values()],
    };
  }
  resolve(key) {
    const project = this.projects.get(key);
    if (!project) throw failure("PROJECT_NOT_AVAILABLE");
    return { project, backend: this.connectors[project.provider] };
  }
  async listWork(key) {
    const { project, backend } = this.resolve(key);
    const result = await backend.listWork(project.nativeId);
    if (!Array.isArray(result?.items)) throw failure("INVALID_PROVIDER_RESPONSE");
    const items = result.items.map((item) => {
      if (!string(item.nativeId)) throw failure("INVALID_TASK_IDENTITY");
      if (item.projectId != null && item.projectId !== project.nativeId) throw failure("PROJECT_MISMATCH");
      return { ...item, projectId: project.nativeId, projectKey: key, provider: project.provider };
    });
    return { items, complete: result.complete === true, observedAt: result.observedAt ?? new Date().toISOString() };
  }
  async readWork(key, nativeId) {
    const { project, backend } = this.resolve(key);
    const result = await backend.readWork(nativeId, { projectId: project.nativeId });
    if (result?.projectId !== project.nativeId) throw failure("PROJECT_MISMATCH");
    return { ...result, projectKey: key, provider: project.provider };
  }
  async close() {
    await Promise.allSettled(Object.values(this.connectors).map((c) => c.close?.()));
  }
}
