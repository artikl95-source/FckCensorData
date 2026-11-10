// fckbot for GitHub Actions — processes ONE Telegram update forwarded by the
// Cloudflare webhook worker via workflow_dispatch inputs.payload.
// Env: TG_TOKEN (secret), GH_TOKEN (secrets.GITHUB_TOKEN), GH_REPOSITORY.
// State: custom/bot_state.json (pending audio) and custom/bot_owner.txt (chat id).

const fs = require('fs');

const TG = 'https://api.telegram.org/bot' + process.env.TG_TOKEN;
const GH = 'https://api.github.com';
const REPO = process.env.GH_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;
const BRANCH = 'main';
const TEMPLATE = 'raw.githubusercontent.com/' + REPO + '/refs/heads/main/tracks/%%';
const STATE_FILE = 'custom/bot_state.json';
const OWNER_FILE = 'custom/bot_owner.txt';

function ghHeaders(extra) {
  return Object.assign({
    Authorization: 'token ' + TOKEN,
    'User-Agent': 'fckbot',
    Accept: 'application/vnd.github+json'
  }, extra || {});
}

async function gh(path, opts) {
  const r = await fetch(GH + path, Object.assign({ headers: ghHeaders() }, opts));
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch (e) { }
  if (!r.ok) throw new Error('GH ' + r.status + ' ' + path + ': ' + (j.message || t.slice(0, 200)));
  return j;
}

async function getFileContent(repoPath) {
  try {
    const j = await gh('/repos/' + REPO + '/contents/' + encodeURI(repoPath) + '?ref=' + BRANCH);
    return { sha: j.sha, text: Buffer.from(j.content, 'base64').toString('utf8') };
  } catch (e) {
    return { sha: null, text: null };
  }
}

