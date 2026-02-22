// AudioManager — Central audio module for I Spy Road Trip
// Handles TTS (browser + ElevenLabs), Speech Recognition, and voice commands

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
    let isEssayPlaying = false;

    // Callbacks set by app.js
    let onVoiceGuess = null;
    let onVoiceCommand = null;

    // Speech Recognition availability
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const hasSpeechRecognition = !!SpeechRecognition;

    // --- Voice Selection ---
    // Priority-ranked search for best available browser voice
    const VOICE_PRIORITIES = [
        // Microsoft Neural voices (Edge/Windows) — excellent quality
        v => /microsoft.*online.*natural/i.test(v.name),
        v => /microsoft.*neural/i.test(v.name),
        // Google voices (Chrome) — good quality
        v => /google.*us/i.test(v.name),
        v => /google/i.test(v.name),
        // Any voice with "natural" or "neural" in name
        v => /natural/i.test(v.name),
        v => /neural/i.test(v.name),
        // Any premium/enhanced voice
        v => /premium|enhanced/i.test(v.name),
        // Any English voice
        v => /en[-_]/i.test(v.lang),
        // Absolute fallback: first available
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

        // Ultimate fallback — just pick first voice
        selectedVoice = voices[0];
        voicesLoaded = true;
        console.log('[AudioManager] Fallback voice:', voices[0]?.name);
    }

    // --- Init ---
    function init() {
        // Load voices (async on most browsers)
        if ('speechSynthesis' in window) {
            selectBestVoice();
            speechSynthesis.onvoiceschanged = selectBestVoice;
        }

        // Restore mute state
        updateMuteUI();

        // Create reusable audio element for essay playback
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

    // --- TTS (ElevenLabs primary, browser fallback) ---
    async function speak(text) {
        if (muted || !text) return;

        // Stop any ongoing speech
        stopSpeaking();

        // Auto-pause mic while speaking to prevent echo pickup
        const wasListening = isListening;
        if (wasListening) {
            pauseRecognition();
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

                    // Use a temporary audio element for short utterances
                    const audio = new Audio(audioUrl);
                    isSpeaking = true;

                    audio.onended = () => {
                        isSpeaking = false;
                        URL.revokeObjectURL(audioUrl);
                        if (wasListening) resumeRecognition();
                    };
                    audio.onerror = () => {
                        isSpeaking = false;
                        URL.revokeObjectURL(audioUrl);
                        if (wasListening) resumeRecognition();
                    };

                    await audio.play();
                    return;
                }
            }
        } catch (e) {
            // Fall through to browser TTS
        }

        // Browser TTS fallback
        speakBrowser(text, wasListening);
    }

    function speakBrowser(text, resumeAfter) {
        if (!('speechSynthesis' in window)) return;

        speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }

        utterance.onstart = () => {
            isSpeaking = true;
        };

        utterance.onend = () => {
            isSpeaking = false;
            if (resumeAfter) resumeRecognition();
        };

        utterance.onerror = () => {
            isSpeaking = false;
            if (resumeAfter) resumeRecognition();
        };

        speechSynthesis.speak(utterance);
    }

    function stopSpeaking() {
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        isSpeaking = false;
    }

    // --- ElevenLabs Essay TTS ---
    async function speakEssay(text) {
        if (muted || !text) return;

        // Stop any current essay playback and browser TTS
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

        // Stop any existing session
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

            if (result.isFinal) {
                if (mode === 'guess' && onVoiceGuess) {
                    onVoiceGuess(transcript);
                } else if (mode === 'command') {
                    const parsed = parseVoiceCommand(transcript);
                    if (parsed && onVoiceCommand) {
                        onVoiceCommand(parsed.action, transcript);
                    }
                }
            } else {
                // Interim result — show feedback
                dispatchEvent('speech-interim', { transcript, mode });
            }
        };

        recognition.onerror = (event) => {
            // 'no-speech' and 'aborted' are expected, not real errors
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
                console.warn('[AudioManager] Recognition error:', event.error);
            }
            // For guess mode, stop after error
            if (mode === 'guess') {
                isListening = false;
                dispatchEvent('listening-state-change', { listening: false, mode });
            }
        };

        recognition.onend = () => {
            if (mode === 'command' && isListening && !muted) {
                // Restart continuous listening for commands
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
            try {
                recognition.abort();
            } catch (e) { /* ignore */ }
        }
    }

    function resumeRecognition() {
        if (recognitionMode && !isSpeaking) {
            startListening(recognitionMode);
        }
    }

    // --- Voice Command Parser ---
    function parseVoiceCommand(transcript) {
        const t = transcript.toLowerCase().trim();
        if (!t) return null;

        // Order matters — more specific patterns first
        const commands = [
            { patterns: [/\bhint\b/, /\banother hint\b/, /\bnext hint\b/], action: 'hint' },
            { patterns: [/\bgive up\b/, /\bshow answer\b/, /\bi give up\b/, /\bshow me\b/], action: 'giveUp' },
            { patterns: [/\bnext round\b/, /\bnext\b/, /\bcontinue\b/, /\bkeep going\b/], action: 'next' },
            { patterns: [/\blearn more\b/, /\btell me more\b/, /\bmore info\b/], action: 'learnMore' },
            { patterns: [/\bhungry for more\b/, /\byes.*(more|please|sure)\b/, /\bask (a |another )?question\b/], action: 'hungryForMore' },
            { patterns: [/\bread aloud\b/, /\bread it\b/, /\bread the essay\b/, /\bread to me\b/], action: 'readAloud' },
            { patterns: [/\bstop\b/, /\bquiet\b/, /\bshut up\b/, /\bsilence\b/], action: 'stop' },
            { patterns: [/\bend game\b/, /\bquit\b/, /\bstop game\b/, /\bexit\b/], action: 'endGame' }
        ];

        for (const cmd of commands) {
            for (const pattern of cmd.patterns) {
                if (pattern.test(t)) {
                    return { action: cmd.action, transcript: t };
                }
            }
        }

        // No command matched — treat as a guess attempt
        return { action: 'guess', transcript: t };
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
        return !muted; // returns true if audio is now ON
    }

    function updateMuteUI() {
        const btn = document.getElementById('audio-toggle-btn');
        if (btn) {
            btn.classList.toggle('muted', muted);
            btn.title = muted ? 'Unmute audio' : 'Mute audio';
            // Update SVG icon
            const icon = btn.querySelector('.audio-icon');
            if (icon) {
                icon.innerHTML = muted
                    ? '<path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
                    : '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>';
            }
        }
    }

    // --- Helpers ---
    function dispatchEvent(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function setCallbacks({ guess, command }) {
        if (guess) onVoiceGuess = guess;
        if (command) onVoiceCommand = command;
    }

    // --- Public API ---
    return {
        init,
        speak,
        stopSpeaking,
        speakEssay,
        stopEssay,
        startListening,
        stopListening,
        toggle,
        setCallbacks,
        get muted() { return muted; },
        get isListening() { return isListening; },
        get isSpeaking() { return isSpeaking; },
        get isEssayPlaying() { return isEssayPlaying; },
        get hasSpeechRecognition() { return hasSpeechRecognition; }
    };
})();
