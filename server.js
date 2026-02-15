import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const TEXT_DIR = path.join(DATA_DIR, 'text');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const META_DIR = path.join(DATA_DIR, 'meta');
const VIDEO_META_FILE = path.join(META_DIR, 'videos.json');
const HISTORY_FILE = path.join(META_DIR, 'history.json');
const WHISPER_OUTPUT_DIR = path.join(META_DIR, 'whisper');

const allowedVideoExt = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const whisperCommand = process.env.WHISPER_CMD || 'whisper';
const whisperModel = process.env.WHISPER_MODEL || 'small';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIDEOS_DIR),
    filename: (_req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      cb(null, `${stamp}-${file.originalname.replace(/\s+/g, '_')}`);
    }
  })
});

async function ensureFolders() {
  await Promise.all([VIDEOS_DIR, AUDIO_DIR, TEXT_DIR, SCREENSHOTS_DIR, META_DIR, WHISPER_OUTPUT_DIR].map((dir) => fs.mkdir(dir, { recursive: true })));
  if (!existsSync(VIDEO_META_FILE)) {
    await fs.writeFile(VIDEO_META_FILE, JSON.stringify({ videos: {} }, null, 2), 'utf-8');
  }
  if (!existsSync(HISTORY_FILE)) {
    await fs.writeFile(HISTORY_FILE, JSON.stringify({ history: [] }, null, 2), 'utf-8');
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

function getVideoId(fileName) {
  return path.parse(fileName).name;
}

async function addHistory(type, message, details = {}) {
  const store = await readJson(HISTORY_FILE, { history: [] });
  store.history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    type,
    message,
    details
  });
  await writeJson(HISTORY_FILE, store);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let err = '';
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(err || `ffmpeg failed with code ${code}`));
      }
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => reject(new Error(String(error.message || error))));
    proc.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(stderr || `${command} failed with code ${code}`));
    });
  });
}

async function syncVideoMeta() {
  const files = await fs.readdir(VIDEOS_DIR);
  const videoFiles = files.filter((f) => allowedVideoExt.has(path.extname(f).toLowerCase()));
  const meta = await readJson(VIDEO_META_FILE, { videos: {} });

  for (const fileName of videoFiles) {
    const id = getVideoId(fileName);
    const videoPath = path.join(VIDEOS_DIR, fileName);
    const audioName = `${id}.mp3`;
    const textName = `${id}.json`;
    const stat = await fs.stat(videoPath);

    if (!meta.videos[id]) {
      meta.videos[id] = {
        id,
        fileName,
        createdAt: new Date().toISOString(),
        notes: [],
        transcript: [],
        status: 'new'
      };
      await addHistory('scan', `Обнаружено новое видео: ${fileName}`, { videoId: id });
    }

    meta.videos[id].fileName = fileName;
    meta.videos[id].videoSize = stat.size;
    meta.videos[id].audioFile = existsSync(path.join(AUDIO_DIR, audioName)) ? audioName : null;
    meta.videos[id].textFile = existsSync(path.join(TEXT_DIR, textName)) ? textName : null;
    meta.videos[id].audioSize = meta.videos[id].audioFile ? (await fs.stat(path.join(AUDIO_DIR, audioName))).size : null;
    meta.videos[id].textSize = meta.videos[id].textFile ? (await fs.stat(path.join(TEXT_DIR, textName))).size : null;

    if (!meta.videos[id].audioFile && !meta.videos[id].textFile) meta.videos[id].status = 'unprocessed';
    else if (meta.videos[id].audioFile && !meta.videos[id].textFile) meta.videos[id].status = 'audio_ready';
    else if (meta.videos[id].audioFile && meta.videos[id].textFile) meta.videos[id].status = 'ready';
  }

  await writeJson(VIDEO_META_FILE, meta);
  return meta;
}

async function transcribeWithWhisper(audioPath) {
  const baseName = path.parse(audioPath).name;
  const whisperJson = path.join(WHISPER_OUTPUT_DIR, `${baseName}.json`);

  if (existsSync(whisperJson)) {
    await fs.unlink(whisperJson);
  }

  await runCommand(whisperCommand, [
    audioPath,
    '--model', whisperModel,
    '--task', 'transcribe',
    '--fp16', 'False',
    '--output_format', 'json',
    '--output_dir', WHISPER_OUTPUT_DIR
  ]);

  const whisperData = await readJson(whisperJson, null);
  if (!whisperData) {
    throw new Error('Whisper завершился без JSON результата');
  }

  if (Array.isArray(whisperData.segments) && whisperData.segments.length > 0) {
    return whisperData.segments.map((s) => ({
      start: Number(s.start || 0),
      end: Number(s.end || 0),
      text: String(s.text || '').trim()
    }));
  }

  return [{ start: 0, end: 999999, text: String(whisperData.text || '').trim() }];
}

async function transcribeWithOpenAI(audioPath) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY не задан');
  }

  const result = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'gpt-4o-mini-transcribe',
    response_format: 'verbose_json'
  });

  if (result.segments?.length) {
    return result.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  }
  return [{ start: 0, end: 999999, text: result.text || '' }];
}

async function transcribeAudio(audioPath) {
  try {
    const transcript = await transcribeWithWhisper(audioPath);
    await addHistory('transcribe', `Транскрибация завершена Whisper (${whisperModel})`, { engine: 'whisper', model: whisperModel });
    return transcript;
  } catch (whisperError) {
    await addHistory('error', 'Ошибка локальной транскрибации Whisper, пробуем OpenAI fallback', { error: String(whisperError.message || whisperError) });
    if (openai) {
      const transcript = await transcribeWithOpenAI(audioPath);
      await addHistory('transcribe', 'Транскрибация завершена OpenAI fallback', { engine: 'openai' });
      return transcript;
    }
    throw new Error(`Whisper недоступен и fallback отключен: ${String(whisperError.message || whisperError)}`);
  }
}