async function putFile(repoPath, contentBuf, message) {
  const existing = await gh('/repos/' + REPO + '/contents/' + encodeURI(repoPath) + '?ref=' + BRANCH).catch(() => null);
  const body = { message, content: contentBuf.toString('base64'), branch: BRANCH };
  if (existing && existing.sha) body.sha = existing.sha;
  await gh('/repos/' + REPO + '/contents/' + encodeURI(repoPath), {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
}

async function tg(method, body) {
  const r = await fetch(TG + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const j = await r.json();
  if (!j.ok) throw new Error(method + ': ' + JSON.stringify(j).slice(0, 300));
  return j.result;
}

function parseTrackId(text) {
  if (!text) return null;
  let m = text.match(/music\.ya(?:ndex)?\.(?:ru|com)\/(?:album\/\d+\/)?track\/(\d+)/i);
  if (m) return m[1];
  if (/^\s*\d{6,11}\s*$/.test(text)) return text.trim();
  return null;
}

async function tgFileBytes(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch('https://api.telegram.org/file/bot' + process.env.TG_TOKEN + '/' + f.file_path);
  if (!r.ok) throw new Error('file download: HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function processTrack(chatId, audio, trackId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  console.log('track ' + trackId + ': uploading audio (' + audio.bytes.length + ' bytes)');
  await putFile('tracks/' + trackId, audio.bytes, 'add track ' + trackId + ' audio');

  const { text } = await getFileContent('custom/custom_v2.json');
  const json = JSON.parse(text || '{"sources": []}');
  let src = (json.sources || []).find(s => s.tracksStorages && s.tracksStorages[0]
    && (s.tracksStorages[0].urlTemplate || '').indexOf(REPO.split('/')[0]) >= 0);
  if (!src) {
    src = { supportedVersions: '>0.0.0', tracks: {}, tracksStorages: [{ trackIds: [], urlTemplate: TEMPLATE }] };
    (json.sources = json.sources || []).push(src);
  }
  src.tracks[trackId] = { title: audio.title || ('Track ' + trackId) };
  if (audio.performer) src.tracks[trackId].artists = [{ id: 0, name: audio.performer }];
  const st = src.tracksStorages[0];
  if (!st.trackIds.some(t => String(t.id) === String(trackId))) st.trackIds.push({ id: Number(trackId) });

  console.log('track ' + trackId + ': updating custom_v2.json');
  await putFile('custom/custom_v2.json',
    Buffer.from(JSON.stringify(json, null, 2), 'utf8'),
    'add track ' + trackId + ' to custom list');

  await fetch(GH + '/repos/' + REPO + '/actions/workflows/sync-upstream.yml/dispatches', {
    method: 'POST',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: BRANCH })
  });
  console.log('track ' + trackId + ': regen dispatched');
}

function describeAudio(m) {
  const a = m.audio || m.document;
  let title = ((a.title || a.file_name || '').replace(/\.[a-z0-9]+$/i, '')) || null;
  const performer = a.performer || null;
  if (performer && title && title.toLowerCase().startsWith(performer.toLowerCase())) {
    const rest = title.slice(performer.length).replace(/^\s*[-–—]\s*/, '');
    if (rest) title = rest;
  }
  return { fileId: a.file_id, title, performer };
}

(async () => {
  if (!process.env.TG_TOKEN || process.env.TG_TOKEN.length < 10) {
    console.log('FCKBOT_TG_TOKEN secret is not set — skipping');
    return;
  }
  // the update forwarded by the webhook worker
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const payloadRaw = ev.inputs && ev.inputs.payload;
  if (!payloadRaw) { console.log('no payload input — skipping'); return; }
  const update = JSON.parse(payloadRaw);
  const m = update.message || update.edited_message;
  if (!m || !m.chat) { console.log('update without message — skipping'); return; }

  const chatId = String(m.chat.id);
  const ownerFile = await getFileContent(OWNER_FILE);
  const owner = ownerFile.text ? ownerFile.text.trim() : null;

  const stateFile = await getFileContent(STATE_FILE);
  let state = { pending: null };
  try { if (stateFile.text) state = JSON.parse(stateFile.text); } catch (e) { }
  if (!state.pending) state.pending = null;

  if (chatId !== owner) {
    if (!owner) {
      console.log('no owner paired yet — ignoring (pair via the old manual flow)');
      return;
    }
    await tg('sendMessage', { chat_id: chatId, text: 'Нет доступа.' });
    return;
  }

  if (m.audio || (m.document && /audio|mpeg|mp4|flac|ogg/i.test(m.document.mime_type || ''))) {
    const audio = describeAudio(m);
    const capId = parseTrackId(m.caption);
    if (capId) {
      const bytes = await tgFileBytes(audio.fileId);
      audio.bytes = bytes;
      try {
        await processTrack(chatId, audio, capId);
        state.pending = null;
        await putFile(STATE_FILE, Buffer.from(JSON.stringify(state, null, 2), 'utf8'), 'bot state [skip ci]');
        await tg('sendMessage', { chat_id: chatId, text: '✅ Трек ' + capId + ' добавлен в базу (' + (audio.title || 'без названия') + '). Список пересобирается — приложение подхватит при следующем запуске.' });
      } catch (e) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Ошибка: ' + e.message });
      }
      return;
    }
    state.pending = { fileId: audio.fileId, title: audio.title, performer: audio.performer };
    await putFile(STATE_FILE, Buffer.from(JSON.stringify(state, null, 2), 'utf8'), 'bot state [skip ci]');
    await tg('sendMessage', { chat_id: chatId, text: 'Аудио получено' + (audio.title ? ' («' + audio.title + '»)' : '') + '. Теперь пришли ссылку на трек Яндекс.Музыки (music.yandex.ru/album/.../track/...).' });
    return;
  }

  if (m.text) {
    if (m.text.trim() === '/start' || m.text.trim() === '/help') {
      await tg('sendMessage', { chat_id: chatId, text: 'Кирай: 1) аудиофайл без цензуры, 2) ссылку на трек (music.yandex.ru/album/.../track/...). Можно одним сообщением — аудио с ссылкой в подписи. Я залью файл в tracks/<id>, добавлю запись в кастом-список и пересоберу базу.' });
      return;
    }
    const trackId = parseTrackId(m.text);
    if (!trackId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Не вижу id трека. Пришли ссылку вида music.yandex.ru/album/<альбом>/track/<id> или просто число-id.' });
      return;
    }
    if (!state.pending) {
      await tg('sendMessage', { chat_id: chatId, text: 'Сначала пришли аудиофайл (без цензуры), потом ссылку.' });
      return;
    }
    const audio = state.pending;
    const bytes = await tgFileBytes(audio.fileId);
    audio.bytes = bytes;
    try {
      await processTrack(chatId, audio, trackId);
      state.pending = null;
      await putFile(STATE_FILE, Buffer.from(JSON.stringify(state, null, 2), 'utf8'), 'bot state [skip ci]');
      await tg('sendMessage', { chat_id: chatId, text: '✅ Трек ' + trackId + ' добавлен в базу (' + (audio.title || 'без названия') + '). Список пересобирается — приложение подхватит при следующем запуске.' });
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ Ошибка: ' + e.message });
    }
    return;
  }
  console.log('unsupported update type — skipping');
})().catch(e => { console.log('fatal: ' + e.message); process.exit(1); });
