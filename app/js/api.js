import { PROTOCOL_VERSION, UNCERTAIN_OPERATION } from './session.js';

// HTTP calls to the service. Live board edits go through client.js.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(fetchImpl, url, options) {
  try { return await fetchImpl(url, options); }
  catch (error) {
    if (options.method && options.method !== 'GET') throw new ApiError(0, 'outcome_unknown', UNCERTAIN_OPERATION);
    throw error;
  }
}

export async function health({ baseUrl, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${baseUrl}/api/health`);
  const body = await response.json();
  if (body.protocol !== PROTOCOL_VERSION) throw new ApiError(409, 'protocol_incompatible', 'The service protocol does not match this app. Reload the app.');
  return body;
}

/** Exchange a one-time code for the session token. The only call that is made without one. */
export async function redeemCode({ baseUrl, code, fetchImpl = globalThis.fetch }) {
  const response = await request(fetchImpl, `${baseUrl}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok || typeof body?.token !== 'string') {
    throw new ApiError(response.status, body?.error ?? 'http_error', body?.message ?? `The request failed (${response.status}).`);
  }
  return body.token;
}

/** A code for one more window. Needs the token. */
export async function mintCode({ baseUrl, token, fetchImpl }) {
  return (await call(baseUrl, token, '/api/session/code', { method: 'POST', body: '{}' }, fetchImpl)).code;
}

async function call(baseUrl, token, path, options = {}, fetchImpl = globalThis.fetch) {
  const response = await request(fetchImpl, baseUrl + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PCBV-Protocol': String(PROTOCOL_VERSION) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // an error page without JSON still produces an ApiError below
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? 'http_error', body?.message ?? `The request failed (${response.status}).`);
  }
  if (body === null && options.method && options.method !== 'GET') throw new ApiError(0, 'outcome_unknown', UNCERTAIN_OPERATION);
  return body;
}

export async function listBoards({ baseUrl, token, fetchImpl }) {
  return (await call(baseUrl, token, '/api/boards', {}, fetchImpl)).boards;
}

export async function listPlaybooks({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/playbooks', {}, fetchImpl);
}

export async function listWiki({ baseUrl, token, fetchImpl }) {
  return (await call(baseUrl, token, '/api/wiki', {}, fetchImpl)).pages;
}

/** A wiki figure as a Blob; like board files it needs the token. */
export async function fetchWikiFigure({ baseUrl, token, file, fetchImpl = globalThis.fetch }) {
  const response = await request(fetchImpl, `${baseUrl}/api/wiki/figures/${encodeURIComponent(file)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await failure(response);
  return response.blob();
}

export async function getWikiPage({ baseUrl, token, name, fetchImpl }) {
  return call(baseUrl, token, `/api/wiki/${encodeURIComponent(name)}`, {}, fetchImpl);
}

export async function listSerialPorts({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/serial/ports', {}, fetchImpl);
}

/** The virtual board: `{running, owned, path}`. Start and stop only act on one the app started. */
export async function vdevStatus({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/vdev', {}, fetchImpl);
}

export async function vdevStart({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/vdev/start', { method: 'POST', body: '{}' }, fetchImpl);
}

export async function vdevStop({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/vdev/stop', { method: 'POST', body: '{}' }, fetchImpl);
}

export async function serialOpen({ baseUrl, token, slug, port, baud, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/serial`, { method: 'POST', body: JSON.stringify({ port, baud }) }, fetchImpl);
}

export async function serialDetect({ baseUrl, token, slug, port, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/serial/detect`, { method: 'POST', body: JSON.stringify({ port }) }, fetchImpl);
}

export async function serialClose({ baseUrl, token, slug, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/serial/close`, { method: 'POST', body: '{}' }, fetchImpl);
}

/** {line, confirm} or {key}. */
export async function serialWrite({ baseUrl, token, slug, payload, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/serial/write`, { method: 'POST', body: JSON.stringify(payload) }, fetchImpl);
}

export async function getEvents({ baseUrl, token, slug, since = 0, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/events?since=${Number(since) || 0}`, {}, fetchImpl);
}

export async function getCommits({ baseUrl, token, slug, fetchImpl }) {
  return (await call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/commits`, {}, fetchImpl)).commits;
}

export async function getWorkspaces({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/workspaces', {}, fetchImpl);
}

export async function saveWorkspaces({ baseUrl, token, data, fetchImpl }) {
  return call(baseUrl, token, '/api/workspaces', { method: 'POST', body: JSON.stringify(data) }, fetchImpl);
}

export async function getSettings({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/settings', {}, fetchImpl);
}

export async function saveSettings({ baseUrl, token, data, fetchImpl }) {
  return call(baseUrl, token, '/api/settings', { method: 'POST', body: JSON.stringify(data) }, fetchImpl);
}

export async function benchCheck({ baseUrl, token, fetchImpl }) {
  return (await call(baseUrl, token, '/api/bench-check', {}, fetchImpl)).checks;
}

/** The tutorial's practice board, made by the service if it is missing. Answers {slug}. */
export async function createTutorialBoard({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/tutorial/board', { method: 'POST', body: '{}' }, fetchImpl);
}

/** Delete the practice board and build it again. Answers 409 `session_open` while a console is open on it. */
export async function resetTutorialBoard({ baseUrl, token, fetchImpl }) {
  return call(baseUrl, token, '/api/tutorial/board/reset', { method: 'POST', body: '{}' }, fetchImpl);
}

export async function exportBoard({ baseUrl, token, slug, formats, redact, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/export`,
    { method: 'POST', body: JSON.stringify({ formats, redact }) }, fetchImpl);
}

export async function importLogic({ baseUrl, token, slug, file, name, samplerate = '', fetchImpl = globalThis.fetch }) {
  const query = new URLSearchParams({ name, samplerate });
  const response = await request(fetchImpl, `${baseUrl}/api/boards/${encodeURIComponent(slug)}/logic?${query}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-PCBV-Protocol': String(PROTOCOL_VERSION) }, body: file,
  });
  if (!response.ok) throw await failure(response);
  try { return await response.json(); } catch { throw new ApiError(0, 'outcome_unknown', UNCERTAIN_OPERATION); }
}

export async function logicEdges({ baseUrl, token, slug, id, start, end, bins = 0, fetchImpl }) {
  const query = `start=${Math.round(start)}&end=${Math.round(end)}&bins=${Math.round(bins)}`;
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/logic/${encodeURIComponent(id)}/edges?${query}`, {}, fetchImpl);
}

export async function logicDecode({ baseUrl, token, slug, id, channel, baud, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/logic/${encodeURIComponent(id)}/decode`, { method: 'POST', body: JSON.stringify({ channel, baud }) }, fetchImpl);
}

export async function logicCompare({ baseUrl, token, slug, id, channel, other, fetchImpl }) {
  return call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/logic/${encodeURIComponent(id)}/compare`, { method: 'POST', body: JSON.stringify({ channel, with: other }) }, fetchImpl);
}

export const assistantGet = ({ baseUrl, token, fetchImpl }) => call(baseUrl, token, '/api/assistant', {}, fetchImpl);
export const assistantSettings = ({ baseUrl, token, settings, fetchImpl }) =>
  call(baseUrl, token, '/api/assistant/settings', { method: 'POST', body: JSON.stringify(settings) }, fetchImpl);
export const assistantKey = ({ baseUrl, token, profile, key, fetchImpl }) =>
  call(baseUrl, token, `/api/assistant/keys/${encodeURIComponent(profile)}`, { method: 'POST', body: JSON.stringify({ key }) }, fetchImpl);
export const assistantTest = ({ baseUrl, token, profile, fetchImpl }) =>
  call(baseUrl, token, `/api/assistant/test/${encodeURIComponent(profile)}`, { method: 'POST', body: '{}' }, fetchImpl);
export const assistantChat = ({ baseUrl, token, slug, body, fetchImpl }) =>
  call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/assistant/chat`, { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
export const assistantConversation = ({ baseUrl, token, slug, fetchImpl }) =>
  call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/assistant/conversation`, {}, fetchImpl);