app.use(express.json({ limit: '20mb' }));
app.use('/files/videos', express.static(VIDEOS_DIR));
app.use('/files/audio', express.static(AUDIO_DIR));
app.use('/files/text', express.static(TEXT_DIR));
app.use('/files/screenshots', express.static(SCREENSHOTS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/videos', async (_req, res) => {
  const meta = await syncVideoMeta();
  res.json(Object.values(meta.videos).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  await addHistory('upload', `Загружено видео ${req.file.filename}`, {});
  const meta = await syncVideoMeta();
  res.json({ ok: true, video: meta.videos[getVideoId(req.file.filename)] });
});

app.post('/api/process/:id', async (req, res) => {
  const { id } = req.params;
  const meta = await syncVideoMeta();
  const video = meta.videos[id];
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const videoPath = path.join(VIDEOS_DIR, video.fileName);
  const audioPath = path.join(AUDIO_DIR, `${id}.mp3`);
  const textPath = path.join(TEXT_DIR, `${id}.json`);

  try {
    await addHistory('process', `Старт обработки ${video.fileName}`, { videoId: id });
    await runFfmpeg(['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', audioPath]);
    const transcript = await transcribeAudio(audioPath);

    const full = {
      videoId: id,
      updatedAt: new Date().toISOString(),
      transcript,
      markers: []
    };
    await writeJson(textPath, full);

    video.audioFile = `${id}.mp3`;
    video.textFile = `${id}.json`;
    video.transcript = transcript;
    video.status = 'ready';
    await writeJson(VIDEO_META_FILE, meta);
    await addHistory('process', `Завершена обработка ${video.fileName}`, { videoId: id });

    res.json({ ok: true });
  } catch (error) {
    await addHistory('error', `Ошибка обработки ${video.fileName}`, { videoId: id, error: String(error.message || error) });
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/text/:id', async (req, res) => {
  const textPath = path.join(TEXT_DIR, `${req.params.id}.json`);
  const data = await readJson(textPath, null);
  if (!data) return res.status(404).json({ error: 'Text not found' });
  res.json(data);
});

app.put('/api/text/:id', async (req, res) => {
  const textPath = path.join(TEXT_DIR, `${req.params.id}.json`);
  const data = req.body;
  await writeJson(textPath, data);
  await addHistory('edit', `Текст отредактирован для ${req.params.id}`, { videoId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/refine/:id', async (req, res) => {
  const { id } = req.params;
  const { instruction } = req.body;
  const textPath = path.join(TEXT_DIR, `${id}.json`);
  const textData = await readJson(textPath, null);
  if (!textData) return res.status(404).json({ error: 'Text not found' });

  if (!openai) {
    return res.status(400).json({ error: 'OPENAI_API_KEY не задан' });
  }

  const prompt = `Улучши текст транскрипции на русском. Сохрани смысл и таймкоды. Верни JSON массив объектов {start,end,text}. Инструкция: ${instruction || 'исправь пунктуацию и ошибки'}. Исходные данные: ${JSON.stringify(textData.transcript)}`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }]
  });

  const content = completion.choices[0]?.message?.content || '[]';
  const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
  textData.transcript = parsed;
  textData.updatedAt = new Date().toISOString();
  await writeJson(textPath, textData);
  await addHistory('refine', `LLM-улучшение текста для ${id}`, { videoId: id });
  res.json(textData);
});

app.post('/api/screenshot/:id', async (req, res) => {
  const { id } = req.params;
  const { imageBase64, time } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image' });
  const png = imageBase64.replace(/^data:image\/png;base64,/, '');
  const fileName = `${id}-${Date.now()}.png`;
  const filePath = path.join(SCREENSHOTS_DIR, fileName);
  await fs.writeFile(filePath, png, 'base64');

  const textPath = path.join(TEXT_DIR, `${id}.json`);
  const textData = await readJson(textPath, { videoId: id, transcript: [], markers: [] });
  textData.markers ||= [];
  textData.markers.push({ time, fileName, url: `/files/screenshots/${fileName}` });
  textData.transcript ||= [];
  textData.transcript.push({ start: time, end: time + 1, text: `[Скриншот @ ${time.toFixed(2)} сек](/files/screenshots/${fileName})` });
  textData.transcript.sort((a, b) => a.start - b.start);
  await writeJson(textPath, textData);

  await addHistory('screenshot', `Скриншот для ${id} @ ${time.toFixed(2)} сек`, { videoId: id, fileName });
  res.json({ ok: true, url: `/files/screenshots/${fileName}` });
});

app.get('/api/history', async (_req, res) => {
  const store = await readJson(HISTORY_FILE, { history: [] });
  res.json(store.history);
});

app.delete('/api/history/:id', async (req, res) => {
  const store = await readJson(HISTORY_FILE, { history: [] });
  store.history = store.history.filter((h) => h.id !== req.params.id);
  await writeJson(HISTORY_FILE, store);
  res.json({ ok: true });
});

app.delete('/api/history', async (_req, res) => {
  await writeJson(HISTORY_FILE, { history: [] });
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

await ensureFolders();
await syncVideoMeta();
app.listen(PORT, () => {
  console.log(`App started on http://localhost:${PORT}`);
  console.log(`Working directory access only: ${ROOT}`);
});
