import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const execPromise = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const PUBLIC_DIR = path.join(__dirname, 'public');

await fs.ensureDir(UPLOADS_DIR);
await fs.ensureDir(OUTPUTS_DIR);
await fs.ensureDir(PUBLIC_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/outputs', express.static(OUTPUTS_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

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
  date.setMilliseconds(seconds * 1000);
  const hours = String(date.getUTCHours());
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const secs = String(date.getUTCSeconds()).padStart(2, '0');
  const cs = String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
  return `${hours}:${minutes}:${secs}.${cs}`;
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

    const whisperOutDir = path.join(jobDir, 'whisper_out');
    await fs.ensureDir(whisperOutDir);

    // Run Whisper using auto-detect
    await execPromise(`whisper "${mediaFilePath}" --model base --output_format json --word_timestamps True --output_dir "${whisperOutDir}"`);

    const jsonFiles = await fs.readdir(whisperOutDir);
    const resultJson = jsonFiles.find(f => f.endsWith('.json'));
    if (!resultJson) throw new Error('Whisper transcription failed.');

    const whisperData = await fs.readJson(path.join(whisperOutDir, resultJson));

    const segments = (whisperData.segments || []).map(seg => ({
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      x: 640,
      y: 640,
      words: (seg.words || []).map(w => ({ word: w.word.trim(), start: w.start, end: w.end }))
    }));

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

app.post('/api/render', async (req, res) => {
  try {
    const { jobId, mediaPath, bgPath, subtitles, styles } = req.body;
    const outputFilename = `render_${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    const assPath = path.join(UPLOADS_DIR, `${jobId || 'temp'}.ass`);

    const fontName = styles.fontFamily || 'Montserrat';
    const fontSize = styles.fontSize || 52;
    const primaryColor = hexToASSColor(styles.textColor, '&H00FFFFFF&');
    const outlineColor = hexToASSColor(styles.outlineColor, '&H00000000&');

    let assContent = `[Script Info]
Title: Lyric Studio Professional
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF&,${outlineColor},&H80000000&,1,0,0,0,100,100,0,0,1,3,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    subtitles.forEach((sub) => {
      const startStr = formatASSTime(sub.start);
      const endStr = formatASSTime(sub.end);
      let dialogueText = sub.text.replace(/\n/g, '\\N');

      const posX = sub.x || 640;
      const posY = sub.y || 640;
      let overrideTags = `\\pos(${posX},${posY})`;

      if (sub.fontFamily || styles.fontFamily) overrideTags += `\\fn${sub.fontFamily || styles.fontFamily}`;
      if (sub.textColor || styles.textColor) overrideTags += `\\c${hexToASSColor(sub.textColor || styles.textColor)}`;
      if (sub.outlineColor || styles.outlineColor) overrideTags += `\\3c${hexToASSColor(sub.outlineColor || styles.outlineColor)}`;

      const currentTransition = sub.transition || styles.transition;
      if (currentTransition === 'fade') {
        overrideTags += `\\fad(300,300)`;
      } else if (currentTransition === 'pop') {
        overrideTags += `\\t(0,200,\\fscx100\\fscy100)`;
      } else if (currentTransition === 'karaoke' && sub.words && sub.words.length > 0) {
        dialogueText = sub.words.map(w => `{\\k${Math.max(10, Math.round((w.end - w.start) * 100))}}${w.word}`).join(' ');
      }

      assContent += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,{${overrideTags}}${dialogueText}\n`;
    });

    await fs.writeFile(assPath, assContent, 'utf8');
    const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    let ffmpegCmd = '';
    const mediaExt = path.extname(mediaPath).toLowerCase();
    const isAudioOnly = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.mpeg'].includes(mediaExt);

    if (isAudioOnly) {
      if (bgPath && fs.existsSync(bgPath)) {
        const bgExt = path.extname(bgPath).toLowerCase();
        const isBgVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(bgExt);

        if (isBgVideo) {
          // Video background: Use visual from background (0:v:0), audio from uploaded song (1:a:0)
          ffmpegCmd = `ffmpeg -stream_loop -1 -i "${bgPath}" -i "${mediaPath}" -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,ass='${escapedAssPath}'[v]" -map "[v]" -map 1:a:0 -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${outputPath}" -y`;
        } else {
          // Photo background: Loop image as video, audio from uploaded song (1:a:0)
          ffmpegCmd = `ffmpeg -loop 1 -i "${bgPath}" -i "${mediaPath}" -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,ass='${escapedAssPath}'[v]" -map "[v]" -map 1:a:0 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${outputPath}" -y`;
        }
      } else {
        // Black background fallback
        ffmpegCmd = `ffmpeg -f lavfi -i color=c=black:s=1280x720:r=30 -i "${mediaPath}" -filter_complex "[0:v]ass='${escapedAssPath}'[v]" -map "[v]" -map 1:a:0 -c:v libx264 -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${outputPath}" -y`;
      }
    } else {
      // Input is a video file with audio
      ffmpegCmd = `ffmpeg -i "${mediaPath}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,ass='${escapedAssPath}'" -c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}" -y`;
    }

    await execPromise(ffmpegCmd);
    return res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Professional Lyric Studio running on http://localhost:${PORT}`);
});