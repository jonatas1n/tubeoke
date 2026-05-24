const PLAYER_SELECTOR = "#player";
const AUDIO_TRACK_ID = "audio-track";
const LOADING_OVERLAY_ID = "loading-overlay";
const LOADING_MESSAGE_ID = "loading-message";
const LOADING_RETRY_ID = "loading-retry";
const PITCH_LABEL_ID = "pitch-label";
const PITCH_UP_BUTTON_ID = "pitch-up";
const PITCH_DOWN_BUTTON_ID = "pitch-down";

const MIN_SEMITONES = -12;
const MAX_SEMITONES = 12;

const READY_STATE_HAVE_FUTURE_DATA = 3;
const AUDIO_READY_TIMEOUT_MS = 30000;

const PITCH_SHIFT_WINDOW_SIZE_SECONDS = 0.2;
const PITCH_SHIFT_DELAY_TIME_SECONDS = 0;
const PITCH_SHIFT_FEEDBACK = 0;

const SYNC_DRIFT_THRESHOLD_SECONDS = 0.15;
const SYNC_INTERVAL_MS = 750;
const SEEK_ALIGN_THRESHOLD_SECONDS = 0.05;

const FIRST_GESTURE_EVENTS = ["pointerdown", "keydown", "touchstart"];

const PLAYER_PAGE_SELECTOR = ".player-page";
const PLAYER_HEADER_SELECTOR = ".player-header";
const HEADER_IDLE_CLASS = "is-idle";
const HEADER_IDLE_TIMEOUT_MS = 2500;
const HEADER_ACTIVITY_EVENTS = ["mousemove", "pointermove", "keydown", "touchstart"];

const formatPitchLabel = (semitones) => {
  if (semitones === 0) return "Tom Original";
  if (semitones > 0) return `+${semitones} Semitons`;
  return `${semitones} Semitons`;
};

const clampSemitones = (value) => {
  if (value < MIN_SEMITONES) return MIN_SEMITONES;
  if (value > MAX_SEMITONES) return MAX_SEMITONES;
  return value;
};

const describeMediaError = (error) => {
  if (!error) return "Erro desconhecido ao carregar o áudio.";
  switch (error.code) {
    case 1: return "Carregamento do áudio foi abortado.";
    case 2: return "Erro de rede ao carregar o áudio.";
    case 3: return "Falha ao decodificar o áudio.";
    case 4: return "Áudio indisponível. Verifique se o servidor extraiu corretamente do YouTube.";
    default: return "Erro desconhecido ao carregar o áudio.";
  }
};

const waitForAudioReady = (audio, timeoutMs = AUDIO_READY_TIMEOUT_MS) => {
  if (audio.error) {
    return Promise.reject(new Error(describeMediaError(audio.error)));
  }
  if (audio.readyState >= READY_STATE_HAVE_FUTURE_DATA) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("canplaythrough", onReady);
      audio.removeEventListener("loadeddata", onReady);
      audio.removeEventListener("error", onError);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const onReady = () => {
      if (audio.readyState < READY_STATE_HAVE_FUTURE_DATA) return;
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(describeMediaError(audio.error)));
    };

    audio.addEventListener("canplay", onReady);
    audio.addEventListener("canplaythrough", onReady);
    audio.addEventListener("loadeddata", onReady);
    audio.addEventListener("error", onError);

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Tempo esgotado ao carregar o áudio."));
    }, timeoutMs);
  });
};

const setupHeaderAutoHide = () => {
  const playerPage = document.querySelector(PLAYER_PAGE_SELECTOR);
  const header = playerPage?.querySelector(PLAYER_HEADER_SELECTOR);
  if (!playerPage || !header) return;

  let idleTimerId = null;

  const isHeaderInteracted = () =>
    header.matches(":hover") || header.contains(document.activeElement);

  const scheduleIdle = () => {
    if (idleTimerId) clearTimeout(idleTimerId);
    if (isHeaderInteracted()) return;
    idleTimerId = setTimeout(() => {
      playerPage.classList.add(HEADER_IDLE_CLASS);
    }, HEADER_IDLE_TIMEOUT_MS);
  };

  const showHeader = () => {
    playerPage.classList.remove(HEADER_IDLE_CLASS);
    scheduleIdle();
  };

  HEADER_ACTIVITY_EVENTS.forEach((type) =>
    document.addEventListener(type, showHeader, { passive: true })
  );
  header.addEventListener("mouseenter", showHeader);
  header.addEventListener("mouseleave", scheduleIdle);
  header.addEventListener("focusin", showHeader);
  header.addEventListener("focusout", scheduleIdle);

  scheduleIdle();
};

