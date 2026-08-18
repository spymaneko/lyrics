let currentSession = {
  jobId: null,
  mediaPath: null,
  bgPath: null,
  bgUrl: null,
  subtitles: []
};

let videoEl, canvasEl, ctx;
let bgImgEl = null;   // Photo background element
let bgVideoEl = null; // Video background element
let activeSubIndex = -1;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

// Auto-Split long sentences into maximum maxWords length
function splitLongSegments(segments, maxWords = 4) {
  const result = [];

  segments.forEach(seg => {
    const words = seg.words && seg.words.length > 0 ? seg.words : null;

    if (words && words.length > maxWords) {
      for (let i = 0; i < words.length; i += maxWords) {
        const chunkWords = words.slice(i, i + maxWords);
        const chunkText = chunkWords.map(w => w.word).join(' ');
        result.push({
          start: chunkWords[0].start,
          end: chunkWords[chunkWords.length - 1].end,
          text: chunkText,
          x: 640,
          y: 640,
          words: chunkWords
        });
      }
    } else {
      const textWords = seg.text.split(' ');
      if (textWords.length > maxWords) {
        const totalDuration = seg.end - seg.start;
        const totalChunks = Math.ceil(textWords.length / maxWords);
        const chunkDuration = totalDuration / totalChunks;

        for (let i = 0; i < textWords.length; i += maxWords) {
          const chunkIndex = Math.floor(i / maxWords);
          const chunkText = textWords.slice(i, i + maxWords).join(' ');
          const start = seg.start + (chunkIndex * chunkDuration);
          const end = Math.min(seg.end, start + chunkDuration);

          result.push({
            start,
            end,
            text: chunkText,
            x: 640,
            y: 640,
            words: []
          });
        }
      } else {
        result.push({
          ...seg,
          x: 640,
          y: 640
        });
      }
    }
  });

  return result;
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  event.target.classList.add('active');
  document.getElementById(`${tab}-form`).classList.add('active');
}

async function startTranscribe(event, type) {
  event.preventDefault();

  const statusContainer = document.getElementById('status-container');
  const errorContainer = document.getElementById('error-container');
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');

  statusContainer.classList.remove('hidden');
  errorContainer.classList.add('hidden');

  const formData = new FormData(type === 'url' ? undefined : event.target);

  try {
    let response;
    if (type === 'url') {
      const url = document.getElementById('yt-url').value;
      response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
    } else {
      response = await fetch('/api/transcribe', { method: 'POST', body: formData });
    }

    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Transcription failed.');

    const processedSubtitles = splitLongSegments(result.segments, 4);

    currentSession = {
      jobId: result.jobId,
      mediaPath: result.mediaPath,
      bgPath: result.bgPath,
      bgUrl: result.bgUrl,
      subtitles: processedSubtitles
    };

    step1.classList.add('hidden');
    step2.classList.remove('hidden');

    initStudioCanvas(result.mediaUrl, result.bgUrl);
    renderLyricsList();
  } catch (err) {
    errorContainer.textContent = err.message;
    errorContainer.classList.remove('hidden');
  } finally {
    statusContainer.classList.add('hidden');
  }
}

