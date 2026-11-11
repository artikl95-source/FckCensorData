// fckbot for GitHub Actions — polls Telegram (getUpdates), adds tracks to the fork.
// Env: TG_TOKEN (secret), GH_TOKEN (secrets.GITHUB_TOKEN), GH_REPOSITORY.
// State: custom/bot_state.json (offset + pending audio), custom/bot_owner.txt (chat id).

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

function parseAlbumId(text) {
  if (!text) return null;
  const m = text.match(/album\/(\d+)/i);
  return m ? m[1] : null;
}

async function tgFileBytes(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch('https://api.telegram.org/file/bot' + process.env.TG_TOKEN + '/' + f.file_path);
  if (!r.ok) throw new Error('file download: HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function processTrack(chatId, audio, trackId, albumId) {
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
  if (albumId) src.tracks[trackId].__fckAlbumId = String(albumId);
  if (audio.durationMs > 0) src.tracks[trackId].__fckDurationMs = audio.durationMs;
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
  // файлы обычно называются "Исполнитель - Трек" — исполнитель и так виден отдельной строкой
  const dash = title.lastIndexOf(' - ');
  if (dash > 3) title = title.slice(dash + 3).trim();
  return { fileId: a.file_id, title, performer, durationMs: (a.duration || 0) * 1000 };
}

async function handleUpdate(u, owner, state) {
  const m = u.message || u.edited_message;
  if (!m || !m.chat) return;
  const chatId = String(m.chat.id);

  if (!owner) {
    owner = chatId;
    state.owner = owner;
    console.log('owner paired: ' + owner);
    await tg('sendMessage', { chat_id: chatId, text: 'Бот привязан к этому чату. Кирай мне аудиофайл (без цензуры), а в подписи — ссылку на трек Яндекс.Музыки (или ссылку отдельным сообщением).' });
    return;
  }
  if (chatId !== owner) {
    await tg('sendMessage', { chat_id: chatId, text: 'Нет доступа.' });
    return;
  }

  const pending = state.pending;

  if (m.audio || (m.document && /audio|mpeg|mp4|flac|ogg/i.test(m.document.mime_type || ''))) {
    const audio = describeAudio(m);
    const capId = parseTrackId(m.caption);
    if (capId) {
      const bytes = await tgFileBytes(audio.fileId);
      audio.bytes = bytes;
      try {
        await processTrack(chatId, audio, capId, parseAlbumId(m.caption));
        state.pending = null;
        await tg('sendMessage', { chat_id: chatId, text: '✅ Трек ' + capId + ' добавлен в базу (' + (audio.title || 'без названия') + '). Список пересобирается — приложение подхватит при следующем запуске.' });
      } catch (e) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Ошибка: ' + e.message });
      }
      return;
    }
    state.pending = { fileId: audio.fileId, title: audio.title, performer: audio.performer, durationMs: audio.durationMs || 0 };
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
      await processTrack(chatId, audio, trackId, parseAlbumId(m.text));
      state.pending = null;
      await tg('sendMessage', { chat_id: chatId, text: '✅ Трек ' + trackId + ' добавлен в базу (' + (audio.title || 'без названия') + '). Список пересобирается — приложение подхватит при следующем запуске.' });
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ Ошибка: ' + e.message });
    }
    return;
  }
}

(async () => {
  if (!process.env.TG_TOKEN || process.env.TG_TOKEN.length < 10) {
    console.log('FCKBOT_TG_TOKEN secret is not set — skipping poll');
    return;
  }
  // a leftover webhook blocks getUpdates polling — remove it if present
  try {
    await tg('deleteWebhook', { drop_pending_updates: false });
  } catch (e) {
    console.log('deleteWebhook: ' + e.message);
  }

  const ownerFile = await getFileContent(OWNER_FILE);
  let owner = ownerFile.text ? ownerFile.text.trim() : null;
  const stateFile = await getFileContent(STATE_FILE);
  let state;
  try { state = stateFile.text ? JSON.parse(stateFile.text) : { offset: 0, pending: null }; }
  catch (e) { state = { offset: 0, pending: null }; }
  if (state.owner) owner = state.owner;

  let offset = state.offset || 0;
  console.log('polling, offset=' + offset + ', owner=' + (owner || 'not paired'));

  const updates = await tg('getUpdates', { timeout: 5, offset });
  const origOffset = offset;
  let lastOffset = offset;
  for (const u of updates) {
    lastOffset = u.update_id + 1;
    state.offset = lastOffset;
    try { await handleUpdate(u, owner, state); } catch (e) { console.log('handle error: ' + e.message); }
  }
  if (lastOffset !== origOffset) {
    state.offset = lastOffset;
    await putFile(STATE_FILE,
      Buffer.from(JSON.stringify(state, null, 2), 'utf8'),
      'bot state [skip ci]');
  }
  console.log('done, offset now ' + lastOffset);
})().catch(e => { console.log('fatal: ' + e.message); process.exit(1); });