export const assistantReset = ({ baseUrl, token, slug, fetchImpl }) =>
  call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/assistant/reset`, { method: 'POST', body: '{}' }, fetchImpl);
export const assistantProposals = ({ baseUrl, token, slug, fetchImpl }) =>
  call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/assistant/proposals`, {}, fetchImpl);
export const assistantDecide = ({ baseUrl, token, slug, id, action, sessionId, fetchImpl }) =>
  call(baseUrl, token, `/api/boards/${encodeURIComponent(slug)}/assistant/proposals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action, sessionId }) }, fetchImpl);

export async function createBoard({ baseUrl, token, name, fetchImpl }) {
  return call(baseUrl, token, '/api/boards', { method: 'POST', body: JSON.stringify({ name }) }, fetchImpl);
}

async function failure(response) {
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  return new ApiError(response.status, body?.error ?? 'http_error', body?.message ?? `The request failed (${response.status}).`);
}

/** Send a photo file as raw bytes. The service stores it and records an asset/added event. */
export async function uploadPhoto({ baseUrl, token, slug, file, side = 'front', label = '', fetchImpl = globalThis.fetch }) {
  const query = new URLSearchParams({ side, label });
  const response = await request(fetchImpl, `${baseUrl}/api/boards/${encodeURIComponent(slug)}/assets?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-PCBV-Protocol': String(PROTOCOL_VERSION) },
    body: file,
  });
  if (!response.ok) throw await failure(response);
  try { return await response.json(); } catch { throw new ApiError(0, 'outcome_unknown', UNCERTAIN_OPERATION); }
}

/** Fetch a board file (a photo) as a Blob. Files need the token, so <img> cannot load them directly. */
export async function fetchFile({ baseUrl, token, slug, path, fetchImpl = globalThis.fetch }) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await request(fetchImpl, `${baseUrl}/api/boards/${encodeURIComponent(slug)}/files/${encoded}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await failure(response);
  return response.blob();
}

export const gitStatus = ({ baseUrl, token, fetchImpl }) => call(baseUrl, token, '/api/git', {}, fetchImpl);
export const gitSetup = ({ baseUrl, token, body, fetchImpl }) =>
  call(baseUrl, token, '/api/git/setup', { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