function initStudioCanvas(mediaUrl, bgUrl) {
  videoEl = document.getElementById('hidden-video');
  canvasEl = document.getElementById('preview-canvas');
  ctx = canvasEl.getContext('2d');

  bgImgEl = null;
  bgVideoEl = null;

  // Detect if background is a Video or Image
  if (bgUrl) {
    const ext = bgUrl.split('.').pop().toLowerCase();
    const isVideoBg = ['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext);

    if (isVideoBg) {
      bgVideoEl = document.createElement('video');
      bgVideoEl.src = bgUrl;
      bgVideoEl.muted = true;
      bgVideoEl.loop = true;
      bgVideoEl.playsInline = true;
      bgVideoEl.play();
    } else {
      bgImgEl = new Image();
      bgImgEl.src = bgUrl;
    }
  }

  videoEl.src = mediaUrl;
  videoEl.load();

  videoEl.onloadedmetadata = () => {
    document.getElementById('seek-bar').max = videoEl.duration;
    updateTimeDisplay();
    setupCanvasInteractions();
    window.addEventListener('keydown', handleKeyPress);
    requestAnimationFrame(renderCanvasLoop);
  };

  videoEl.ontimeupdate = () => {
    document.getElementById('seek-bar').value = videoEl.currentTime;
    updateTimeDisplay();
    highlightActiveLyricRow();
  };
}

function setupCanvasInteractions() {
  canvasEl.addEventListener('mousedown', handlePointerDown);
  canvasEl.addEventListener('mousemove', handlePointerMove);
  canvasEl.addEventListener('mouseup', handlePointerUp);
  canvasEl.addEventListener('dblclick', handleDoubleClick);
}

function getCanvasPointerPos(e) {
  const rect = canvasEl.getBoundingClientRect();
  const scaleX = canvasEl.width / rect.width;
  const scaleY = canvasEl.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function getActiveSubtitleAtTime(time) {
  return currentSession.subtitles.findIndex(s => time >= s.start && time <= s.end);
}

function handlePointerDown(e) {
  const pos = getCanvasPointerPos(e);
  const currentTime = videoEl.currentTime;
  const index = getActiveSubtitleAtTime(currentTime);

  if (index !== -1) {
    const sub = currentSession.subtitles[index];
    const fontSize = sub.fontSize || parseInt(document.getElementById('fontSize').value) || 52;
    const fontFamily = sub.fontFamily || document.getElementById('fontFamily').value;

    ctx.font = `bold ${fontSize}px "${fontFamily}", sans-serif`;
    const textWidth = ctx.measureText(sub.text).width;
    const textHeight = fontSize;

    if (
      pos.x >= sub.x - textWidth / 2 - 20 &&
      pos.x <= sub.x + textWidth / 2 + 20 &&
      pos.y >= sub.y - textHeight / 2 - 20 &&
      pos.y <= sub.y + textHeight / 2 + 20
    ) {
      isDragging = true;
      activeSubIndex = index;
      dragOffset.x = pos.x - sub.x;
      dragOffset.y = pos.y - sub.y;
      syncToolbarWithSub(sub);
      highlightActiveLyricRow();
    }
  }
}

function handlePointerMove(e) {
  if (isDragging && activeSubIndex !== -1) {
    const pos = getCanvasPointerPos(e);
    const newX = Math.round(pos.x - dragOffset.x);
    const newY = Math.round(pos.y - dragOffset.y);

    for (let i = activeSubIndex; i < currentSession.subtitles.length; i++) {
      currentSession.subtitles[i].x = newX;
      currentSession.subtitles[i].y = newY;
    }
  }
}

function handlePointerUp() {
  isDragging = false;
}

function handleDoubleClick(e) {
  const currentTime = videoEl.currentTime;
  const index = getActiveSubtitleAtTime(currentTime);

  if (index !== -1) {
    const sub = currentSession.subtitles[index];
    const newText = prompt('Edit Lyric Text:', sub.text);
    if (newText !== null && newText.trim() !== '') {
      sub.text = newText.trim();
      renderLyricsList();
    }
  }
}

function syncToolbarWithSub(sub) {
  if (sub.fontFamily) document.getElementById('fontFamily').value = sub.fontFamily;
  if (sub.fontSize) document.getElementById('fontSize').value = sub.fontSize;
  if (sub.textColor) document.getElementById('textColor').value = sub.textColor;
  if (sub.outlineColor) document.getElementById('outlineColor').value = sub.outlineColor;
  if (sub.transition) document.getElementById('transition').value = sub.transition;
}

function updateActiveLyricStyle() {
  const fontFamily = document.getElementById('fontFamily').value;
  const fontSize = parseInt(document.getElementById('fontSize').value);
  const textColor = document.getElementById('textColor').value;
  const outlineColor = document.getElementById('outlineColor').value;
  const transition = document.getElementById('transition').value;

  const currentTime = videoEl.currentTime;
  const index = activeSubIndex !== -1 ? activeSubIndex : getActiveSubtitleAtTime(currentTime);

  if (index !== -1) {
    for (let i = index; i < currentSession.subtitles.length; i++) {
      const sub = currentSession.subtitles[i];
      sub.fontFamily = fontFamily;
      sub.fontSize = fontSize;
      sub.textColor = textColor;
      sub.outlineColor = outlineColor;
      sub.transition = transition;
    }
  }
}

function renderCanvasLoop() {
  if (videoEl && ctx) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

    // 1. Prioritize background video if active
    if (bgVideoEl && bgVideoEl.readyState >= 2) {
      ctx.drawImage(bgVideoEl, 0, 0, canvasEl.width, canvasEl.height);
    } 
    // 2. Otherwise draw background photo if active
    else if (bgImgEl && bgImgEl.complete && bgImgEl.naturalWidth !== 0) {
      ctx.drawImage(bgImgEl, 0, 0, canvasEl.width, canvasEl.height);
    } 
    // 3. Fallback to main video file frames
    else if (videoEl.readyState >= 2) {
      ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    }

    const currentTime = videoEl.currentTime;
    const index = getActiveSubtitleAtTime(currentTime);

    if (index !== -1) {
      const sub = currentSession.subtitles[index];
      drawSubtitleOnCanvas(sub, currentTime, index === activeSubIndex || isDragging);
    }
  }

  requestAnimationFrame(renderCanvasLoop);
}

function drawSubtitleOnCanvas(sub, currentTime, isSelected) {
  const fontFamily = sub.fontFamily || document.getElementById('fontFamily').value;
  const fontSize = sub.fontSize || parseInt(document.getElementById('fontSize').value) || 52;
  const textColor = sub.textColor || document.getElementById('textColor').value;
  const outlineColor = sub.outlineColor || document.getElementById('outlineColor').value;
  const transition = sub.transition || document.getElementById('transition').value;

  ctx.save();
  ctx.font = `bold ${fontSize}px "${fontFamily}", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let x = sub.x;
  let y = sub.y;
  let alpha = 1;

  const elapsed = currentTime - sub.start;
  const remaining = sub.end - currentTime;

  if (transition === 'fade') {
    if (elapsed < 0.3) alpha = elapsed / 0.3;
    else if (remaining < 0.3) alpha = remaining / 0.3;
  } else if (transition === 'pop') {
    if (elapsed < 0.2) {
      const scale = 0.5 + (elapsed / 0.2) * 0.5;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      x = 0; y = 0;
    }
  } else if (transition === 'slideUp') {
    if (elapsed < 0.3) {
      const slideOffsetY = (1 - (elapsed / 0.3)) * 30;
      y += slideOffsetY;
    }
  } else if (transition === 'glow') {
    ctx.shadowColor = textColor;
    ctx.shadowBlur = 20;
  }

  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  ctx.lineWidth = Math.max(3, fontSize / 10);
  ctx.strokeStyle = outlineColor;
  ctx.fillStyle = textColor;

  if (transition === 'karaoke' && sub.words && sub.words.length > 0) {
    ctx.strokeText(sub.text, x, y);
    ctx.fillText(sub.text, x, y);

    const activeWord = sub.words.find(w => currentTime >= w.start && currentTime <= w.end);
    if (activeWord) {
      ctx.fillStyle = '#f59e0b';
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 12;
      ctx.fillText(activeWord.word, x, y);
    }
  } else {
    ctx.strokeText(sub.text, x, y);
    ctx.fillText(sub.text, x, y);
  }

  if (isSelected) {
    const textWidth = ctx.measureText(sub.text).width;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(x - textWidth / 2 - 12, y - fontSize / 2 - 8, textWidth + 24, fontSize + 16);
  }

  ctx.restore();
}

function splitCurrentLyric() {
  const currentTime = videoEl.currentTime;
  const index = getActiveSubtitleAtTime(currentTime);

  if (index !== -1) {
    const sub = currentSession.subtitles[index];
    const words = sub.text.split(' ');

    if (words.length <= 1) return;

    const mid = Math.ceil(words.length / 2);
    const midTime = sub.start + (sub.end - sub.start) / 2;

    const sub1 = { ...sub, text: words.slice(0, mid).join(' '), end: midTime };
    const sub2 = { ...sub, text: words.slice(mid).join(' '), start: midTime };

    currentSession.subtitles.splice(index, 1, sub1, sub2);
    renderLyricsList();
  }
}

function handleKeyPress(e) {
  if (e.key === 's' || e.key === 'S') {
    if (document.activeElement.tagName !== 'INPUT') {
      splitCurrentLyric();
    }
  }
}

function togglePlay() {
  const btn = document.getElementById('play-pause-btn');
  if (videoEl.paused) {
    videoEl.play();
    if (bgVideoEl) bgVideoEl.play();
    btn.textContent = '⏸ Pause';
  } else {
    videoEl.pause();
    if (bgVideoEl) bgVideoEl.pause();
    btn.textContent = '▶ Play';
  }
}

function seekVideo(time) {
  if (videoEl) videoEl.currentTime = parseFloat(time);
}

function updateTimeDisplay() {
  const cur = formatSecs(videoEl.currentTime || 0);
  const dur = formatSecs(videoEl.duration || 0);
  document.getElementById('time-display').textContent = `${cur} / ${dur}`;
}

function formatSecs(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderLyricsList() {
  const container = document.getElementById('lyrics-editor');
  const countLabel = document.getElementById('lyric-count');
  container.innerHTML = '';

  countLabel.textContent = `${currentSession.subtitles.length} Lines`;

  currentSession.subtitles.forEach((seg, index) => {
    const row = document.createElement('div');
    row.className = 'lyric-row';
    row.id = `lyric-row-${index}`;

    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.step = '0.1';
    startInput.value = seg.start.toFixed(1);
    startInput.onchange = (e) => currentSession.subtitles[index].start = parseFloat(e.target.value);

    const endInput = document.createElement('input');
    endInput.type = 'number';
    endInput.step = '0.1';
    endInput.value = seg.end.toFixed(1);
    endInput.onchange = (e) => currentSession.subtitles[index].end = parseFloat(e.target.value);

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = seg.text;
    textInput.oninput = (e) => currentSession.subtitles[index].text = e.target.value;

    row.appendChild(startInput);
    row.appendChild(endInput);
    row.appendChild(textInput);
    container.appendChild(row);
  });
}

function highlightActiveLyricRow() {
  const currentTime = videoEl.currentTime;
  const index = getActiveSubtitleAtTime(currentTime);

  document.querySelectorAll('.lyric-row').forEach(r => r.classList.remove('active'));
  if (index !== -1) {
    const activeRow = document.getElementById(`lyric-row-${index}`);
    if (activeRow) {
      activeRow.classList.add('active');
    }
  }
}

async function renderFinalVideo() {
  const statusContainer = document.getElementById('status-container');
  const errorContainer = document.getElementById('error-container');
  const resultContainer = document.getElementById('result-container');
  const step2 = document.getElementById('step-2');

  statusContainer.classList.remove('hidden');
  errorContainer.classList.add('hidden');

  const styles = {
    fontFamily: document.getElementById('fontFamily').value,
    fontSize: parseInt(document.getElementById('fontSize').value),
    transition: document.getElementById('transition').value,
    textColor: document.getElementById('textColor').value,
    outlineColor: document.getElementById('outlineColor').value
  };

  try {
    const response = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...currentSession, styles })
    });

    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Video render failed.');

    document.getElementById('output-video').src = result.downloadUrl;
    document.getElementById('download-btn').href = result.downloadUrl;

    step2.classList.add('hidden');
    resultContainer.classList.remove('hidden');
  } catch (err) {
    errorContainer.textContent = err.message;
    errorContainer.classList.remove('hidden');
  } finally {
    statusContainer.classList.add('hidden');
  }
}