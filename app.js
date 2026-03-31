/**
 * SimpleRec - Logiciel d'enregistrement & Éditeur audio web
 * Vanilla JS, API Web Audio, MediaRecorder & FFmpeg.wasm sur demande
 */

// --- Variables d'état Globales ---
let mediaRecorder;
let audioChunks = [];
let audioContext;
let analyser;
let micStream;
let isRecording = false;
let isPaused = false;
let startTime = 0;
let pausedTime = 0;
let timerInterval;
let reqAnimFrameId;

// Éditeur & AudioBuffer
let originalAudioBuffer = null;
let currentAudioBuffer = null;
let undoStack = []; // Max 5 éléments
let sourceNode = null; // Pour la lecture dans l'éditeur
let isPlaying = false;
let playbackStartTime = 0;
let playbackOffset = 0;
let playheadAnimId = 0; // Séparé de reqAnimFrameId (visualisation enregistrement)
let waveformCanvasCtx;
let waveformWidth;
let waveformHeight;

// Sélection dans l'éditeur (en secondes)
let selectionStart = 0;
let selectionEnd = 0;
let isDragging = false;
let dragStartX = 0;

// Zoom waveform (Nouvelle implémentation Viewport PPS)
let pps = 50; // Pixels Per Second
let viewportStart = 0; // en secondes
let audioPeaks = null; // Cache des min/max pour dessiner vite
let lastTouchDist = 0;
let isScrollbarDragging = false;

// FFmpeg état
let ffmpegInstance = null;
let isFFmpegLoaded = false;

// Suivi export (pour incrémenter le numéro de fichier après export)
let hasExported = false;

// Preview micro (monitoring sans enregistrement)
let previewStream = null;
let previewAnimId = 0;

// Animation idle de secours (en attente des permissions)
let idleAnimId = 0;

// --- DOM Éléments ---
const UI = {
    // Section Enregistrement
    secRec: document.getElementById('recording-section'),
    micSelect: document.getElementById('mic-select'),
    filenameInput: document.getElementById('filename-input'),
    btnRec: document.getElementById('btn-record'),
    btnPause: document.getElementById('btn-pause'),
    btnStop: document.getElementById('btn-stop'),
    timerDisplay: document.getElementById('timer-display'),
    recIndicator: document.getElementById('recording-indicator'),
    spectrumCanvas: document.getElementById('spectrum-canvas'),
    vuCanvas: document.getElementById('vu-canvas'),
    vuValue: document.getElementById('vu-value'),
    micErrorMsg: document.getElementById('mic-error-msg'),
    
    // Section Éditeur
    secEdit: document.getElementById('editor-section'),
    btnUndo: document.getElementById('btn-undo'),
    waveformContainer: document.getElementById('waveform-container'),
    waveformCanvas: document.getElementById('waveform-canvas'),
    selectionLayer: document.getElementById('selection-layer'),
    playhead: document.getElementById('playhead'),
    zoomIndicator: document.getElementById('zoom-indicator'),
    scrollTrack: document.getElementById('waveform-scroll-track'),
    scrollThumb: document.getElementById('waveform-scroll-thumb'),
    btnPlay: document.getElementById('btn-play'),
    btnStopPlayback: document.getElementById('btn-stop-playback'),
    btnCutSel: document.getElementById('btn-cut-selection'),
    btnCutBefore: document.getElementById('btn-cut-before'),
    btnCutAfter: document.getElementById('btn-cut-after'),
    btnNormalize: document.getElementById('btn-normalize'),
    
    // Export & Global
    exportFormat: document.getElementById('export-format'),
    bitrateGroup: document.getElementById('bitrate-group'),
    bitrateLabel: document.getElementById('bitrate-label'),
    exportBitrate: document.getElementById('export-bitrate'),
    exportChannels: document.getElementById('export-channels'),
    btnExport: document.getElementById('btn-export'),
    exportSizeEst: document.getElementById('export-size-estimate'),
    exportProgress: document.getElementById('export-progress'),
    exportProgressFill: document.getElementById('export-progress-fill'),
    exportProgressLabel: document.getElementById('export-progress-label'),
    exportProgressPct: document.getElementById('export-progress-pct'),
    btnNewRec: document.getElementById('btn-new-rec'),
    btnOpenFileRec: document.getElementById('btn-open-file-rec'),
    btnOpenFileEdit: document.getElementById('btn-open-file-edit'),
    openFileInput: document.getElementById('open-file-input'),
    globalStatus: document.getElementById('global-status')
};

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateStatus(msg) {
    UI.globalStatus.textContent = msg;
}

// ==========================================
// 1. INITIALISATION & CAPTURE
// ==========================================

