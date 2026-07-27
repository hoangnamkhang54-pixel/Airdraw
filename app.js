/* Air Ink — vẽ trong không khí bằng ngón trỏ, theo dõi tay bằng MediaPipe Hands.
   Toàn bộ chạy trên trình duyệt (client-side), không cần server. */

(() => {
  const video        = document.getElementById('video');
  const videoCanvas   = document.getElementById('videoCanvas');
  const drawCanvas    = document.getElementById('drawCanvas');
  const cursorCanvas  = document.getElementById('cursorCanvas');
  const vCtx = videoCanvas.getContext('2d');
  const dCtx = drawCanvas.getContext('2d');
  const cCtx = cursorCanvas.getContext('2d');

  const startScreen = document.getElementById('startScreen');
  const startBtn    = document.getElementById('startBtn');
  const permErr      = document.getElementById('permErr');
  const statusPill   = document.getElementById('statusPill');
  const colorRail    = document.getElementById('colorRail');
  const undoBtn      = document.getElementById('undoBtn');
  const clearBtn     = document.getElementById('clearBtn');
  const penBtn       = document.getElementById('penBtn');
  const flipBtn      = document.getElementById('flipBtn');

  const COLORS = [
    { id: 'cyan',   value: '#5eead4' },
    { id: 'violet', value: '#a78bfa' },
    { id: 'pink',   value: '#f472b6' },
    { id: 'amber',  value: '#fbbf24' },
    { id: 'lime',   value: '#a3e635' },
    { id: 'white',  value: '#f8fafc' },
    { id: 'eraser', value: 'eraser' },
  ];

  let currentColor = COLORS[0].value;
  let facingMode = 'user';
  let mirror = true;
  let penEnabled = true;
  let strokes = [];       // history of completed/ongoing strokes for undo
  let activeStroke = null;
  let lastPoint = null;
  let handPresent = false;
  let hoveredSwatchEl = null;

  // ---------- build color rail ----------
  const swatchEls = COLORS.map(c => {
    const el = document.createElement('div');
    el.className = 'swatch';
    el.dataset.color = c.value;
    if (c.id === 'eraser') {
      el.textContent = '⌫';
    } else {
      el.style.background = c.value;
    }
    if (c.value === currentColor) el.classList.add('active');
    colorRail.appendChild(el);
    return el;
  });

  function selectColor(value) {
    currentColor = value;
    swatchEls.forEach(el => el.classList.toggle('active', el.dataset.color === value));
  }
  swatchEls.forEach(el => {
    el.addEventListener('click', () => selectColor(el.dataset.color));
  });

  // ---------- canvas sizing ----------
  function resizeCanvases() {
    const w = window.innerWidth, h = window.innerHeight;
    [videoCanvas, drawCanvas, cursorCanvas].forEach(c => {
      // preserve drawing when resizing the draw canvas
      c.width = w; c.height = h;
    });
    redrawStrokes();
  }
  window.addEventListener('resize', resizeCanvases);

  // ---------- camera ----------
  let stream = null;
  async function startCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } }
    });
    video.srcObject = stream;
    mirror = facingMode === 'user';
    await video.play();
  }

  // ---------- MediaPipe Hands ----------
  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6
  });

  let latestLandmarks = null;
  hands.onResults((results) => {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      latestLandmarks = results.multiHandLandmarks[0];
      handPresent = true;
    } else {
      latestLandmarks = null;
      handPresent = false;
    }
  });

  async function detectLoop() {
    if (video.readyState >= 2) {
      try { await hands.send({ image: video }); } catch (e) { /* ignore transient errors */ }
    }
    requestAnimationFrame(detectLoop);
  }

  // ---------- coordinate mapping (object-fit: cover) ----------
  function mapPoint(nx, ny) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const cw = videoCanvas.width, ch = videoCanvas.height;
    if (!vw || !vh) return null;
    const scale = Math.max(cw / vw, ch / vh);
    const drawW = vw * scale, drawH = vh * scale;
    const offsetX = (cw - drawW) / 2, offsetY = (ch - drawH) / 2;
    let x = offsetX + nx * vw * scale;
    const y = offsetY + ny * vh * scale;
    if (mirror) x = cw - x;
    return { x, y };
  }

  function drawVideoFrame() {
    const cw = videoCanvas.width, ch = videoCanvas.height;
    const vw = video.videoWidth, vh = video.videoHeight;
    vCtx.clearRect(0, 0, cw, ch);
    if (!vw || !vh) return;
    const scale = Math.max(cw / vw, ch / vh);
    const drawW = vw * scale, drawH = vh * scale;
    const offsetX = (cw - drawW) / 2, offsetY = (ch - drawH) / 2;
    vCtx.save();
    if (mirror) { vCtx.translate(cw, 0); vCtx.scale(-1, 1); }
    vCtx.drawImage(video, offsetX, offsetY, drawW, drawH);
    vCtx.restore();
  }

  // ---------- stroke rendering ----------
  function strokeStyleFor(color, ctx) {
    if (color === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 46;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 7;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function drawSegment(ctx, color, p0, p1) {
    strokeStyleFor(color, ctx);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
  }

  function redrawStrokes() {
    dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    for (const s of strokes) {
      for (let i = 1; i < s.points.length; i++) {
        drawSegment(dCtx, s.color, s.points[i - 1], s.points[i]);
      }
    }
  }

  // ---------- color rail hit-test ----------
  function checkColorHover(px, py) {
    let hit = null;
    for (const el of swatchEls) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist < r.width * 0.9) { hit = el; break; }
    }
    if (hoveredSwatchEl && hoveredSwatchEl !== hit) hoveredSwatchEl.classList.remove('hover');
    if (hit) {
      hit.classList.add('hover');
      selectColor(hit.dataset.color);
    }
    hoveredSwatchEl = hit;
    return !!hit;
  }

  // ---------- main render loop ----------
  function renderLoop() {
    drawVideoFrame();
    cCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

    if (handPresent && latestLandmarks) {
      statusPill.textContent = penEnabled ? 'Đang vẽ' : 'Tạm dừng vẽ';
      const tip = latestLandmarks[8];   // index fingertip
      const p = mapPoint(tip.x, tip.y);

      if (p) {
        const overColor = checkColorHover(p.x, p.y);

        // cursor dot
        cCtx.beginPath();
        cCtx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        cCtx.fillStyle = currentColor === 'eraser' ? 'rgba(255,255,255,0.5)' : currentColor;
        cCtx.globalAlpha = 0.9;
        cCtx.fill();
        cCtx.globalAlpha = 1;

        const shouldDraw = penEnabled && !overColor;
        if (shouldDraw) {
          if (!activeStroke) {
            activeStroke = { color: currentColor, points: [p] };
            strokes.push(activeStroke);
            lastPoint = p;
          } else {
            drawSegment(dCtx, activeStroke.color, lastPoint, p);
            activeStroke.points.push(p);
            lastPoint = p;
          }
        } else {
          activeStroke = null;
          lastPoint = null;
        }
      }
    } else {
      statusPill.textContent = 'Đang tìm bàn tay…';
      activeStroke = null;
      lastPoint = null;
      if (hoveredSwatchEl) { hoveredSwatchEl.classList.remove('hover'); hoveredSwatchEl = null; }
    }

    requestAnimationFrame(renderLoop);
  }

  // ---------- controls ----------
  undoBtn.addEventListener('click', () => {
    strokes.pop();
    activeStroke = null; lastPoint = null;
    redrawStrokes();
  });
  clearBtn.addEventListener('click', () => {
    strokes = []; activeStroke = null; lastPoint = null;
    redrawStrokes();
  });
  penBtn.addEventListener('click', () => {
    penEnabled = !penEnabled;
    penBtn.textContent = penEnabled ? '✏️' : '⏸️';
    penBtn.classList.toggle('off', !penEnabled);
    activeStroke = null; lastPoint = null;
  });
  flipBtn.addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    activeStroke = null; lastPoint = null;
    try { await startCamera(); } catch (e) { console.error(e); }
  });

  // ---------- boot ----------
  startBtn.addEventListener('click', async () => {
    try {
      startBtn.disabled = true;
      startBtn.textContent = 'Đang mở camera…';
      await startCamera();
      resizeCanvases();
      startScreen.style.display = 'none';
      detectLoop();
      renderLoop();
    } catch (err) {
      console.error(err);
      permErr.style.display = 'block';
      startBtn.disabled = false;
      startBtn.textContent = 'Bật camera & bắt đầu vẽ';
    }
  });

  resizeCanvases();
})();
