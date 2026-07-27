/* Glitch Touch — hiệu ứng glitch bám theo đầu ngón tay, và glitch hình tam giác
   khi đưa 2 tay lên gần mặt. Theo dõi tay bằng MediaPipe Hands, chạy hoàn toàn
   trên trình duyệt (client-side), không cần server. */

(() => {
  const video      = document.getElementById('video');
  const videoCanvas = document.getElementById('videoCanvas');
  const fxCanvas    = document.getElementById('fxCanvas');
  const vCtx = videoCanvas.getContext('2d');
  const fCtx = fxCanvas.getContext('2d', { willReadFrequently: false });

  const startScreen = document.getElementById('startScreen');
  const startBtn     = document.getElementById('startBtn');
  const permErr       = document.getElementById('permErr');
  const statusPill    = document.getElementById('statusPill');
  const toneBtn       = document.getElementById('toneBtn');
  const flipBtn        = document.getElementById('flipBtn');

  // ---------- pixelated source canvas (for chunky glitch blocks) ----------
  const pixelCanvas = document.createElement('canvas');
  const pCtx = pixelCanvas.getContext('2d');
  const PIXEL_DIVISOR = 16; // higher = chunkier glitch blocks

  // ---------- glitch tone presets ----------
  const TONES = [
    { name: 'Teal',    filter: (t) => `invert(1) hue-rotate(150deg) saturate(2.3) contrast(1.15)` },
    { name: 'Violet',  filter: (t) => `invert(1) hue-rotate(265deg) saturate(2.4) contrast(1.1)` },
    { name: 'Rainbow', filter: (t) => `hue-rotate(${(t / 6) % 360}deg) saturate(3.2) contrast(1.2)` },
  ];
  let toneIndex = 0;

  let facingMode = 'user';
  let mirror = true;
  let stream = null;

  // ---------- camera ----------
  async function startCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } }
    });
    video.srcObject = stream;
    mirror = facingMode === 'user';
    await video.play();
  }

  // ---------- canvas sizing ----------
  function resizeCanvases() {
    const w = window.innerWidth, h = window.innerHeight;
    videoCanvas.width = w; videoCanvas.height = h;
    fxCanvas.width = w; fxCanvas.height = h;
    pixelCanvas.width = Math.max(8, Math.round(w / PIXEL_DIVISOR));
    pixelCanvas.height = Math.max(8, Math.round(h / PIXEL_DIVISOR));
  }
  window.addEventListener('resize', resizeCanvases);

  // ---------- MediaPipe Hands ----------
  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6
  });

  let latestHands = []; // array of 21-landmark arrays
  hands.onResults((results) => {
    latestHands = results.multiHandLandmarks || [];
  });

  async function detectLoop() {
    if (video.readyState >= 2) {
      try { await hands.send({ image: video }); } catch (e) { /* ignore transient errors */ }
    }
    requestAnimationFrame(detectLoop);
  }

  // ---------- coordinate mapping (object-fit: cover) ----------
  function mapPoint(lm) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const cw = videoCanvas.width, ch = videoCanvas.height;
    if (!vw || !vh) return { x: 0, y: 0 };
    const scale = Math.max(cw / vw, ch / vh);
    const drawW = vw * scale, drawH = vh * scale;
    const offsetX = (cw - drawW) / 2, offsetY = (ch - drawH) / 2;
    let x = offsetX + lm.x * vw * scale;
    const y = offsetY + lm.y * vh * scale;
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

  function updatePixelSource() {
    pCtx.imageSmoothingEnabled = true;
    pCtx.drawImage(videoCanvas, 0, 0, pixelCanvas.width, pixelCanvas.height);
  }

  // ---------- glitch rendering ----------
  function paintGlitchInClip(bboxX, bboxY, bboxW, bboxH, t) {
    const cw = fxCanvas.width, ch = fxCanvas.height;
    fCtx.save();
    fCtx.clip();
    fCtx.imageSmoothingEnabled = false;
    fCtx.filter = TONES[toneIndex].filter(t);

    // base pixelated layer, slight random shimmer offset
    const jitter = () => (Math.random() - 0.5) * 10;
    if (Math.random() > 0.08) { // occasional dropout flicker
      fCtx.globalAlpha = 0.92;
      fCtx.drawImage(pixelCanvas, 0, 0, cw, ch);
    }

    // chromatic-aberration-style extra passes
    fCtx.globalCompositeOperation = 'lighter';
    fCtx.globalAlpha = 0.55;
    fCtx.drawImage(pixelCanvas, jitter(), jitter(), cw, ch);
    fCtx.globalAlpha = 0.4;
    fCtx.drawImage(pixelCanvas, jitter(), jitter(), cw, ch);

    fCtx.globalCompositeOperation = 'source-over';
    fCtx.filter = 'none';
    fCtx.globalAlpha = 1;

    // random noise scanlines within the bbox for flicker texture
    const lines = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < lines; i++) {
      const ly = bboxY + Math.random() * bboxH;
      const lh = 1 + Math.random() * 3;
      fCtx.fillStyle = `rgba(255,255,255,${(Math.random() * 0.25).toFixed(2)})`;
      fCtx.fillRect(bboxX, ly, bboxW, lh);
    }

    fCtx.restore();
  }

  function fingertipClipPath(p, size) {
    fCtx.beginPath();
    const w = size * 0.55, h = size * 1.3;
    const r = w * 0.4;
    const x = p.x - w / 2, y = p.y - h / 2;
    fCtx.moveTo(x + r, y);
    fCtx.arcTo(x + w, y, x + w, y + h, r);
    fCtx.arcTo(x + w, y + h, x, y + h, r);
    fCtx.arcTo(x, y + h, x, y, r);
    fCtx.arcTo(x, y, x + w, y, r);
    fCtx.closePath();
    return { x: x - 4, y: y - 4, w: w + 8, h: h + 8 };
  }

  function bowtieClipPath(leftTip, leftBase, rightTip, rightBase) {
    const center = { x: (leftTip.x + rightTip.x) / 2, y: (leftTip.y + rightTip.y) / 2 };
    fCtx.beginPath();
    fCtx.moveTo(leftTip.x, leftTip.y);
    fCtx.lineTo(leftBase.x, leftBase.y);
    fCtx.lineTo(center.x, center.y);
    fCtx.closePath();
    fCtx.moveTo(rightTip.x, rightTip.y);
    fCtx.lineTo(rightBase.x, rightBase.y);
    fCtx.lineTo(center.x, center.y);
    fCtx.closePath();
    const xs = [leftTip.x, leftBase.x, rightTip.x, rightBase.x, center.x];
    const ys = [leftTip.y, leftBase.y, rightTip.y, rightBase.y, center.y];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ---------- main render loop ----------
  function renderLoop(t) {
    drawVideoFrame();
    updatePixelSource();
    fCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);

    const n = latestHands.length;
    if (n === 0) {
      statusPill.textContent = 'Đang tìm bàn tay…';
    } else if (n === 1) {
      statusPill.textContent = 'Glitch đầu ngón tay';
      const tip = mapPoint(latestHands[0][8]);
      const pip = mapPoint(latestHands[0][6]);
      const dist = Math.hypot(tip.x - pip.x, tip.y - pip.y) || 30;
      const box = fingertipClipPath(tip, Math.max(34, dist * 1.6));
      paintGlitchInClip(box.x, box.y, box.w, box.h, t);
    } else {
      statusPill.textContent = 'Glitch tam giác 2 tay';
      // sort hands left-to-right by wrist x so the shape stays stable
      const withPos = latestHands.slice(0, 2).map((lm) => ({
        tip: mapPoint(lm[8]), base: mapPoint(lm[0])
      }));
      withPos.sort((a, b) => a.tip.x - b.tip.x);
      const [L, R] = withPos;
      const box = bowtieClipPath(L.tip, L.base, R.tip, R.base);
      paintGlitchInClip(box.x, box.y, box.w, box.h, t);

      // small fingertip glitch too, for extra life
      const box2 = fingertipClipPath(L.tip, 30);
      paintGlitchInClip(box2.x, box2.y, box2.w, box2.h, t);
      const box3 = fingertipClipPath(R.tip, 30);
      paintGlitchInClip(box3.x, box3.y, box3.w, box3.h, t);
    }

    requestAnimationFrame(renderLoop);
  }

  // ---------- controls ----------
  toneBtn.addEventListener('click', () => {
    toneIndex = (toneIndex + 1) % TONES.length;
    toneBtn.title = 'Tông màu: ' + TONES[toneIndex].name;
  });
  flipBtn.addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
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
      requestAnimationFrame(renderLoop);
    } catch (err) {
      console.error(err);
      permErr.style.display = 'block';
      startBtn.disabled = false;
      startBtn.textContent = 'Bật camera & bắt đầu';
    }
  });

  resizeCanvases();
})();
