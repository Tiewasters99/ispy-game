// AudioManager — Central audio module for I Spy Road Trip
// Handles TTS (browser + ElevenLabs), Speech Recognition
// Voice command parsing removed — Claude interprets all speech

const AudioManager = (() => {
    // --- State ---
    let muted = localStorage.getItem('ispy-audio-muted') === 'true';
    let selectedVoice = null;
    let voicesLoaded = false;
    let recognition = null;
    let recognitionMode = null; // 'guess' | 'command'
    let isListening = false;
    let isSpeaking = false;
    let essayAudio = null; // <audio> element for ElevenLabs playback
    let speechAudio = null; // persistent <audio> element for TTS (unlocked on user gesture)
    let isEssayPlaying = false;
    let isPaused = false; // true while recognition is paused for TTS playback
    let silenceTimer = null; // timer for silence-as-send
    let silenceEnabled = false; // set true after TTS finishes, cleared on speech or send

    // Callbacks set by app.js
    let onVoiceGuess = null;
    let onVoiceCommand = null;
    let onSilence = null;

    // Speech Recognition availability
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const hasSpeechRecognition = !!SpeechRecognition;

    // --- Voice Selection ---
    // Prefer male/deep voices for Professor Jones persona. Avoid default female voices.
    const VOICE_AVOID = /sarah|samantha|siri|zira|hazel|susan|jenny|aria/i;

    const VOICE_PRIORITIES = [
        // Male voices by name (cross-platform)
        v => /daniel/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /james/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /guy/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /mark/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /david/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /alex/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /fred/i.test(v.name) && !VOICE_AVOID.test(v.name),
        // Microsoft natural/neural male voices
        v => /microsoft.*(guy|mark|david|ryan)/i.test(v.name),
        v => /microsoft.*online.*natural/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /microsoft.*neural/i.test(v.name) && !VOICE_AVOID.test(v.name),
        // Google voices (typically more neutral)
        v => /google.*us/i.test(v.name) && !VOICE_AVOID.test(v.name),
        v => /google.*uk/i.test(v.name) && !VOICE_AVOID.test(v.name),
        // Any male-tagged voice
        v => /male/i.test(v.name) && !/female/i.test(v.name),
        // Any natural/neural that isn't on the avoid list
        v => /natural|neural|premium|enhanced/i.test(v.name) && !VOICE_AVOID.test(v.name),
        // Any English voice not on the avoid list
        v => /en[-_]/i.test(v.lang) && !VOICE_AVOID.test(v.name),
        // Last resort: anything not on the avoid list
        v => !VOICE_AVOID.test(v.name),
        // True last resort
        () => true
    ];

    function selectBestVoice() {
        const voices = speechSynthesis.getVoices();
        if (!voices.length) return;

        for (const test of VOICE_PRIORITIES) {
            const match = voices.find(v => test(v) && /en/i.test(v.lang));
            if (match) {
                selectedVoice = match;
                voicesLoaded = true;
                console.log('[AudioManager] Selected voice:', match.name, match.lang);
                return;
            }
        }

        selectedVoice = voices[0];
        voicesLoaded = true;
        console.log('[AudioManager] Fallback voice:', voices[0]?.name);
    }

    // --- Init ---
    function init() {
        if ('speechSynthesis' in window) {
            selectBestVoice();
            speechSynthesis.onvoiceschanged = selectBestVoice;
        }

        updateMuteUI();

        essayAudio = document.createElement('audio');
        essayAudio.addEventListener('ended', () => {
            isEssayPlaying = false;
            dispatchEvent('essay-playback-change', { playing: false });
        });
        essayAudio.addEventListener('error', () => {
            isEssayPlaying = false;
            dispatchEvent('essay-playback-change', { playing: false });
        });

        console.log('[AudioManager] Initialized. Muted:', muted, '| Speech Recognition:', hasSpeechRecognition);
    }

    // --- TTS (ElevenLabs only — Professor Jones voice, no browser fallback) ---
    async function speak(text) {
        if (muted || !text) return;

        stopSpeaking();

        // Pause recognition during TTS to prevent echo
        if (isListening) {
            pauseRecognition();
        } else if (!isPaused) {
            isPaused = true;
        }

        try {
            const user = typeof supabase !== 'undefined' ? supabase.auth.getUser() : null;

            const response = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    userId: user?.id || null
                })
            });

            if (response.ok) {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('audio')) {
                    const audioBlob = await response.blob();
                    const audioUrl = URL.createObjectURL(audioBlob);

                    // Reuse the persistent audio element (unlocked on user gesture)
                    const audio = speechAudio || new Audio();
                    audio.onended = () => {
                        isSpeaking = false;
                        URL.revokeObjectURL(audioUrl);
                        resumeRecognition();
                    };
                    audio.onerror = () => {
                        isSpeaking = false;
                        URL.revokeObjectURL(audioUrl);
                        resumeRecognition();
                    };
                    audio.src = audioUrl;
                    isSpeaking = true;

                    await audio.play();
                    return;
                }
            }
        } catch (e) {
            // ElevenLabs failed — no fallback, text is visible in transcript
        }

        // TTS unavailable — just resume recognition so the game continues
        isSpeaking = false;
        resumeRecognition();
    }

    function speakBrowser(text) {
        if (!('speechSynthesis' in window)) {
            // Can't speak at all — just make sure we resume listening
            isSpeaking = false;
            resumeRecognition();
            return;
        }

        speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }

        utterance.onstart = () => { isSpeaking = true; };
        utterance.onend = () => {
            isSpeaking = false;
            resumeRecognition();
        };
        utterance.onerror = () => {
            isSpeaking = false;
            resumeRecognition();
        };

        speechSynthesis.speak(utterance);
    }

    // --- Pre-fetch TTS (starts fetch in parallel with action processing) ---
    function prefetchAudio(text) {
        if (muted || !text) return Promise.resolve(null);

        return fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        }).then(response => {
            if (response.ok) {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('audio')) {
                    return response.blob();
                }
            }
            return null;
        }).catch(() => null);
    }

    async function playPrefetched(blobPromise) {
        stopSpeaking();

        if (isListening) {
            pauseRecognition();
        } else if (!isPaused) {
            isPaused = true;
        }

        try {
            const blob = await blobPromise;
            if (!blob) {
                isSpeaking = false;
                resumeRecognition();
                return;
            }

            const audioUrl = URL.createObjectURL(blob);
            const audio = speechAudio || new Audio();
            audio.onended = () => {
                isSpeaking = false;
                URL.revokeObjectURL(audioUrl);
                resumeRecognition();
            };
            audio.onerror = () => {
                isSpeaking = false;
                URL.revokeObjectURL(audioUrl);
                resumeRecognition();
            };
            audio.src = audioUrl;
            isSpeaking = true;
            await audio.play();
        } catch (e) {
            isSpeaking = false;
            resumeRecognition();
        }
    }

    function stopSpeaking() {
        if (speechAudio) {
            speechAudio.pause();
            speechAudio.currentTime = 0;
        }
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        isSpeaking = false;
    }

    // --- ElevenLabs Essay TTS ---
    async function speakEssay(text) {
        if (muted || !text) return;

        stopEssay();
        stopSpeaking();

        try {
            const user = typeof supabase !== 'undefined' ? supabase.auth.getUser() : null;

            const response = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    userId: user?.id || null
                })
            });

            if (!response.ok) {
                console.warn('[AudioManager] TTS API returned', response.status, '- falling back to browser TTS');
                speak(text);
                return;
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('audio')) {
                console.warn('[AudioManager] TTS API returned non-audio content-type:', contentType);
                speak(text);
                return;
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            essayAudio.src = audioUrl;

            try {
                await essayAudio.play();
                isEssayPlaying = true;
                dispatchEvent('essay-playback-change', { playing: true, source: 'elevenlabs' });
            } catch (playError) {
                console.warn('[AudioManager] Audio play() failed:', playError);
                speak(text);
            }

        } catch (error) {
            console.warn('[AudioManager] ElevenLabs TTS error, falling back to browser:', error);
            speak(text);
        }
    }

    function stopEssay() {
        if (essayAudio) {
            essayAudio.pause();
            essayAudio.currentTime = 0;
            if (essayAudio.src.startsWith('blob:')) {
                URL.revokeObjectURL(essayAudio.src);
            }
            essayAudio.src = '';
        }
        isEssayPlaying = false;
        dispatchEvent('essay-playback-change', { playing: false });
    }

    // --- Speech Recognition ---
    function startListening(mode) {
        if (!hasSpeechRecognition || muted) return false;

        stopListening();

        recognitionMode = mode; // 'guess' or 'command'

        recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        if (mode === 'command') {
            recognition.continuous = true;
        } else {
            recognition.continuous = false;
        }

        recognition.onstart = () => {
            isListening = true;
            dispatchEvent('listening-state-change', { listening: true, mode });
        };

        recognition.onresult = (event) => {
            const result = event.results[event.results.length - 1];
            const transcript = result[0].transcript.trim();

            // Player is speaking — cancel silence timer
            clearSilenceTimer();

            if (result.isFinal) {
                // Both modes pass raw transcript to callback — Claude interprets everything
                if (mode === 'guess' && onVoiceGuess) {
                    onVoiceGuess(transcript);
                } else if (mode === 'command' && onVoiceCommand) {
                    onVoiceCommand(transcript);
                }
            } else {
                // Interim result — show feedback
                dispatchEvent('speech-interim', { transcript, mode });
            }
        };

        recognition.onerror = (event) => {
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
                console.warn('[AudioManager] Recognition error:', event.error);
            }
            if (mode === 'guess') {
                isListening = false;
                dispatchEvent('listening-state-change', { listening: false, mode });
            }
        };

        recognition.onend = () => {
            if (mode === 'command' && isListening && !muted) {
                try {
                    recognition.start();
                } catch (e) {
                    isListening = false;
                    dispatchEvent('listening-state-change', { listening: false, mode });
                }
                return;
            }
            isListening = false;
            dispatchEvent('listening-state-change', { listening: false, mode });
        };

        try {
            recognition.start();
            return true;
        } catch (e) {
            console.warn('[AudioManager] Failed to start recognition:', e);
            return false;
        }
    }

    function stopListening() {
        isListening = false;
        isPaused = false;
        clearSilenceTimer();
        if (recognition) {
            try {
                recognition.abort();
            } catch (e) { /* ignore */ }
            recognition = null;
        }
        recognitionMode = null;
        dispatchEvent('listening-state-change', { listening: false, mode: null });
    }

    function pauseRecognition() {
        if (recognition && isListening) {
            isPaused = true;
            isListening = false; // prevent command-mode auto-restart in onend
            clearSilenceTimer();
            try {
                recognition.abort();
            } catch (e) { /* ignore */ }
        }
    }

    function resumeRecognition() {
        if (isPaused && recognitionMode && !isSpeaking) {
            const mode = recognitionMode;
            isPaused = false;
            // Always create a fresh recognition instance to get clean state
            startListening(mode);
            // Start silence timer — Professor Jones just finished speaking,
            // so if the player says nothing, treat silence as acknowledgment
            startSilenceTimer();
        }
    }

    // --- Silence Detection ---
    // After TTS finishes and recognition resumes, if no speech for ~4s,
    // fire a silence event so the app can auto-send to gamemaster.
    const SILENCE_TIMEOUT = 6000;

    function startSilenceTimer() {
        clearSilenceTimer();
        silenceEnabled = true;
        silenceTimer = setTimeout(() => {
            if (silenceEnabled && !isSpeaking && !isPaused && onSilence) {
                silenceEnabled = false;
                onSilence();
            }
        }, SILENCE_TIMEOUT);
    }

    function clearSilenceTimer() {
        silenceEnabled = false;
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
    }

    // --- Audio Toggle ---
    function toggle() {
        muted = !muted;
        localStorage.setItem('ispy-audio-muted', muted);

        if (muted) {
            stopSpeaking();
            stopEssay();
            stopListening();
        }

        updateMuteUI();
        return !muted;
    }

    function updateMuteUI() {
        const btn = document.getElementById('audio-toggle-btn');
        if (btn) {
            btn.classList.toggle('muted', muted);
            btn.title = muted ? 'Unmute audio' : 'Mute audio';
            const icon = btn.querySelector('.audio-icon');
            if (icon) {
                icon.innerHTML = muted
                    ? '<path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
                    : '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>';
            }
        }
    }

    // --- Unlock audio on mobile (must be called from a user gesture) ---
    function unlock() {
        // Create persistent audio element and unlock it with a silent play
        // This element will be reused for ALL TTS playback
        if (!speechAudio) {
            speechAudio = new Audio();
        }
        try {
            speechAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
            speechAudio.volume = 1;
            speechAudio.play().then(() => {
                speechAudio.pause();
                speechAudio.currentTime = 0;
                speechAudio.src = '';
                console.log('[AudioManager] speechAudio unlocked');
            }).catch(() => {});
        } catch (e) { /* ignore */ }

        // Also unlock AudioContext
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const buffer = ctx.createBuffer(1, 1, 22050);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start(0);
            ctx.resume();
        } catch (e) { /* ignore */ }

        console.log('[AudioManager] Audio unlocked via user gesture');
    }

    // --- Helpers ---
    function dispatchEvent(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function setCallbacks({ guess, command, silence }) {
        if (guess) onVoiceGuess = guess;
        if (command) onVoiceCommand = command;
        if (silence) onSilence = silence;
    }

    // --- Public API ---
    return {
        init,
        unlock,
        speak,
        prefetchAudio,
        playPrefetched,
        stopSpeaking,
        speakEssay,
        stopEssay,
        startListening,
        stopListening,
        toggle,
        setCallbacks,
        clearSilenceTimer,
        get muted() { return muted; },
        get isListening() { return isListening; },
        get isSpeaking() { return isSpeaking; },
        get isEssayPlaying() { return isEssayPlaying; },
        get hasSpeechRecognition() { return hasSpeechRecognition; }
    };
})();
