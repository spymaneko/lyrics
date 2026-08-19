import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const execPromise = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const PUBLIC_DIR = path.join(__dirname, 'public');

await fs.ensureDir(UPLOADS_DIR);
await fs.ensureDir(OUTPUTS_DIR);
await fs.ensureDir(PUBLIC_DIR);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/outputs', express.static(OUTPUTS_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const FILE_MAX_AGE_MS = 60 * 60 * 1000;

async function cleanOldFiles(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = await fs.stat(filePath);

      if (now - stats.mtimeMs > FILE_MAX_AGE_MS) {
        await fs.remove(filePath);
      }
    }
  } catch (err) {
    console.error(`Cleanup error in ${dirPath}:`, err.message);
  }
}

setInterval(() => {
  cleanOldFiles(UPLOADS_DIR);
  cleanOldFiles(OUTPUTS_DIR);
}, CLEANUP_INTERVAL_MS);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function hexToASSColor(hexStr, defaultHex = '&H00FFFFFF&') {
  if (!hexStr) return defaultHex;
  let hex = hexStr.replace('#', '').trim();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return defaultHex;
  const r = hex.substring(0, 2);
  const g = hex.substring(2, 4);
  const b = hex.substring(4, 6);
  return `&H00${b}${g}${r}&`;
}

function formatASSTime(seconds) {
  const date = new Date(null);
  date.setMilliseconds((seconds || 0) * 1000);
  const hours = String(date.getUTCHours());
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const secs = String(date.getUTCSeconds()).padStart(2, '0');
  const cs = String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
  return `${hours}:${minutes}:${secs}.${cs}`;
}

function combineIntoFixedLines(rawSegments) {
  if (!rawSegments || rawSegments.length === 0) return [];

  const merged = [];
  let current = null;

  for (const seg of rawSegments) {
    const text = seg.text.trim();
    if (!text) continue;

    if (!current) {
      current = {
        start: seg.start,
        end: seg.end,
        text: text
      };
    } else {
      const timeGap = seg.start - current.end;
      const combinedLength = current.text.length + 1 + text.length;

      if (timeGap < 1.2 && combinedLength <= 50) {
        current.end = seg.end;
        current.text += ` ${text}`;
      } else {
        merged.push(current);
        current = {
          start: seg.start,
          end: seg.end,
          text: text
        };
      }
    }
  }

  if (current) merged.push(current);

  return merged.map(line => ({
    start: line.start,
    end: line.end,
    text: line.text,
    x: 640,
    y: 640,
    words: []
  }));
}