async function initDevices() {
    try {
        // Demande la permission puis ferme immédiatement ce stream temporaire
        const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        permStream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        UI.micSelect.innerHTML = '';
        if (audioInputs.length === 0) {
            UI.micSelect.innerHTML = '<option value="">Aucun microphone détecté</option>';
            return;
        }

        audioInputs.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Microphone ${UI.micSelect.length + 1}`;
            UI.micSelect.appendChild(option);
        });

        startPreview(); // Démarre le monitoring audio dès que les périphériques sont prêts

    } catch (err) {
        UI.micErrorMsg.textContent = "Erreur: Accès au microphone refusé ou impossible. Veuillez autoriser l'accès.";
        UI.micErrorMsg.style.display = 'block';
        UI.btnRec.disabled = true;
    }
}

async function startRecording() {
    try {
        const deviceId = UI.micSelect.value;
        const constraints = {
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        };

        micStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Stopper preview et animation idle avant la visualisation réelle
        stopPreview();
        cancelAnimationFrame(idleAnimId);

        // Setup AudioContext pour la visualisation (réutiliser ou créer)
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        } else if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        const source = audioContext.createMediaStreamSource(micStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);

        // Setup MediaRecorder
        const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
        let selectedMimeType = '';
        for (let mime of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mime)) {
                selectedMimeType = mime;
                break;
            }
        }

        mediaRecorder = new MediaRecorder(micStream, { mimeType: selectedMimeType });
        audioChunks = [];

        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = processRecording;

        mediaRecorder.start(100);
        
        isRecording = true;
        isPaused = false;
        startTime = Date.now();
        
        // UI Updates
        UI.btnRec.disabled = true;
        UI.btnPause.disabled = false;
        UI.btnStop.disabled = false;
        UI.micSelect.disabled = true;
        
        UI.recIndicator.className = 'recording';
        updateStatus("Enregistrement en cours...");
        
        timerInterval = setInterval(updateTimer, 100);
        drawVisualizers();

    } catch (err) {
        console.error(err);
        alert("Erreur lors du démarrage de l'enregistrement: " + err.message);
    }
}

function pauseRecording() {
    if (!isRecording) return;
    
    if (mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
        isPaused = true;
        clearInterval(timerInterval);
        UI.recIndicator.className = 'paused';
        UI.btnPause.innerHTML = '<span class="icon">▶</span> REPRENDRE';
        UI.btnPause.classList.replace('btn-warning', 'btn-success');
        updateStatus("Enregistrement en pause");
    } else if (mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
        isPaused = false;
        // Ajuster le startTime pour ignorer la durée de la pause
        startTime += (Date.now() - pausedTime);
        timerInterval = setInterval(updateTimer, 100);
        UI.recIndicator.className = 'recording';
        UI.btnPause.innerHTML = '<span class="icon">⏸</span> PAUSE';
        UI.btnPause.classList.replace('btn-success', 'btn-warning');
        updateStatus("Enregistrement en cours...");
    }
    
    if(isPaused) {
        pausedTime = Date.now();
    }
}

function stopRecording() {
    if (!isRecording) return;
    
    mediaRecorder.stop();
    micStream.getTracks().forEach(track => track.stop());
    clearInterval(timerInterval);
    cancelAnimationFrame(reqAnimFrameId);
    
    isRecording = false;
    isPaused = false;
    
    // UI Updates
    UI.btnRec.disabled = false;
    UI.btnPause.disabled = true;
    UI.btnStop.disabled = true;
    UI.micSelect.disabled = false;
    
    UI.recIndicator.className = 'idle';
    UI.btnPause.innerHTML = '<span class="icon">⏸</span> PAUSE';
    UI.btnPause.classList.replace('btn-success', 'btn-warning');
    updateStatus("Traitement de l'audio...");
}

function updateTimer() {
    const elapsed = Date.now() - startTime;
    UI.timerDisplay.textContent = formatTime(elapsed);
}

// ==========================================
// 2. VISUALISATION EN TEMPS RÉEL
// ==========================================

// Dessin partagé spectre + VU — utilisé par preview ET enregistrement
function renderAudioFrame() {
    const canvasSpec = UI.spectrumCanvas;
    const ctxSpec = canvasSpec.getContext('2d');
    const w = canvasSpec.width, h = canvasSpec.height;
    const canvasVu = UI.vuCanvas;
    const ctxVu = canvasVu.getContext('2d');
    const wv = canvasVu.width, hv = canvasVu.height;

    const bufLen = analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufLen);
    const timeData = new Float32Array(bufLen);
    analyser.getByteFrequencyData(freqData);
    analyser.getFloatTimeDomainData(timeData);

    // Spectre
    ctxSpec.fillStyle = '#111';
    ctxSpec.fillRect(0, 0, w, h);
    const bw = (w / bufLen) * 2.5;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
        const bh = (freqData[i] / 255) * h;
        const r = Math.round(73 + bh * 0.5);
        const g = Math.round(79 + 80 * (i / bufLen));
        const b = Math.round(214 - 30 * (bh / h));
        ctxSpec.fillStyle = `rgb(${r},${g},${b})`;
        ctxSpec.fillRect(x, h - bh, bw, bh);
        x += bw + 1;
        if (x > w) break;
    }

    // VU Meter — RMS → dB
    let sum = 0;
    for (let i = 0; i < bufLen; i++) sum += timeData[i] * timeData[i];
    let db = 20 * Math.log10(Math.sqrt(sum / bufLen));
    if (!isFinite(db)) db = -100;
    const minDB = -60;
    const vuH = Math.max(0, (db - minDB) / (-minDB)) * hv;
    ctxVu.fillStyle = '#111';
    ctxVu.fillRect(0, 0, wv, hv);
    ctxVu.fillStyle = db > -3 ? '#ef4444' : db > -10 ? '#f59e0b' : '#10b981';
    ctxVu.fillRect(0, hv - vuH, wv, vuH);
    UI.vuValue.textContent = db <= minDB ? '-∞ dB' : db.toFixed(1) + ' dB';
}

// --- Preview micro (monitoring sans enregistrement) ---
async function startPreview() {
    stopPreview();
    cancelAnimationFrame(idleAnimId);

    const deviceId = UI.micSelect.value;
    if (!deviceId) { startIdleAnimation(); return; }

    try {
        previewStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: { exact: deviceId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        } else if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const source = audioContext.createMediaStreamSource(previewStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);

        function render() {
            if (isRecording || !previewStream) return; // cède la main à l'enregistrement
            previewAnimId = requestAnimationFrame(render);
            renderAudioFrame();
        }
        previewAnimId = requestAnimationFrame(render);

    } catch(e) {
        startIdleAnimation(); // Fallback si le micro est inaccessible
    }
}

function stopPreview() {
    cancelAnimationFrame(previewAnimId);
    if (previewStream) {
        previewStream.getTracks().forEach(t => t.stop());
        previewStream = null;
    }
}

// --- Animation idle de secours (avant permission micro) ---
function startIdleAnimation() {
    cancelAnimationFrame(idleAnimId);

    const canvasSpec = UI.spectrumCanvas;
    const ctxSpec = canvasSpec.getContext('2d');
    const w = canvasSpec.width, h = canvasSpec.height;
    const canvasVu = UI.vuCanvas;
    const ctxVu = canvasVu.getContext('2d');
    const wv = canvasVu.width, hv = canvasVu.height;
    const barCount = 48;
    const barW = (w / barCount) * 0.75;

    function render(ts) {
        if (isRecording || previewStream) return;
        idleAnimId = requestAnimationFrame(render);
        const t = ts / 1000;
        ctxSpec.fillStyle = '#111';
        ctxSpec.fillRect(0, 0, w, h);
        for (let i = 0; i < barCount; i++) {
            const wave = Math.sin(i * 0.35 + t * 0.9) * 0.5 + 0.5;
            const breath = (Math.sin(t * 0.4 + i * 0.1) * 0.5 + 0.5) * 0.06;
            const bh = Math.max(2, wave * breath * h);
            ctxSpec.fillStyle = `rgb(${Math.round(73 + bh * 0.6)},${Math.round(79 + 80 * (i / barCount))},214)`;
            ctxSpec.fillRect(i * (w / barCount), h - bh, barW, bh);
        }
        ctxVu.fillStyle = '#111';
        ctxVu.fillRect(0, 0, wv, hv);
        const vuH = (Math.sin(t * 0.6) * 0.5 + 0.5) * 0.04 * hv;
        ctxVu.fillStyle = '#10b981';
        ctxVu.fillRect(0, hv - vuH, wv, vuH);
        UI.vuValue.textContent = '-∞ dB';
    }
    idleAnimId = requestAnimationFrame(render);
}

function drawVisualizers() {
    if (!isRecording && !isPaused) return;

    function render() {
        if (!isRecording) return;
        reqAnimFrameId = requestAnimationFrame(render);
        renderAudioFrame();
    }
    render();
}

// ==========================================
// 3. POST-ENREGISTREMENT & ÉDITEUR
// ==========================================

async function processRecording() {
    try {
        const type = audioChunks[0]?.type || 'audio/webm';
        const blob = new Blob(audioChunks, { type });
        
        // Decode blob to AudioBuffer
        const arrayBuffer = await blob.arrayBuffer();
        if(!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        
        currentAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        // --- Mixage mono symétrique forcé (sécurité maximale contre les canaux muets) ---
        enforceSymmetricChannels(currentAudioBuffer);

        undoStack = [cloneAudioBuffer(currentAudioBuffer)]; // Init undo
        
        showEditor();
        renderWaveform();
        updateEstimateSize();
        updateStatus("Prêt pour l'édition");
        
    } catch (err) {
        console.error("Décodage audio: ", err);
        updateStatus("Erreur de décodage audio");
    }
}

function enforceSymmetricChannels(buffer) {
    if (buffer.numberOfChannels !== 2) return;
    const l = buffer.getChannelData(0);
    const r = buffer.getChannelData(1);
    const N = buffer.length;

    // Calcul de l'énergie RMS de chaque canal pour détecter le canal porteur du signal
    let energyL = 0, energyR = 0;
    for (let i = 0; i < N; i++) {
        energyL += l[i] * l[i];
        energyR += r[i] * r[i];
    }

    // Si un canal est quasi-silencieux (<1% de l'énergie de l'autre), on utilise le canal actif pour les deux
    if (energyR < energyL * 0.0001) {
        for (let i = 0; i < N; i++) r[i] = l[i];
        return;
    }
    if (energyL < energyR * 0.0001) {
        for (let i = 0; i < N; i++) l[i] = r[i];
        return;
    }

    // Les deux canaux ont du signal : stéréo réel, on ne touche pas.
}

function computeAudioPeaks(buffer) {
    // getChannelData() appelé UNE SEULE FOIS et mis en cache.
    // Brave ajoute du bruit in-place à chaque appel (anti-fingerprinting) :
    // appeler getChannelData() à chaque render corromprait progressivement le buffer.
    const channelData = buffer.getChannelData(0);
    const length = buffer.length;
    const bucketSize = 256;
    const numBuckets = Math.ceil(length / bucketSize);

    const peaks = new Float32Array(numBuckets * 2);

    for (let i = 0; i < numBuckets; i++) {
        let min = 1.0;
        let max = -1.0;
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, length);

        for (let j = start; j < end; j++) {
            const v = channelData[j];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        peaks[i * 2] = min;
        peaks[i * 2 + 1] = max;
    }

    audioPeaks = { data: peaks, bucketSize, length, lastBuffer: buffer, ch0: channelData };
}

function showEditor() {
    UI.secRec.style.display = 'none';
    UI.secEdit.style.display = 'flex';

    viewportStart = 0;
    audioPeaks    = null;
    UI.zoomIndicator.textContent = '1×';
    UI.scrollTrack.classList.remove('visible');
    waveformCanvasCtx = UI.waveformCanvas.getContext('2d');
    resetSelection();
    updateUndoBtn();

    // Calcul de pps après reflow (clientWidth disponible seulement après display:flex)
    // → ajuste pour montrer tout l'audio d'un coup à l'ouverture
    requestAnimationFrame(() => {
        if (!currentAudioBuffer) return;
        const cssW = UI.waveformContainer.clientWidth || 1;
        pps = cssW / currentAudioBuffer.duration;
        // console.log(`[showEditor] cssW=${cssW}  dur=${currentAudioBuffer.duration.toFixed(3)}s  pps=${pps.toFixed(2)}`);
        renderWaveform();
        updateScrollbar();
    });
}

function closeEditor() {
    if(isPlaying) stopPlayback();
    audioChunks = [];
    currentAudioBuffer = null;
    undoStack = [];

    if (hasExported) {
        const current = UI.filenameInput.value.trim();
        const match = current.match(/^(.*?)(\d+)$/);
        if (match) {
            const next = (parseInt(match[2], 10) + 1).toString().padStart(match[2].length, '0');
            UI.filenameInput.value = match[1] + next;
        }
        hasExported = false;
    }

    UI.secEdit.style.display = 'none';
    UI.secRec.style.display = 'block';
    UI.timerDisplay.textContent = '00:00:00';
    updateStatus("Prêt");
    startPreview(); // Reprend le monitoring micro
}

// ==========================================
// VIEWPORT, RENDU & NAVIGATION WAVEFORM
// ==========================================
//
// Règle d'or : toute la logique interne utilise des CSS-pixels et des secondes.
// Le DPR (devicePixelRatio) n'intervient QUE pour calculer les coordonnées
// physiques du canvas lors du tracé.
//
// pps          = CSS-pixels par seconde  (état de zoom)
// viewportStart = offset gauche en secondes  (état de scroll)

/** CSS-pixel → temps absolu (s) */
function pixelToTime(cssPx) {
    return viewportStart + cssPx / pps;
}

/** Temps absolu (s) → CSS-pixel */
function timeToPixel(sec) {
    return (sec - viewportStart) * pps;
}

/** Borne pps et viewportStart pour ne jamais déborder de l'audio. */
function clampViewport() {
    if (!currentAudioBuffer) return;
    const cssW       = UI.waveformContainer.clientWidth || 1;
    const dur        = currentAudioBuffer.duration;
    const visibleDur = cssW / pps;

    if (visibleDur >= dur) {
        // Dézoomé : tout rentre dans la vue
        viewportStart = 0;
    } else {
        viewportStart = Math.max(0, Math.min(dur - visibleDur, viewportStart));
    }

}

/** Synchronise les dimensions physiques du canvas avec le conteneur CSS. */
function syncCanvasSize() {
    const rect = UI.waveformContainer.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    const phyW = Math.round(rect.width  * dpr);
    const phyH = Math.round(rect.height * dpr);
    if (!phyW || !phyH) return false;
    if (UI.waveformCanvas.width !== phyW || UI.waveformCanvas.height !== phyH) {
        UI.waveformCanvas.width  = phyW;
        UI.waveformCanvas.height = phyH;
        waveformCanvasCtx = UI.waveformCanvas.getContext('2d');
    }
    return true;
}

/** Dessine la waveform (min/max par pixel) dans le canvas. */
function renderWaveform() {
    if (!currentAudioBuffer) return;
    if (!audioPeaks || audioPeaks.lastBuffer !== currentAudioBuffer) {
        computeAudioPeaks(currentAudioBuffer);
    }
    if (!syncCanvasSize()) return;

    const physW = UI.waveformCanvas.width;
    const physH = UI.waveformCanvas.height;
    const dpr   = window.devicePixelRatio || 1;
    const ctx   = waveformCanvasCtx;

    ctx.clearRect(0, 0, physW, physH);

    const sr           = currentAudioBuffer.sampleRate;
    const totalSamples = currentAudioBuffer.length;
    const halfH        = physH / 2;

    // Combien d'échantillons couvre 1 CSS-pixel ?
    const spCss = sr / pps;


    const peaks    = audioPeaks.data;
    const bSize    = audioPeaks.bucketSize;
    const ch0      = audioPeaks.ch0;   // référence cachée, pas de nouvel appel getChannelData()
    const maxBuck  = peaks.length / 2;

    ctx.fillStyle = '#494fd6';

    for (let px = 0; px < physW; px++) {
        // Position CSS-pixel (fractionnaire) du pixel physique px
        const cssPx = px / dpr;

        // Plage d'échantillons couverte par ce pixel physique
        const sA = Math.floor(viewportStart * sr + cssPx          * spCss);
        const sB = Math.floor(viewportStart * sr + (cssPx + 1/dpr) * spCss);
        const sBc = Math.min(Math.max(sA + 1, sB), totalSamples);

        if (sA >= totalSamples) break;

        let mn = 0, mx = 0;

        if (spCss < bSize) {
            // Zoom serré : échantillon par échantillon
            for (let s = sA; s < sBc; s++) {
                const v = ch0[s];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
        } else {
            // Vue large : cache MIPMap
            const bA = Math.floor(sA / bSize);
            const bB = Math.ceil(sBc / bSize);
            for (let b = bA; b < bB && b < maxBuck; b++) {
                if (peaks[b * 2]     < mn) mn = peaks[b * 2];
                if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1];
            }
        }

        // Formule Y correcte :
        //   valeur +1 (pic positif) → y = 0  (haut du canvas)
        //   valeur  0 (silence)     → y = halfH (milieu)
        //   valeur -1 (pic négatif) → y = physH (bas du canvas)
        const yTop = (1 - mx) * halfH;
        const yBot = (1 - mn) * halfH;
        ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
    }
}

/** Met à jour la scrollbar (thumb position + taille) et l'indicateur ×. */
function updateScrollbar() {
    if (!currentAudioBuffer) return;
    const dur = currentAudioBuffer.duration;
    if (dur <= 0) return;

    const cssW       = UI.waveformContainer.clientWidth;
    const visibleDur = cssW / pps;
    const isZoomed   = visibleDur < dur - 0.01;

    if (!isZoomed) {
        UI.scrollTrack.classList.remove('visible');
        UI.zoomIndicator.textContent = '1×';
        return;
    }

    UI.scrollTrack.classList.add('visible');

    // Fraction visible : largeur du thumb
    const thumbFrac = Math.max(0.02, visibleDur / dur);
    // Plage scrollable : dur - visibleDur secondes → (1 - thumbFrac) de la piste
    const scrollable = dur - visibleDur;
    const thumbLeft  = scrollable > 0 ? (viewportStart / scrollable) * (1 - thumbFrac) : 0;

    UI.scrollThumb.style.width = (thumbFrac * 100).toFixed(3) + '%';
    UI.scrollThumb.style.left  = (thumbLeft  * 100).toFixed(3) + '%';

    const zLvl = dur / visibleDur;
    UI.zoomIndicator.textContent = zLvl.toFixed(zLvl < 10 ? 1 : 0) + '×';
}

/** Overlay de sélection (positionné en CSS-pixels). */
function renderSelectionOverlay() {
    if (!currentAudioBuffer) {
        UI.selectionLayer.style.display = 'none';
        return;
    }
    const cssW  = UI.waveformContainer.clientWidth;
    const left  = Math.max(0, timeToPixel(selectionStart));
    const right = Math.min(cssW, timeToPixel(selectionEnd));

    // Hors écran
    if (right < 0 || left > cssW) { 
        UI.selectionLayer.style.display = 'none'; 
        return; 
    }

    UI.selectionLayer.style.display = 'block';
    if (selectionEnd - selectionStart < 0.001) {
        // Clic simple = Curseur
        UI.selectionLayer.style.left  = left + 'px';
        UI.selectionLayer.style.width = '2px';
        UI.selectionLayer.style.backgroundColor = '#ef4444'; // Curseur rouge
    } else {
        // Plage de sélection
        UI.selectionLayer.style.left  = left + 'px';
        UI.selectionLayer.style.width = Math.max(1, right - left) + 'px';
        UI.selectionLayer.style.backgroundColor = ''; // Remet la couleur par défaut du CSS
    }
}

// ------ Sélection souris ------

UI.waveformContainer.addEventListener('mousedown', e => {
    if (!currentAudioBuffer) return;
    isDragging  = true;
    dragStartX  = Math.max(0, Math.min(e.offsetX, UI.waveformContainer.clientWidth));
    selectionStart = pixelToTime(dragStartX);
    selectionEnd   = selectionStart;
    renderSelectionOverlay();
});

UI.waveformContainer.addEventListener('mousemove', e => {
    if (!isDragging || !currentAudioBuffer) return;
    const curX = Math.max(0, Math.min(e.offsetX, UI.waveformContainer.clientWidth));
    selectionStart = pixelToTime(Math.min(dragStartX, curX));
    selectionEnd   = pixelToTime(Math.max(dragStartX, curX));
    renderSelectionOverlay();
});

window.addEventListener('mouseup', () => {
    if (isDragging) { isDragging = false; checkSelection(); }
});

// ------ Zoom molette / Pan trackpad ------

UI.waveformContainer.addEventListener('wheel', e => {
    if (!currentAudioBuffer) return;
    e.preventDefault();
    if (isScrollbarDragging) return;

    const dur  = currentAudioBuffer.duration;
    const cssW = UI.waveformContainer.clientWidth;

    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Trackpad horizontal → pan
        viewportStart += e.deltaX / pps;
        clampViewport();
    } else {
        // Molette verticale → zoom centré sous le curseur
        const mouseX     = Math.max(0, Math.min(e.offsetX, cssW));
        const timeAnchor = pixelToTime(mouseX);  // point fixe sous la souris

        const factor = e.deltaY < 0 ? 1.25 : 0.8;
        const minPps = cssW / dur;               // zoom minimum : tout l'audio dans la vue
        const maxPps = currentAudioBuffer.sampleRate / 2; // zoom max : 2px par échantillon
        pps = Math.max(minPps, Math.min(maxPps, pps * factor));

        // Repositionne le viewport pour garder timeAnchor sous mouseX
        viewportStart = timeAnchor - mouseX / pps;
        clampViewport();

        resetSelection();
        console.log(`[Zoom] pps=${pps.toFixed(2)}  vs=${viewportStart.toFixed(3)}s  anchor=${timeAnchor.toFixed(3)}s`);
    }

    renderWaveform();
    renderSelectionOverlay();
    updateScrollbar();
}, { passive: false });

// ------ Zoom pinch tactile ------

UI.waveformContainer.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
    }
}, { passive: true });

UI.waveformContainer.addEventListener('touchmove', e => {
    if (!currentAudioBuffer || e.touches.length !== 2) return;
    e.preventDefault();

    const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDist === 0) { lastTouchDist = dist; return; }

    const dur  = currentAudioBuffer.duration;
    const cssW = UI.waveformContainer.clientWidth;
    const rect = UI.waveformContainer.getBoundingClientRect();
    const midX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
    const timeAnchor = pixelToTime(midX);

    const minPps = cssW / dur;
    const maxPps = currentAudioBuffer.sampleRate / 2;
    pps = Math.max(minPps, Math.min(maxPps, pps * (dist / lastTouchDist)));

    viewportStart = timeAnchor - midX / pps;
    clampViewport();

    renderWaveform();
    renderSelectionOverlay();
    updateScrollbar();

    lastTouchDist = dist;
}, { passive: false });

UI.waveformContainer.addEventListener('touchend', () => { lastTouchDist = 0; });

// ------ Scrollbar (pointer capture) ------

UI.scrollThumb.addEventListener('pointerdown', e => {
    if (!currentAudioBuffer) return;
    e.preventDefault();
    e.stopPropagation();
    UI.scrollThumb.setPointerCapture(e.pointerId);
    UI.scrollThumb.classList.add('dragging');
    isScrollbarDragging = true;

    const startClientX  = e.clientX;
    const startViewport = viewportStart;

    function onMove(ev) {
        if (!currentAudioBuffer) return;
        const dur        = currentAudioBuffer.duration;
        const cssW       = UI.waveformContainer.clientWidth;
        const visibleDur = cssW / pps;
        const trackW     = UI.scrollTrack.clientWidth;
        // Formule : le thumb parcoure trackW*(1-thumbFrac) px pour couvrir (dur-visibleDur) s
        // Ce qui est équivalent à : deltaSec = deltaPixels / trackW * dur
        const deltaSec = (ev.clientX - startClientX) / trackW * dur;
        viewportStart  = Math.max(0, Math.min(dur - visibleDur, startViewport + deltaSec));
        renderWaveform();
        renderSelectionOverlay();
        updateScrollbar();
    }

    function onUp() {
        isScrollbarDragging = false;
        UI.scrollThumb.classList.remove('dragging');
        UI.scrollThumb.removeEventListener('pointermove', onMove);
        UI.scrollThumb.removeEventListener('pointerup',   onUp);
        UI.scrollThumb.removeEventListener('pointercancel', onUp);
    }

    UI.scrollThumb.addEventListener('pointermove',   onMove);
    UI.scrollThumb.addEventListener('pointerup',     onUp);
    UI.scrollThumb.addEventListener('pointercancel', onUp);
});

// Clic sur le track (hors thumb) → saute à la position cliquée (centrée)
UI.scrollTrack.addEventListener('pointerdown', e => {
    if (!currentAudioBuffer || e.target === UI.scrollThumb) return;
    e.preventDefault();
    const rect       = UI.scrollTrack.getBoundingClientRect();
    const clickFrac  = (e.clientX - rect.left) / rect.width;
    const dur        = currentAudioBuffer.duration;
    const cssW       = UI.waveformContainer.clientWidth;
    const visibleDur = cssW / pps;
    viewportStart    = Math.max(0, Math.min(dur - visibleDur, clickFrac * dur - visibleDur / 2));
    renderWaveform();
    renderSelectionOverlay();
    updateScrollbar();
});


function checkSelection() {
    const hasSel = (selectionEnd - selectionStart) > 0.01; // Au moins 10ms
    UI.btnCutSel.disabled = !hasSel;
    
    UI.btnCutBefore.disabled = selectionStart <= 0.01;
    UI.btnCutAfter.disabled = selectionEnd >= currentAudioBuffer.duration - 0.01;
}

function resetSelection() {
    selectionStart = 0;
    selectionEnd = 0;
    renderSelectionOverlay();
    checkSelection();
}

// ------ Coupure Audio (Manipulation du Buffer) ------
function pushToUndo() {
    if (undoStack.length >= 6) { // Garde 5 états précédents + l'état actuel (6 total max avant trim)
        undoStack.shift();
    }
    undoStack.push(cloneAudioBuffer(currentAudioBuffer));
    updateUndoBtn();
}

function updateUndoBtn() {
    UI.btnUndo.disabled = undoStack.length <= 1;
}

function executeUndo() {
    if (undoStack.length > 1) {
        undoStack.pop(); // Retire l'état actuel
        currentAudioBuffer = cloneAudioBuffer(undoStack[undoStack.length - 1]); // Restaure le précédent
        renderWaveform();
        resetSelection();
        updateScrollbar();
        stopPlayback();
        updateUndoBtn();
        updateEstimateSize();
        updateStatus("Action annulée");
    }
}

function cloneAudioBuffer(audioBuffer) {
    const cloned = audioContext.createBuffer(
        audioBuffer.numberOfChannels,
        audioBuffer.length,
        audioBuffer.sampleRate
    );
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        cloned.copyToChannel(audioBuffer.getChannelData(c).slice(), c);
    }
    return cloned;
}

function cutAudio(mode) {
    if (isPlaying) stopPlayback();
    
    const rate = currentAudioBuffer.sampleRate;
    const startIdx = Math.floor(selectionStart * rate);
    const endIdx = Math.floor(selectionEnd * rate);
    const totalFrames = currentAudioBuffer.length;
    
    let newLength = 0;
    let keepStart1, keepEnd1, keepStart2, keepEnd2;
    
    if (mode === 'selection') {
        // Enleve la sélection
        keepStart1 = 0; keepEnd1 = startIdx;
        keepStart2 = endIdx; keepEnd2 = totalFrames;
        newLength = (keepEnd1 - keepStart1) + (keepEnd2 - keepStart2);
    } else if (mode === 'before') {
        // Enleve avant sélection
        keepStart1 = startIdx; keepEnd1 = totalFrames;
        keepStart2 = 0; keepEnd2 = 0;
        newLength = keepEnd1 - keepStart1;
    } else if (mode === 'after') {
        // Enleve apres sélection
        keepStart1 = 0; keepEnd1 = endIdx;
        keepStart2 = 0; keepEnd2 = 0;
        newLength = keepEnd1 - keepStart1;
    }
    
    if (newLength <= 0) return; // Sécurité

    const newBuffer = audioContext.createBuffer(
        currentAudioBuffer.numberOfChannels,
        newLength,
        rate
    );
    
    for (let c = 0; c < currentAudioBuffer.numberOfChannels; c++) {
        const oldData = currentAudioBuffer.getChannelData(c);
        const newData = newBuffer.getChannelData(c);
        
        if (keepEnd1 > keepStart1) {
            newData.set(oldData.subarray(keepStart1, keepEnd1), 0);
        }
        if (keepEnd2 > keepStart2) {
            newData.set(oldData.subarray(keepStart2, keepEnd2), keepEnd1 - keepStart1);
        }
    }
    
    currentAudioBuffer = newBuffer;
    // Ajuster pps et viewportStart si le buffer est maintenant plus court
    const cW = UI.waveformContainer.clientWidth;
    const minPps = cW / currentAudioBuffer.duration;
    if (pps < minPps) {
        pps = minPps;
        viewportStart = 0;
    } else if (currentAudioBuffer.duration < viewportStart + cW / pps) {
        viewportStart = Math.max(0, currentAudioBuffer.duration - cW / pps);
    }
    pushToUndo();
    renderWaveform();
    resetSelection();
    updateScrollbar();
    updateEstimateSize();
    updateStatus("Audio coupé");
}

UI.btnCutSel.addEventListener('click', () => cutAudio('selection'));
UI.btnCutBefore.addEventListener('click', () => cutAudio('before'));
UI.btnCutAfter.addEventListener('click', () => cutAudio('after'));
UI.btnUndo.addEventListener('click', executeUndo);

// ------ Normalisation LUFS (-14) ------
async function normalizeToLUFS() {
    if (!currentAudioBuffer) return;
    if (isPlaying) stopPlayback();

    UI.btnNormalize.disabled = true;
    updateStatus("Analyse LUFS en cours...");

    const sr = currentAudioBuffer.sampleRate;
    const len = currentAudioBuffer.length;
    const chans = currentAudioBuffer.numberOfChannels;

    // 1. Appliquer les filtres K-weighting via OfflineAudioContext (ITU-R BS.1770)
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(chans, len, sr);
    const source = offlineCtx.createBufferSource();
    source.buffer = currentAudioBuffer;

    // Filtre High-shelf (Peaking effect de la tête)
    const highShelf = offlineCtx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 1500;
    highShelf.gain.value = 4;

    // Filtre High-pass (Atténuation des basses RLB)
    const highPass = offlineCtx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 38;

    source.connect(highShelf);
    highShelf.connect(highPass);
    highPass.connect(offlineCtx.destination);
    source.start();

    try {
        const renderedBuffer = await offlineCtx.startRendering();

        // 2. Calcul du Loudness (RMS non-gaté)
        let sumMeanSquare = 0;
        for (let c = 0; c < chans; c++) {
            const data = renderedBuffer.getChannelData(c);
            let sumSqr = 0;
            for (let i = 0; i < len; i++) {
                sumSqr += data[i] * data[i];
            }
            sumMeanSquare += sumSqr / len;
        }

        let currentLUFS = -70; // Silence absolu
        if (sumMeanSquare > 1e-10) {
            // Formule standard : -0.691 + 10 * log10(sum_of_channels_mean_squares)
            currentLUFS = -0.691 + 10 * Math.log10(Math.max(1e-10, sumMeanSquare));
        }

        if (currentLUFS < -69) {
            updateStatus("Erreur: Piste silencieuse");
            UI.btnNormalize.disabled = false;
            return;
        }

        // 3. Calcul du Gain pour -14 LUFS
        const targetLUFS = -14;
        const diffDB = targetLUFS - currentLUFS;
        let multiplier = Math.pow(10, diffDB / 20);

        // 4. Sécurité anticlipping (-1 dBTP environ = 0.89 amplitude max)
        let maxPeak = 0;
        for (let c = 0; c < chans; c++) {
            const data = currentAudioBuffer.getChannelData(c);
            for (let i = 0; i < len; i++) {
                if (Math.abs(data[i]) > maxPeak) maxPeak = Math.abs(data[i]);
            }
        }

        const safePeak = 0.95; // Garde un petit headroom d'écrêtage
        let comment = "";
        if (maxPeak * multiplier > safePeak) {
            multiplier = safePeak / maxPeak;
            comment = " (Limitée pour éviter la saturation)";
            console.log(`[LUFS] Normalisation limitée. Multiplicateur réel: ${multiplier.toFixed(2)} au lieu du théorique.`);
        }

        // 5. Application du Gain In-Place
        for (let c = 0; c < chans; c++) {
            const data = currentAudioBuffer.getChannelData(c);
            for (let i = 0; i < len; i++) {
                data[i] *= multiplier;
            }
        }

        // 6. Mise à jour de l'UI
        pushToUndo();
        audioPeaks = null; // Invalide le cache des visuels (oblige à redessiner la waveform modifiée)
        renderWaveform();
        updateEstimateSize();
        
        const endLoudness = (maxPeak * multiplier > safePeak) ? "Ajusté au max" : "-14 LUFS";
        updateStatus(`Normalisation: ${currentLUFS.toFixed(1)} LUFS → ${endLoudness}${comment}`);

    } catch (e) {
        console.error(e);
        updateStatus("Erreur lors de la normalisation");
    }

    UI.btnNormalize.disabled = false;
}

UI.btnNormalize.addEventListener('click', normalizeToLUFS);

// ------ Lecture (Play/Stop) ------
function startPlayback() {
    if (!currentAudioBuffer) return;
    if (isPlaying) stopPlayback();
    
    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = currentAudioBuffer;
    sourceNode.connect(audioContext.destination);
    
    let offset = 0;
    let duration = currentAudioBuffer.duration;
    
    // Si une sélection existe, on la joue
    if (selectionEnd - selectionStart > 0.01) {
        offset = selectionStart;
        duration = selectionEnd - selectionStart;
    } else if (selectionStart > 0) {
        // Sinon s'il y a un curseur, on joue de là jusqu'à la fin
        offset = selectionStart;
        duration = currentAudioBuffer.duration - selectionStart;
    } else {
        // Sinon on joue du début
        offset = 0;
        duration = currentAudioBuffer.duration;
    }
    
    sourceNode.onended = () => {
        if(isPlaying) stopPlayback();
    };
    
    playbackOffset = offset;
    playbackStartTime = audioContext.currentTime;
    
    sourceNode.start(0, offset, duration);
    isPlaying = true;
    UI.btnPlay.innerHTML = '<span class="icon">⏸</span> Pause';
    UI.btnPlay.classList.replace('btn-success', 'btn-warning');
    UI.playhead.style.display = 'block';

    cancelAnimationFrame(playheadAnimId);
    updatePlayhead();
}

function stopPlayback() {
    if (sourceNode) {
        sourceNode.onended = null;
        try { sourceNode.stop(0); } catch(e){}
        sourceNode.disconnect();
        sourceNode = null;
    }
    isPlaying = false;
    cancelAnimationFrame(playheadAnimId);
    UI.btnPlay.innerHTML = '<span class="icon">⏵</span> Jouer';
    UI.btnPlay.classList.replace('btn-warning', 'btn-success');
    UI.playhead.style.display = 'none';
}

function updatePlayhead() {
    if (!isPlaying) return;

    const elapsed = audioContext.currentTime - playbackStartTime;
    const currentPos = playbackOffset + elapsed;

    // Stop automatique en fin de sélection (seuil identique à startPlayback)
    if (selectionEnd - selectionStart > 0.01 && currentPos >= selectionEnd) {
        stopPlayback();
        return;
    }

    const rect = UI.waveformContainer.getBoundingClientRect();
    const xPos = timeToPixel(currentPos, rect.width);
    if (xPos < 0 || xPos > rect.width) {
        UI.playhead.style.display = 'none';
    } else {
        UI.playhead.style.display = 'block';
        UI.playhead.style.left = xPos + 'px';
    }

    playheadAnimId = requestAnimationFrame(updatePlayhead);
}

UI.btnPlay.addEventListener('click', () => {
    if(isPlaying) stopPlayback();
    else startPlayback();
});
UI.btnStopPlayback.addEventListener('click', stopPlayback);

// ==========================================
// 4. RACCOURCIS CLAVIER
// ==========================================
window.addEventListener('keyup', e => {
    // Ne pas trigger si on tappe dans un input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (UI.secRec.style.display !== 'none') {
        if (e.key.toLowerCase() === 'r' && !UI.btnRec.disabled) startRecording();
        if (e.key.toLowerCase() === 'p' && !UI.btnPause.disabled) pauseRecording();
        if (e.key.toLowerCase() === 's' && !UI.btnStop.disabled) stopRecording();
    }
});

window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (UI.secEdit.style.display !== 'none') {
        // Espace : jouer/pause
        if (e.key === ' ') {
            e.preventDefault();
            if (isPlaying) stopPlayback(); else startPlayback();
        }
        // Ctrl+Z : annuler
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            executeUndo();
        }
        // Suppr / Backspace : Supprimer la sélection
        if ((e.key === 'Delete' || e.key === 'Backspace') && !UI.btnCutSel.disabled) {
            e.preventDefault();
            cutAudio('selection');
        }
    }
});

// ==========================================
// 5. EXPORT & FFMPEG
// ==========================================

const BITRATE_FORMATS = ['mp3', 'ogg', 'aac'];

function applyFormatUI(format) {
    const hasBitrate = BITRATE_FORMATS.includes(format);
    UI.bitrateGroup.style.display = hasBitrate ? 'flex' : 'none';
    if (hasBitrate) UI.bitrateLabel.textContent = `Bitrate (${format.toUpperCase()})`;
}

UI.exportFormat.addEventListener('change', e => {
    applyFormatUI(e.target.value);
    localStorage.setItem('sr_format', e.target.value);
    updateEstimateSize();
});

UI.exportBitrate.addEventListener('change', () => {
    localStorage.setItem('sr_bitrate', UI.exportBitrate.value);
    updateEstimateSize();
});

UI.exportChannels.addEventListener('change', () => {
    localStorage.setItem('sr_channels', UI.exportChannels.value);
    updateEstimateSize();
});

function restoreExportPrefs() {
    const fmt = localStorage.getItem('sr_format')   || 'ogg';
    const br  = localStorage.getItem('sr_bitrate')  || '192k';
    const ch  = localStorage.getItem('sr_channels') || 'stereo';
    if (UI.exportFormat.querySelector(`option[value="${fmt}"]`))   UI.exportFormat.value = fmt;
    if (UI.exportBitrate.querySelector(`option[value="${br}"]`))   UI.exportBitrate.value = br;
    if (UI.exportChannels.querySelector(`option[value="${ch}"]`))  UI.exportChannels.value = ch;
    applyFormatUI(UI.exportFormat.value);
}

function updateEstimateSize() {
    if (!currentAudioBuffer) return;
    const dur    = currentAudioBuffer.duration;
    const format = UI.exportFormat.value;
    const mono   = UI.exportChannels.value === 'mono';
    const chanMult = mono ? 1 : Math.min(currentAudioBuffer.numberOfChannels, 2);
    let estBytes;

    if (format === 'wav') {
        estBytes = dur * currentAudioBuffer.sampleRate * chanMult * 2;
    } else if (format === 'flac') {
        estBytes = dur * currentAudioBuffer.sampleRate * chanMult * 2 * 0.55;
    } else if (BITRATE_FORMATS.includes(format)) {
        // Pour MP3/OGG/AAC le bitrate est global (pas par canal)
        const bps = parseInt(UI.exportBitrate.value) * 1000;
        estBytes = (dur * bps) / 8;
    }

    const estMb = estBytes / (1024 * 1024);
    UI.exportSizeEst.textContent = `Taille estimée : ~${estMb.toFixed(2)} MB`;
}

// Convert AudioBuffer to WAV Blob — supporte le downmix mono
function audioBufferToWavBlob(buffer, mono = false) {
    const srcChan  = buffer.numberOfChannels;
    const outChan  = mono ? 1 : srcChan;
    const sampleRate = buffer.sampleRate;
    const length   = buffer.length * outChan * 2 + 44;
    const outBuf   = new ArrayBuffer(length);
    const view     = new DataView(outBuf);
    let pos = 0;

    function setUint16(d) { view.setUint16(pos, d, true); pos += 2; }
    function setUint32(d) { view.setUint32(pos, d, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8);
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16);
    setUint16(1);          // PCM
    setUint16(outChan);
    setUint32(sampleRate);
    setUint32(sampleRate * outChan * 2);
    setUint16(outChan * 2);
    setUint16(16);
    setUint32(0x61746164); // "data"
    setUint32(length - pos - 4);

    const channels = [];
    for (let i = 0; i < srcChan; i++) channels.push(buffer.getChannelData(i));

    for (let f = 0; f < buffer.length; f++) {
        if (mono) {
            // Mix down : moyenne de tous les canaux sources
            let s = 0;
            for (let c = 0; c < srcChan; c++) s += channels[c][f];
            s = Math.max(-1, Math.min(1, s / srcChan));
            view.setInt16(pos, (s < 0 ? s * 32768 : s * 32767) | 0, true);
            pos += 2;
        } else {
            for (let c = 0; c < outChan; c++) {
                let s = Math.max(-1, Math.min(1, channels[c][f]));
                view.setInt16(pos, (s < 0 ? s * 32768 : s * 32767) | 0, true);
                pos += 2;
            }
        }
    }

    return new Blob([outBuf], { type: 'audio/wav' });
}

// Load FFmpeg.wasm 0.12.x — toBlobURL convertit chaque ressource CDN en blob: URL same-origin.
// Contourne les restrictions CORS sur les module Workers sans héberger les fichiers localement.
async function loadFFmpeg() {
    if (isFFmpegLoaded) return true;
    updateStatus("Chargement du moteur d'encodage...");

    const unpkgFFmpeg = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';
    const unpkgUtil = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm';
    const unpkgCore = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

    try {
        const { FFmpeg } = await import(`${unpkgFFmpeg}/index.js`);
        const { fetchFile, toBlobURL } = await import(`${unpkgUtil}/index.js`);

        ffmpegInstance = new FFmpeg();
        ffmpegInstance.on('log', ({ message }) => console.log('[FFmpeg Log]', message));
        ffmpegInstance.on('progress', ({ progress }) => {
            const pct = Math.min(100, Math.round(progress * 100));
            UI.exportProgressPct.textContent = `${pct}%`;
            UI.exportProgressFill.style.width = `${pct}%`;
        });

        // Conversion en blob: URLs same-origin (pattern officiel pour éviter les erreurs CORS)
        UI.exportProgressLabel.textContent = "Téléchargement du moteur (~20 Mo, une seule fois)...";
        console.log("loadFFmpeg: fetching core.js and core.wasm...");
        
        const coreURL = await toBlobURL(`${unpkgCore}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await toBlobURL(`${unpkgCore}/ffmpeg-core.wasm`, 'application/wasm');
        
        // Custom worker creation: fetch the worker script and replace its relative imports
        // with absolute URLs before turning it into a blob. This is required because
        // resolving relative imports from a blob: URL fails in the browser.
        let workerText = await (await fetch(`${unpkgFFmpeg}/worker.js`)).text();
        workerText = workerText.replace(/from\s+["']\.\/(.*?)["']/g, `from "${unpkgFFmpeg}/$1"`);
        const workerBlob = new Blob([workerText], { type: 'text/javascript' });
        const classWorkerURL = URL.createObjectURL(workerBlob);
        
        console.log("loadFFmpeg: all blobs fetched. Starting ffmpeg.load...");
        await ffmpegInstance.load({
            coreURL,
            wasmURL,
            classWorkerURL,
        });

        isFFmpegLoaded = true;
        window.fetchFileUtil = fetchFile;
        updateStatus("Moteur prêt");
        return true;
    } catch (err) {
        console.error("loadFFmpeg Error:", err);
        throw new Error("Impossible de charger le moteur FFmpeg : " + err.message);
    }
}

async function performExport() {
    if(!currentAudioBuffer) return;
    
    const format = UI.exportFormat.value;
    const filenameBase = UI.filenameInput.value.trim() || "enregistrement_01";
    const finalName = `${filenameBase}.${format === 'aac' ? 'm4a' : format}`;
    
    UI.btnExport.disabled = true;
    UI.exportProgress.style.display = 'block';
    
    try {
        const mono = UI.exportChannels.value === 'mono';

        // Step 1: Serialize memory buffer to WAV (avec downmix si mono)
        updateStatus("Génération de l'audio base...");
        UI.exportProgressLabel.textContent = "Génération de l'audio...";
        const wavBlob = audioBufferToWavBlob(currentAudioBuffer, mono);

        if (format === 'wav') {
            downloadBlob(wavBlob, finalName);
            finishExport();
            return;
        }

        // Step 2: Load FFmpeg if needed.
        if (!isFFmpegLoaded) {
            UI.exportProgressLabel.textContent = "Chargement des modules...";
            await loadFFmpeg();
        }

        // Step 3: Run Conversion
        UI.exportProgressLabel.textContent = `Conversion en ${format.toUpperCase()}...`;
        UI.exportProgressPct.textContent = "0%";
        UI.exportProgressFill.style.width = "0%";

        await ffmpegInstance.writeFile('input.wav', await window.fetchFileUtil(wavBlob));

        const outputFilename = `output.${format === 'aac' ? 'm4a' : format}`;
        const bitrate = UI.exportBitrate.value;
        let args = ['-i', 'input.wav'];
        if (format === 'mp3') {
            args.push('-b:a', bitrate, outputFilename);
        } else if (format === 'ogg') {
            args.push('-c:a', 'libvorbis', '-b:a', bitrate, outputFilename);
        } else if (format === 'flac') {
            args.push(outputFilename);
        } else if (format === 'aac') {
            args.push('-c:a', 'aac', '-b:a', bitrate, outputFilename);
        }

        await ffmpegInstance.exec(args);

        const outputData = await ffmpegInstance.readFile(outputFilename);

        // Cleanup mémoire FS virtuel
        try { await ffmpegInstance.deleteFile('input.wav'); } catch(e){}
        try { await ffmpegInstance.deleteFile(outputFilename); } catch(e){}

        const typeMap = { mp3:'audio/mpeg', ogg:'audio/ogg', flac:'audio/flac', aac:'audio/mp4' };
        const convertedBlob = new Blob([outputData.buffer], { type: typeMap[format] });
        
        downloadBlob(convertedBlob, finalName);
        finishExport();
        
    } catch (e) {
        console.error(e);
        updateStatus("Erreur d'exportation: " + e.message);
        UI.btnExport.disabled = false;
        UI.exportProgress.style.display = 'none';
        alert("Une erreur est surveue durant l'exportation. Regardez la console.");
    }
}

function finishExport() {
    hasExported = true;
    UI.exportProgressLabel.textContent = "Terminé !";
    UI.exportProgressPct.textContent = "100%";
    UI.exportProgressFill.style.width = "100%";

    setTimeout(() => {
        UI.exportProgress.style.display = 'none';
        UI.btnExport.disabled = false;
        updateStatus("Fichier téléchargé ✓");
    }, 2000);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// ==========================================
// CHARGEMENT D'UN FICHIER AUDIO EXISTANT
// ==========================================

async function loadAudioFile(file) {
    if (!file) return;
    try {
        updateStatus("Chargement du fichier...");
        const arrayBuffer = await file.arrayBuffer();
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        } else if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        currentAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        enforceSymmetricChannels(currentAudioBuffer);
        undoStack = [cloneAudioBuffer(currentAudioBuffer)];

        // Pré-remplir le nom du fichier sans l'extension
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        UI.filenameInput.value = nameWithoutExt;

        // Si on vient de la section enregistrement, stopper le preview
        if (UI.secRec.style.display !== 'none') {
            stopPreview();
            cancelAnimationFrame(idleAnimId);
        }

        hasExported = false;
        showEditor();
        renderWaveform();
        updateEstimateSize();
        updateStatus("Fichier chargé — prêt pour l'édition");
    } catch (err) {
        console.error("Chargement fichier:", err);
        updateStatus("Erreur : format audio non supporté ou fichier invalide");
    }
}

// ------ Event Listeners initiaux ------
UI.btnRec.addEventListener('click', startRecording);
UI.btnPause.addEventListener('click', pauseRecording);
UI.btnStop.addEventListener('click', stopRecording);
UI.btnNewRec.addEventListener('click', closeEditor);
UI.btnExport.addEventListener('click', performExport);

UI.btnOpenFileRec.addEventListener('click', () => UI.openFileInput.click());
UI.btnOpenFileEdit.addEventListener('click', () => UI.openFileInput.click());
UI.openFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    UI.openFileInput.value = ''; // reset pour permettre de rouvrir le même fichier
    loadAudioFile(file);
});

// Changement de source → relancer le monitoring
UI.micSelect.addEventListener('change', () => {
    if (!isRecording) startPreview();
});

// --- Démarrer ---
restoreExportPrefs(); // Restaure le format/bitrate choisi précédemment
startIdleAnimation(); // Animation de secours pendant la demande de permission
initDevices();        // Lance startPreview() dès les périphériques prêts