document.addEventListener("DOMContentLoaded", () => {
  const player = new Plyr(PLAYER_SELECTOR);
  const audioElement = document.getElementById(AUDIO_TRACK_ID);
  const loadingOverlay = document.getElementById(LOADING_OVERLAY_ID);
  const loadingMessage = document.getElementById(LOADING_MESSAGE_ID);
  const retryButton = document.getElementById(LOADING_RETRY_ID);
  const pitchLabel = document.getElementById(PITCH_LABEL_ID);
  const pitchUpButton = document.getElementById(PITCH_UP_BUTTON_ID);
  const pitchDownButton = document.getElementById(PITCH_DOWN_BUTTON_ID);

  let currentPitch = 0;
  let pitchShift = null;
  let isGraphConnected = false;
  let isContextRunning = false;
  let contextResumePromise = null;
  let hasFatalError = false;
  let isAudioPreloaded = false;
  let driftIntervalId = null;
  let isAudioBuffering = false;

  player.muted = true;
  player.on("volumechange", () => {
    if (!player.muted) player.muted = true;
  });

  const showLoading = (message = "Sincronizando áudio...") => {
    if (hasFatalError) return;
    loadingOverlay?.classList.add("is-visible");
    loadingOverlay?.classList.remove("is-error");
    if (loadingMessage) loadingMessage.innerText = message;
    if (retryButton) retryButton.hidden = true;
  };

  const hideLoading = () => {
    if (hasFatalError) return;
    if (isAudioBuffering) return;
    loadingOverlay?.classList.remove("is-visible");
  };

  const showError = (message) => {
    hasFatalError = true;
    loadingOverlay?.classList.add("is-visible");
    loadingOverlay?.classList.add("is-error");
    if (loadingMessage) loadingMessage.innerText = message;
    if (retryButton) retryButton.hidden = false;
    stopDriftLoop();
    audioElement.pause();
    player.pause();
  };

  const renderPitchLabel = () => {
    if (!pitchLabel) return;
    pitchLabel.innerText = formatPitchLabel(currentPitch);
  };

  const connectAudioGraph = () => {
    if (isGraphConnected) return;

    Tone.context.latencyHint = "playback";
    pitchShift = new Tone.PitchShift({
      pitch: currentPitch,
      windowSize: PITCH_SHIFT_WINDOW_SIZE_SECONDS,
      delayTime: PITCH_SHIFT_DELAY_TIME_SECONDS,
      feedback: PITCH_SHIFT_FEEDBACK,
    }).toDestination();
    const mediaSource = Tone.context.createMediaElementSource(audioElement);
    Tone.connect(mediaSource, pitchShift);
    isGraphConnected = true;
  };

  const ensureContextRunning = async () => {
    connectAudioGraph();
    if (isContextRunning && Tone.context.state === "running") return;
    if (contextResumePromise) return contextResumePromise;

    contextResumePromise = (async () => {
      await Tone.start();
      isContextRunning = true;
    })();

    try {
      await contextResumePromise;
    } finally {
      contextResumePromise = null;
    }
  };

  function stopDriftLoop() {
    if (!driftIntervalId) return;
    clearInterval(driftIntervalId);
    driftIntervalId = null;
  }

  const startDriftLoop = () => {
    if (driftIntervalId) return;
    driftIntervalId = setInterval(() => {
      if (player.paused || audioElement.paused) return;
      const drift = player.currentTime - audioElement.currentTime;
      if (Math.abs(drift) <= SYNC_DRIFT_THRESHOLD_SECONDS) return;
      audioElement.currentTime = player.currentTime;
    }, SYNC_INTERVAL_MS);
  };

  const alignAudioToPlayer = () => {
    const drift = player.currentTime - audioElement.currentTime;
    if (Math.abs(drift) > SEEK_ALIGN_THRESHOLD_SECONDS) {
      audioElement.currentTime = player.currentTime;
    }
  };

  const handlePlay = async () => {
    if (hasFatalError) return;
    showLoading();
  };

  const handlePlaying = async () => {
    if (hasFatalError) return;

    try {
      await ensureContextRunning();
    } catch (error) {
      console.error("Failed to start audio context:", error);
      showError("Falha ao iniciar áudio.");
      return;
    }

    alignAudioToPlayer();
    try {
      await audioElement.play();
    } catch (error) {
      console.error("Failed to play audio:", error);
    }
    startDriftLoop();
    hideLoading();
  };

  const handlePause = () => {
    audioElement.pause();
    stopDriftLoop();
  };

  const handleWaiting = () => {
    if (hasFatalError) return;
    showLoading("Buferizando vídeo...");
    audioElement.pause();
    stopDriftLoop();
  };

  const handleSeeked = async () => {
    if (hasFatalError) return;

    if (player.paused) {
      audioElement.currentTime = player.currentTime;
      return;
    }

    showLoading();
    try {
      alignAudioToPlayer();
      await audioElement.play();
      startDriftLoop();
      hideLoading();
    } catch (error) {
      console.error("Failed to resume audio after seek:", error);
    }
  };

  const handleEnded = () => {
    audioElement.pause();
    stopDriftLoop();
    hideLoading();
  };

  const handleAudioWaiting = () => {
    if (hasFatalError) return;
    if (player.paused) return;
    isAudioBuffering = true;
    player.pause();
    showLoading("Buferizando áudio...");
  };

  const handleAudioCanPlay = () => {
    if (hasFatalError) return;
    if (!isAudioBuffering) return;
    isAudioBuffering = false;
    hideLoading();
    player.play().catch((error) => {
      console.error("Failed to resume video:", error);
    });
  };

  const handleAudioError = () => {
    showError(describeMediaError(audioElement.error));
  };

  const handleRetry = () => {
    hasFatalError = false;
    isAudioPreloaded = false;
    isAudioBuffering = false;
    audioElement.load();
    preloadAudio();
  };

  const preloadAudio = async () => {
    showLoading("Carregando áudio...");
    try {
      connectAudioGraph();
      await waitForAudioReady(audioElement);
      isAudioPreloaded = true;
      hideLoading();
    } catch (error) {
      console.error("Failed to preload audio:", error);
      showError(error.message || "Não foi possível carregar o áudio.");
    }
  };

  const setupFirstGestureInit = () => {
    const handler = () => {
      FIRST_GESTURE_EVENTS.forEach((type) =>
        document.removeEventListener(type, handler, true)
      );
      ensureContextRunning().catch((error) => {
        console.error("Failed to resume audio context:", error);
      });
    };

    FIRST_GESTURE_EVENTS.forEach((type) =>
      document.addEventListener(type, handler, { once: true, capture: true })
    );
  };

  const changePitch = async (delta) => {
    if (hasFatalError) return;

    try {
      await ensureContextRunning();
    } catch (error) {
      console.error("Failed to enable pitch pipeline:", error);
      showError("Falha ao iniciar pipeline de áudio.");
      return;
    }

    if (!pitchShift) return;

    const nextPitch = clampSemitones(currentPitch + delta);
    if (nextPitch === currentPitch) return;

    currentPitch = nextPitch;
    pitchShift.pitch = currentPitch;
    renderPitchLabel();
  };

  audioElement.addEventListener("waiting", handleAudioWaiting);
  audioElement.addEventListener("canplay", handleAudioCanPlay);
  audioElement.addEventListener("playing", handleAudioCanPlay);
  audioElement.addEventListener("error", handleAudioError);

  retryButton?.addEventListener("click", handleRetry);

  player.on("play", handlePlay);
  player.on("playing", handlePlaying);
  player.on("pause", handlePause);
  player.on("waiting", handleWaiting);
  player.on("seeked", handleSeeked);
  player.on("ended", handleEnded);

  pitchUpButton?.addEventListener("click", () => changePitch(1));
  pitchDownButton?.addEventListener("click", () => changePitch(-1));

  setupFirstGestureInit();
  setupHeaderAutoHide();
  preloadAudio();
});