app.post('/api/transcribe', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
  { name: 'background', maxCount: 1 }
]), async (req, res) => {
  const jobId = `job_${Date.now()}`;
  const jobDir = path.join(UPLOADS_DIR, jobId);
  await fs.ensureDir(jobDir);

  try {
    let mediaFilePath = null;
    let bgFilePath = null;
    let publicMediaUrl = '';
    let publicBgUrl = null;

    if (req.body.url) {
      const downloadPath = path.join(jobDir, 'yt_video.mp4');
      await execPromise(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${downloadPath}" "${req.body.url}"`);
      mediaFilePath = downloadPath;
      publicMediaUrl = `/uploads/${jobId}/yt_video.mp4`;
    } else if (req.files && req.files['video']) {
      const file = req.files['video'][0];
      const targetPath = path.join(jobDir, file.filename);
      await fs.move(file.path, targetPath);
      mediaFilePath = targetPath;
      publicMediaUrl = `/uploads/${jobId}/${file.filename}`;
    } else if (req.files && req.files['audio']) {
      const audioFile = req.files['audio'][0];
      const audioPath = path.join(jobDir, audioFile.filename);
      await fs.move(audioFile.path, audioPath);

      if (req.files['background']) {
        const bgFile = req.files['background'][0];
        bgFilePath = path.join(jobDir, bgFile.filename);
        await fs.move(bgFile.path, bgFilePath);
        publicBgUrl = `/uploads/${jobId}/${bgFile.filename}`;
      }

      mediaFilePath = audioPath;
      publicMediaUrl = `/uploads/${jobId}/${audioFile.filename}`;
    } else {
      return res.status(400).json({ success: false, error: 'No media input provided.' });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(mediaFilePath),
      model: "whisper-large-v3-turbo",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });

    const segments = combineIntoFixedLines(transcription.segments || []);

    return res.json({ 
      success: true, 
      jobId, 
      mediaPath: mediaFilePath, 
      bgPath: bgFilePath, 
      mediaUrl: publicMediaUrl, 
      bgUrl: publicBgUrl, 
      segments 
    });
  } catch (error) {
    console.error('Transcribe Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Fast Video Rendering Logic
async function handleVideoRender(req, res) {
  // Prevent socket connection timeout during long FFmpeg execution
  req.setTimeout(0);
  res.setTimeout(0);

  try {
    const { jobId, mediaPath, bgPath, subtitles, styles } = req.body;

    if (!mediaPath || !fs.existsSync(mediaPath)) {
      return res.status(400).json({ success: false, error: 'Source media file not found on server.' });
    }

    const outputFilename = `render_${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    const assPath = path.join(UPLOADS_DIR, `${jobId || 'temp'}.ass`);

    const fontName = styles?.fontFamily || 'Montserrat';
    const fontSize = styles?.fontSize || 52;
    const primaryColor = hexToASSColor(styles?.textColor, '&H00FFFFFF&');
    const outlineColor = hexToASSColor(styles?.outlineColor, '&H00000000&');

    let assContent = `[Script Info]
Title: Lyric Studio Fixed
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF&,${outlineColor},&H80000000&,1,0,0,0,100,100,0,0,1,3,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    if (Array.isArray(subtitles)) {
      subtitles.forEach((sub) => {
        const startStr = formatASSTime(sub.start);
        const endStr = formatASSTime(sub.end);
        let dialogueText = sub.text.replace(/\n/g, '\\N');

        const posX = sub.x || 640;
        const posY = sub.y || 640;
        let overrideTags = `\\pos(${posX},${posY})`;

        if (sub.fontFamily || styles?.fontFamily) overrideTags += `\\fn${sub.fontFamily || styles.fontFamily}`;
        if (sub.textColor || styles?.textColor) overrideTags += `\\c${hexToASSColor(sub.textColor || styles.textColor)}`;
        if (sub.outlineColor || styles?.outlineColor) overrideTags += `\\3c${hexToASSColor(sub.outlineColor || styles.outlineColor)}`;

        assContent += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,{${overrideTags}}${dialogueText}\n`;
      });
    }

    await fs.writeFile(assPath, assContent, 'utf8');

    // Properly escape file path for FFmpeg ASS filter string across Linux & Windows
    const escapedAssPath = assPath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');

    let ffmpegCmd = '';
    const mediaExt = path.extname(mediaPath).toLowerCase();
    const isAudioOnly = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.mpeg'].includes(mediaExt);

    if (isAudioOnly) {
      if (bgPath && fs.existsSync(bgPath)) {
        const bgExt = path.extname(bgPath).toLowerCase();
        const isBgVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(bgExt);

        if (isBgVideo) {
          ffmpegCmd = `ffmpeg -threads 0 -stream_loop -1 -i "${bgPath}" -i "${mediaPath}" -filter_complex "[0:v]scale=854:480:force_original_aspect_ratio=increase,crop=854:480,ass='${escapedAssPath}'[v]" -map "[v]" -map 1:a:0 -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k -pix_fmt yuv420p -shortest "${outputPath}" -y`;
        } else {
          ffmpegCmd = `ffmpeg -threads 0 -loop 1 -i "${bgPath}" -i "${mediaPath}" -filter_complex "[0:v]scale=854:480:force_original_aspect_ratio=increase,crop=854:480,ass='${escapedAssPath}'[v]" -map "[v]" -map 1:a:0 -c:v libx264 -preset ultrafast -tune stillimage -crf 28 -c:a aac -b:a 128k -pix_fmt yuv420p -shortest "${outputPath}" -y`;
        }
      } else {
        ffmpegCmd = `ffmpeg -threads 0 -f lavfi -i color=c=black:s=854x480:r=24 -i "${mediaPath}" -filter_complex "[0:v]ass='${escapedAssPath}'[v]" -map "[v]" -map 1:a:0 -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k -pix_fmt yuv420p -shortest "${outputPath}" -y`;
      }
    } else {
      ffmpegCmd = `ffmpeg -threads 0 -i "${mediaPath}" -vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,ass='${escapedAssPath}'" -c:v libx264 -preset ultrafast -crf 28 -c:a copy "${outputPath}" -y`;
    }

    // Execute FFmpeg with higher maxBuffer size to prevent child process overflow
    await execPromise(ffmpegCmd, { maxBuffer: 1024 * 1024 * 50 });

    return res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

app.post('/api/export', handleVideoRender);
app.post('/api/render', handleVideoRender);

const server = app.listen(PORT, () => {
  console.log(`🚀 Professional Lyric Studio running on http://localhost:${PORT}`);
});

server.keepAliveTimeout = 600000;
server.headersTimeout = 605000;