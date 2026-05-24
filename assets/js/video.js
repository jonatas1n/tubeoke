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

const SYNC_DRIFT_THRESHOLD_SECONDS = 0.2;
const SYNC_INTERVAL_MS = 750;
const READY_STATE_HAVE_FUTURE_DATA = 3;
const AUDIO_READY_TIMEOUT_MS = 30000;

const FIRST_GESTURE_EVENTS = ["pointerdown", "keydown", "touchstart"];

const PLYR_CONTROLS = [
  "play-large",
  "play",
  "progress",
  "current-time",
  "duration",
  "settings",
  "pip",
  "airplay",
  "fullscreen",
];

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

const waitForAudioSeeked = (audio) =>
  new Promise((resolve) => {
    audio.addEventListener("seeked", resolve, { once: true });
  });

document.addEventListener("DOMContentLoaded", () => {
  const player = new Plyr(PLAYER_SELECTOR, { controls: PLYR_CONTROLS });
  const audioElement = document.getElementById(AUDIO_TRACK_ID);
  const loadingOverlay = document.getElementById(LOADING_OVERLAY_ID);
  const loadingMessage = document.getElementById(LOADING_MESSAGE_ID);
  const retryButton = document.getElementById(LOADING_RETRY_ID);
  const pitchLabel = document.getElementById(PITCH_LABEL_ID);
  const pitchUpButton = document.getElementById(PITCH_UP_BUTTON_ID);
  const pitchDownButton = document.getElementById(PITCH_DOWN_BUTTON_ID);

  let currentPitch = 0;
  let pitchShift = null;
  let isPipelineConnected = false;
  let pipelineConnectPromise = null;
  let syncIntervalId = null;
  let isResyncing = false;
  let hasFatalError = false;

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
    loadingOverlay?.classList.remove("is-visible");
  };

  const showError = (message) => {
    hasFatalError = true;
    loadingOverlay?.classList.add("is-visible");
    loadingOverlay?.classList.add("is-error");
    if (loadingMessage) loadingMessage.innerText = message;
    if (retryButton) retryButton.hidden = false;
    stopSyncLoop();
    audioElement.pause();
    player.pause();
  };

  const renderPitchLabel = () => {
    if (!pitchLabel) return;
    pitchLabel.innerText = formatPitchLabel(currentPitch);
  };

  const connectAudioPipeline = async () => {
    if (isPipelineConnected) return;
    if (pipelineConnectPromise) return pipelineConnectPromise;

    pipelineConnectPromise = (async () => {
      await Tone.start();
      pitchShift = new Tone.PitchShift(currentPitch).toDestination();
      const mediaSource = Tone.context.createMediaElementSource(audioElement);
      Tone.connect(mediaSource, pitchShift);
      isPipelineConnected = true;
    })();

    try {
      await pipelineConnectPromise;
    } finally {
      pipelineConnectPromise = null;
    }
  };

  function stopSyncLoop() {
    if (!syncIntervalId) return;
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }

  const startSyncLoop = () => {
    if (syncIntervalId) return;
    syncIntervalId = setInterval(() => {
      if (audioElement.paused || player.paused || isResyncing) return;

      const drift = player.currentTime - audioElement.currentTime;
      if (Math.abs(drift) <= SYNC_DRIFT_THRESHOLD_SECONDS) return;

      audioElement.currentTime = player.currentTime;
    }, SYNC_INTERVAL_MS);
  };

  const performResync = async () => {
    if (hasFatalError) return;

    isResyncing = true;
    showLoading();

    try {
      audioElement.pause();
      await connectAudioPipeline();
      await waitForAudioReady(audioElement);

      const targetTime = player.currentTime;
      if (Math.abs(audioElement.currentTime - targetTime) > 0.05) {
        audioElement.currentTime = targetTime;
        await waitForAudioSeeked(audioElement);
      }

      if (!player.paused) await audioElement.play();
      hideLoading();
    } catch (error) {
      console.error("Failed to resync audio:", error);
      showError(error.message || "Falha ao sincronizar áudio.");
    } finally {
      isResyncing = false;
    }
  };

  const preloadAudioAndConnect = async () => {
    showLoading("Preparando áudio...");
    try {
      await connectAudioPipeline();
      await waitForAudioReady(audioElement);
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
      preloadAudioAndConnect();
    };

    FIRST_GESTURE_EVENTS.forEach((type) =>
      document.addEventListener(type, handler, { once: true, capture: true })
    );
  };

  const handlePlayIntent = () => {
    if (hasFatalError) return;
    showLoading();
  };

  const handlePlaying = async () => {
    if (hasFatalError) return;
    await performResync();
    startSyncLoop();
  };

  const handlePause = () => {
    audioElement.pause();
    stopSyncLoop();
  };

  const handleWaiting = () => {
    if (hasFatalError) return;
    showLoading();
    audioElement.pause();
    stopSyncLoop();
  };

  const handleSeeked = async () => {
    if (hasFatalError) return;
    if (player.paused) {
      audioElement.currentTime = player.currentTime;
      return;
    }
    await performResync();
    startSyncLoop();
  };

  const handleEnded = () => {
    audioElement.pause();
    stopSyncLoop();
    hideLoading();
  };

  const handleAudioError = () => {
    showError(describeMediaError(audioElement.error));
  };

  const handleRetry = () => {
    hasFatalError = false;
    audioElement.load();
    preloadAudioAndConnect();
  };

  const changePitch = async (delta) => {
    if (hasFatalError) return;

    try {
      await connectAudioPipeline();
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

  audioElement.addEventListener("error", handleAudioError);
  retryButton?.addEventListener("click", handleRetry);

  player.on("play", handlePlayIntent);
  player.on("playing", handlePlaying);
  player.on("pause", handlePause);
  player.on("waiting", handleWaiting);
  player.on("seeked", handleSeeked);
  player.on("ended", handleEnded);

  pitchUpButton?.addEventListener("click", () => changePitch(1));
  pitchDownButton?.addEventListener("click", () => changePitch(-1));

  setupFirstGestureInit();
});
