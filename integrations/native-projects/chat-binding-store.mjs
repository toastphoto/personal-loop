// Only explicit, live-verified owner choices can replace the chat used for a future goal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { failure } from "./catalog.mjs";
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clean = (v) => typeof v === "string" && v.trim() && !/[\p{Cc}\p{Cf}]/u.test(v);
const iso = (seconds) =>
  Number.isFinite(seconds) && Number.isFinite(new Date(seconds * 1000).getTime())
    ? new Date(seconds * 1000).toISOString()
    : null;

function projectScope(cfg, key) {
  const m = cfg.managedCodex,
    root = m?.projectRoots?.[key];
  if (
    m?.enabled !== true ||
    !m.coordinatorProjectKeys?.includes(key) ||
    typeof key !== "string" ||
    !key.startsWith("codex:local:") ||
    cfg.providers?.codex?.enabled === false ||
    !Object.hasOwn(cfg.providers ?? {}, "codex") ||
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root
  )
    throw failure("CHAT_PICKER_UNAVAILABLE");
  const projectId = decodeURIComponent(key.slice("codex:local:".length));
  if (!clean(projectId) || key !== "codex:local:" + encodeURIComponent(projectId))
    throw failure("CHAT_PICKER_INVALID_PROJECT");
  return { root, projectId };
}
function checkStored(key, s) {
  if (
    !record(s) ||
    !uuid.test(s.threadId) ||
    !clean(s.title) ||
    s.title.length > 160 ||
    !path.isAbsolute(s.root ?? "") ||
    key !== "codex:local:" + encodeURIComponent(s.projectId) ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 1 ||
    !Number.isFinite(Date.parse(s.updatedAt))
  )
    throw failure("INVALID_CHAT_BINDING_STATE");
  return s;
}
export function effectiveBoundChats(base = {}, data) {
  const choices = data.chatBindings;
  if (choices !== undefined && !record(choices)) throw failure("INVALID_CHAT_BINDING_STATE");
  if (!choices) return base;
  const result = { ...base };
  for (const [key, stored] of Object.entries(choices)) {
    const { threadId, projectId, root } = checkStored(key, stored);
    result[key] = { threadId, projectId, root };
  }
  return result;
}
function desktopEntry(t, scope) {
  if (
    !t ||
    !uuid.test(t.id) ||
    t.cwd !== scope.root ||
    (t.projectId !== null && t.projectId !== scope.projectId) ||
    t.ephemeral !== false ||
    t.archived === true ||
    t.source !== "vscode" ||
    t.originator !== "Codex Desktop" ||
    t.threadSource ||
    t.parentThreadId ||
    t.agentRole ||
    t.agentNickname ||
    !clean(t.name) ||
    t.name.length > 160
  )
    return null;
  return { threadId: t.id, title: t.name, updatedAt: iso(t.updatedAt), createdAt: iso(t.createdAt) };
}
export class ChatBindingStore {
  constructor({ configFile, controls, catalog }) {
    Object.assign(this, { configFile, controls, catalog });
  }
  config() {
    return JSON.parse(readFileSync(this.configFile, "utf8"));
  }
  available(projectKey) {
    try {
      projectScope(this.config(), projectKey);
      return !!this.catalog.connectors?.codex;
    } catch {
      return false;
    }
  }
  current(projectKey, { cfg = this.config(), data = this.controls.read() } = {}) {
    const initial = cfg.managedCodex?.boundChats?.[projectKey],
      saved = data.chatBindings?.[projectKey];
    if (saved) {
      const val = checkStored(projectKey, saved);
      return { threadId: val.threadId, title: val.title, revision: val.revision, updatedAt: val.updatedAt };
    }
    return initial && uuid.test(initial.threadId)
      ? { threadId: initial.threadId, title: initial.title ?? null, revision: 0 }
      : null;
  }
  async directory(key, scope) {
    const backend = this.catalog.connectors.codex;
    const { complete, projects } = await backend.listProjects();
    const matches = projects?.filter((p) => p.nativeId === scope.projectId && p.roots.includes(scope.root));
    if (!complete || matches?.length !== 1) throw failure("CHAT_PICKER_INCOMPLETE");
    const sharedRoot = projects.some((p) => p.nativeId !== scope.projectId && p.roots.includes(scope.root));
    const rows = await backend.pages("thread/list", {
      cwd: [scope.root],
      archived: false,
      useStateDbOnly: true,
      limit: 100,
    });
    const seen = new Set(),
      items = [];
    for (const row of rows) {
      if (sharedRoot && row?.projectId === null) continue;
      const item = desktopEntry(row, scope);
      if (!item) continue;
      if (seen.has(item.threadId)) throw failure("CHAT_PICKER_INCOMPLETE");
      seen.add(item.threadId);
      items.push(item);
    }
    return items.sort(
      (a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
        a.title.localeCompare(b.title) ||
        a.threadId.localeCompare(b.threadId),
    );
  }
  async describe(key) {
    const cfg = this.config(),
      scope = projectScope(cfg, key),
      current = this.current(key, { cfg });
    if (!current) return null;
    try {
      const b = this.catalog.connectors.codex;
      const item = desktopEntry(await b.rawWork(current.threadId), scope);
      return { ...current, title: item?.title ?? current.title };
    } catch {
      return current;
    }
  }
  async list(key) {
    const cfg = this.config(),
      data = this.controls.read(),
      scope = projectScope(cfg, key);
    const current = this.current(key, { cfg, data }),
      control = data.projects[key] ?? { revision: 0, mode: "manual" };
    const state = {
      current,
      revision: current?.revision ?? 0,
      controlRevision: control.revision,
      items: [],
      complete: false,
      canChange: false,
    };
    try {
      const items = await this.directory(key, scope);
      const live = items.find((i) => i.threadId === current?.threadId);
      return {
        ...state,
        current: current ? { ...current, title: live?.title ?? current.title } : null,
        items,
        complete: true,
        canChange: control.mode === "manual",
        ...(control.mode !== "manual" ? { reason: "当前目标仍绑定原对话，结束后可更换。" } : {}),
      };
    } catch {
      return { ...state, reason: "暂时读不到完整对话列表，请稍后刷新。" };
    }
  }
  async select({
    projectKey,
    threadId,
    expectedTitle,
    expectedRevision,
    expectedControlRevision,
    requestId,
    actor,
    beforeMutation,
  }) {
    if (
      !uuid.test(threadId) ||
      !clean(expectedTitle) ||
      expectedTitle.length > 160 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !Number.isSafeInteger(expectedControlRevision) ||
      expectedControlRevision < 0 ||
      !clean(requestId) ||
      !/^[a-zA-Z0-9_:.\-]{1,512}$/.test(requestId) ||
      !clean(actor) ||
      actor.length > 512 ||
      typeof beforeMutation !== "function"
    )
      throw failure("CHAT_SELECTION_INVALID");
    const cfg = this.config(),
      scope = projectScope(cfg, projectKey),
      listing = await this.list(projectKey);
    const item = listing.items.find((i) => i.threadId === threadId);
    if (!listing.complete || !item || item.title !== expectedTitle) throw failure("CHAT_SELECTION_STALE");
    const checked = desktopEntry(await this.catalog.connectors.codex.rawWork(threadId), scope);
    if (!checked || checked.title !== expectedTitle) throw failure("CHAT_SELECTION_STALE");
    return this.controls.withLock((data) => {
      const guard = beforeMutation();
      if (guard?.then || guard === false) throw failure("CHAT_SELECTION_REVOKED");
      const fresh = this.config(),
        nowScope = projectScope(fresh, projectKey);
      const current = this.current(projectKey, { cfg: fresh, data }),
        ctrl = data.projects[projectKey] ?? { projectKey, revision: 0, mode: "manual", cancelRunning: false };
      if (
        nowScope.root !== scope.root ||
        nowScope.projectId !== scope.projectId ||
        JSON.stringify(cfg.managedCodex.boundChats?.[projectKey]) !==
          JSON.stringify(fresh.managedCodex.boundChats?.[projectKey])
      )
        throw failure("CHAT_SELECTION_STALE");
      const request = JSON.stringify([
        projectKey,
        actor,
        threadId,
        expectedTitle,
        expectedRevision,
        expectedControlRevision,
      ]);
      const duplicate = data.chatBindingRequests?.[requestId];
      if (duplicate) {
        if (duplicate !== request) throw failure("CHAT_SELECTION_REQUEST_CONFLICT");
        return current;
      }
      if (ctrl.mode !== "manual") throw failure("CHAT_SELECTION_BUSY");
      if ((current?.revision ?? 0) !== expectedRevision || ctrl.revision !== expectedControlRevision)
        throw failure("CHAT_SELECTION_STALE");
      const updatedAt = new Date().toISOString();
      const saved = { ...scope, threadId, title: checked.title, updatedAt, revision: expectedRevision + 1 };
      data.chatBindings ??= {};
      data.chatBindings[projectKey] = saved;
      data.chatBindingRequests ??= {};
      data.chatBindingRequests[requestId] = request;
      data.projects[projectKey] = { ...ctrl, revision: ctrl.revision + 1, updatedAt };
      this.controls.save(data);
      return { threadId, title: saved.title, updatedAt, revision: saved.revision };
    });
  }
}
