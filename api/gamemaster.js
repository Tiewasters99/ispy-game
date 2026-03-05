// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Uses Claude Sonnet 4 with tool use for structured round generation
// Deterministic code-level validation for letter matching

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// Base personality prompt — static, never changes
const BASE_PROMPT = `THE GAME IS CALLED "I SPY WITH MY LITTLE EYE." Always use that name.

You ARE Professor Jones — bailed on academia, rides along on road trips because the world is funnier than any syllabus.

VOICE: TTS in a car. Max 15 words per sentence. Snappy, punchy, conversational. No filler, no narrating actions, no "Great question!" If they're wrong, say so fast. If they're right, celebrate fast.

WHO YOU ARE: Witty first, smart second. Playful, mischievous. Volley jokes, find the absurd, drop knowledge like gossip not lectures. Match their energy. Road trip companion FIRST, game master second. The game waits. The person doesn't.

REQUESTS — LISTEN CAREFULLY:
- "hint" / "clue" / "help" / "yes" (to "want a hint?") → NEXT HINT ONLY via reveal_hint. NEVER reveal the answer for a hint request.
- "skip" / "give up" / "next" / "pass" → Reveal answer + essay, then offer next round.
- "what's the answer" / "tell me" → Only THEN reveal the answer.

SETUP (keep SHORT): Greet → ask who's playing (tell them "say 'this is [name]' before answers") → register players → ask difficulty → leader picks category → deliver first clue immediately with create_round.

CREATING ROUNDS: Use create_round tool. Speech MUST begin with "I spy with my little eye something that begins with the letter [X]." Never announce a round without calling create_round.

ANSWER VALIDATION: Wrong letter = instant reject. Must match the answer. Synonyms/alternate names OK. Never accept wrong answers. On correct guess, identify the player.

SCORING: Award points via correct_guess action. Fix mistakes via set_score action. Speech alone changes nothing.

HINT PENALTY: "Hint coming — costs you a point." Include player name in reveal_hint.

BETWEEN ROUNDS: Celebrate (one sentence) → "Any questions about [answer]?" → WAIT (no_action) → On next input, deliver next clue if they're ready.

SILENCE: After clue → no_action. After question → gentle nudge once, then no_action.

RESPONSE: Valid JSON only. {"speech":"...","actions":[...]}`;

/**
 * Build a dynamic system prompt with full game state injected.
 * This is the SINGLE SOURCE OF TRUTH — Claude should trust this over anything
 * in the (minimal) conversation history.
 */
function buildSystemPrompt(gameState, locationContext) {
    const phase = gameState?.phase || 'setup_intro';
    const round = gameState?.currentRound || {};
    const players = gameState?.players || [];
    const previousAnswers = gameState?.previousAnswers || [];

    let stateBlock = `\n\n=== CURRENT GAME STATE (authoritative — trust this over everything) ===
Phase: ${phase}
Round: #${gameState?.roundNumber || 0}
Category: ${gameState?.category || 'not set'}
Difficulty: ${gameState?.difficulty || 'not set (default medium)'}`;

    if (round.letter && round.answer) {
        stateBlock += `
Current letter: ${round.letter}
Current answer: ${round.answer}
Hints revealed: ${round.hintsRevealed || 0}/3`;
    } else {
        stateBlock += `
Current round: none active`;
    }

    if (players.length > 0) {
        stateBlock += `
Players: ${players.map(p => `${p.name}${p.isLeader ? ' (leader)' : ''}: ${p.score} pts`).join(', ')}`;
    } else {
        stateBlock += `
Players: none registered yet`;
    }

    if (locationContext) {
        stateBlock += `
Location: ${locationContext}`;
    }

    if (previousAnswers.length > 0) {
        stateBlock += `
Used answers (NEVER repeat): ${previousAnswers.join(', ')}`;
    }

    stateBlock += '\n===';

    return BASE_PROMPT + stateBlock;
}

// Tool definitions for structured round generation
const TOOLS = [
    {
        name: 'create_round',
        description: 'Create a new I Spy round with a letter, answer, hints, and essay. The answer MUST start with the given letter. The system will validate this automatically.',
        input_schema: {
            type: 'object',
            properties: {
                letter: {
                    type: 'string',
                    description: 'A single uppercase letter (A-Z) for this round'
                },
                answer: {
                    type: 'string',
                    description: 'The answer that players must guess. MUST start with the given letter.'
                },
                hints: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Exactly 3 hints, ordered from vague to specific',
                    minItems: 3,
                    maxItems: 3
                },
                essay: {
                    type: 'string',
                    description: 'A 2-3 sentence fun fact essay about the answer'
                },
                proximity: {
                    type: 'string',
                    enum: ['here', 'nearby', 'region'],
                    description: 'How close the answer is to the players GPS location'
                },
                nearbyLocation: {
                    type: 'string',
                    description: 'If proximity is nearby, the name of the nearby location'
                },
                speech: {
                    type: 'string',
                    description: 'What Professor Jones says when presenting this clue. MUST begin with "I spy with my little eye something that begins with the letter [X]." followed by a brief teaser.'
                }
            },
            required: ['letter', 'answer', 'hints', 'essay', 'proximity', 'speech']
        }
    }
];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, gameState, conversationHistory, transcript } = req.body;

    if (!transcript && !gameState) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
    }

    // Initialize Supabase
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Determine credit cost: 10 for round-starting calls, 3 for follow-ups
    const isRoundStart = gameState?.phase === 'playing' &&
        (!gameState.currentRound?.answer || transcript === '[Start next round]' || transcript === '[Game session started]');
    const creditCost = isRoundStart ? 10 : 3;

    // Check user credits and deduct if userId provided
    let remainingCredits = null;
    if (userId) {
        const { data: user, error } = await supabase
            .from('users')
            .select('credits, is_subscriber')
            .eq('id', userId)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'User not found' });
        }

        if (user.is_subscriber) {
            remainingCredits = 'unlimited';
        } else {
            if (user.credits < creditCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: creditCost
                });
            }

            remainingCredits = user.credits - creditCost;

            supabase
                .from('users')
                .update({ credits: remainingCredits })
                .eq('id', userId)
                .then(null, err => console.error('Credit deduct failed:', err));
        }
    }

    // Build location context
    const location = gameState?.location || {};
    let locationContext = '';
    if (location.city && location.region) {
        locationContext = `${location.city}${location.county ? ', ' + location.county : ''}, ${location.region} (GPS: ${location.latitude}, ${location.longitude})`;
    } else if (location.latitude && location.longitude) {
        locationContext = `GPS: ${location.latitude}, ${location.longitude}`;
    }

    const previousAnswers = gameState?.previousAnswers || [];

    // Build dynamic system prompt with full state — this is the source of truth
    const systemPrompt = buildSystemPrompt(gameState, locationContext);

    // Build messages: only last 2 messages (1 exchange) for immediate conversational
    // continuity (e.g. "want a hint?" → "yes"), then the current user message.
    // All authoritative state is in the system prompt, not in history.
    const messages = [];
    const history = (conversationHistory || []).slice(-2);
    for (const entry of history) {
        messages.push({
            role: entry.role,
            content: entry.content
        });
    }

    // Current user message — just the transcript, no state (state is in system prompt)
    messages.push({
        role: 'user',
        content: transcript
    });

    const client = new Anthropic({ apiKey });

    // Set NDJSON headers
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        // Call Claude with tools available
        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages,
            tools: TOOLS
        });

        // Process the response — may contain text, tool_use, or both
        let speech = '';
        let actions = [];
        let toolUseBlock = null;

        for (const block of response.content) {
            if (block.type === 'text') {
                // Parse the JSON text response for speech and actions
                let parsed = tryParseJSON(block.text);
                if (parsed) {
                    if (parsed.speech) speech = parsed.speech;
                    if (parsed.actions) actions = parsed.actions;
                }
            } else if (block.type === 'tool_use' && block.name === 'create_round') {
                toolUseBlock = block;
            }
        }

        // If Claude called create_round, validate and convert to start_round action
        if (toolUseBlock) {
            const round = toolUseBlock.input;
            const letter = (round.letter || '').toUpperCase();
            const answer = round.answer || '';

            // DETERMINISTIC VALIDATION: answer must start with the letter
            if (answer && letter && answer[0].toUpperCase() === letter) {
                // Valid — convert to start_round action
                actions.push({
                    type: 'start_round',
                    letter: letter,
                    answer: answer,
                    hints: round.hints || [],
                    essay: round.essay || '',
                    proximity: round.proximity || 'region',
                    nearbyLocation: round.nearbyLocation || null
                });

                // Use speech from the tool call if main speech is empty
                if (!speech && round.speech) {
                    speech = round.speech;
                }
            } else {
                // LETTER MISMATCH — retry with explicit correction
                console.warn(`[Gamemaster] Letter mismatch: "${answer}" doesn't start with "${letter}". Retrying...`);

                const retryResult = await retryRoundGeneration(client, letter, previousAnswers, gameState, locationContext);
                if (retryResult) {
                    actions.push({
                        type: 'start_round',
                        letter: retryResult.letter,
                        answer: retryResult.answer,
                        hints: retryResult.hints || [],
                        essay: retryResult.essay || '',
                        proximity: retryResult.proximity || 'region',
                        nearbyLocation: retryResult.nearbyLocation || null
                    });
                    if (!speech && retryResult.speech) {
                        speech = retryResult.speech;
                    }
                } else {
                    // Retry also failed — ask for a different letter entirely
                    speech = speech || "Hmm, let me try a different letter.";
                    // Pick a random letter that hasn't been used recently
                    const usedLetters = previousAnswers.map(a => a[0]?.toUpperCase()).filter(Boolean);
                    const available = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => !usedLetters.includes(l));
                    const fallbackLetter = available.length > 0
                        ? available[Math.floor(Math.random() * available.length)]
                        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];

                    const fallbackResult = await retryRoundGeneration(client, fallbackLetter, previousAnswers, gameState, locationContext);
                    if (fallbackResult) {
                        actions.push({
                            type: 'start_round',
                            letter: fallbackResult.letter,
                            answer: fallbackResult.answer,
                            hints: fallbackResult.hints || [],
                            essay: fallbackResult.essay || '',
                            proximity: fallbackResult.proximity || 'region',
                            nearbyLocation: fallbackResult.nearbyLocation || null
                        });
                        speech = fallbackResult.speech || speech;
                    }
                }
            }
        }

        // If no actions parsed, default to no_action
        if (actions.length === 0) {
            actions = [{ type: 'no_action' }];
        }

        // Send speech early for TTS
        if (speech) {
            res.write(JSON.stringify({ type: 'speech', speech }) + '\n');
        }

        // Send complete response
        res.write(JSON.stringify({
            type: 'complete',
            speech: speech,
            actions: actions,
            remainingCredits
        }) + '\n');
        return res.end();
    } catch (error) {
        console.error('Gamemaster error:', error?.message || error, error?.status || '');
        if (!res.headersSent) {
            return res.status(500).json({
                error: 'Failed to process',
                detail: error?.message || String(error),
                speech: "Sorry, I lost my train of thought. Say that again?",
                actions: [{ type: 'no_action' }]
            });
        }
        res.write(JSON.stringify({
            type: 'error',
            speech: "Sorry, I lost my train of thought. Say that again?",
            actions: [{ type: 'no_action' }]
        }) + '\n');
        return res.end();
    }
}

/**
 * Retry round generation with a specific letter using forced tool_choice.
 * Returns validated round data or null.
 */
async function retryRoundGeneration(client, letter, previousAnswers, gameState, locationContext) {
    const prevAnswersList = previousAnswers.length > 0 ? previousAnswers.join(', ') : 'none';
    const category = gameState?.category || 'general';
    const difficulty = gameState?.difficulty || 'medium';

    const retryMessages = [
        {
            role: 'user',
            content: `Generate an I Spy round for the letter "${letter}". Category: ${category}. Difficulty: ${difficulty}. Location: ${locationContext || 'Unknown'}. Already used answers (do NOT repeat): ${prevAnswersList}. The answer MUST start with the letter "${letter}". Call the create_round tool.`
        }
    ];

    try {
        const retryResponse = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 512,
            system: 'You generate I Spy game rounds. Always use the create_round tool. The answer MUST start with the specified letter. Begin your speech with "I spy with my little eye something that begins with the letter [X]." followed by a brief teaser.',
            messages: retryMessages,
            tools: TOOLS,
            tool_choice: { type: 'tool', name: 'create_round' }
        });

        for (const block of retryResponse.content) {
            if (block.type === 'tool_use' && block.name === 'create_round') {
                const round = block.input;
                const roundLetter = (round.letter || '').toUpperCase();
                const roundAnswer = round.answer || '';

                if (roundAnswer && roundLetter && roundAnswer[0].toUpperCase() === roundLetter) {
                    return { ...round, letter: roundLetter };
                }
                console.warn(`[Gamemaster] Retry also mismatched: "${roundAnswer}" for letter "${roundLetter}"`);
            }
        }
    } catch (err) {
        console.error('[Gamemaster] Retry failed:', err?.message || err);
    }
    return null;
}

/**
 * Try to parse JSON from Claude's text response.
 * Handles both clean JSON and JSON embedded in other text.
 */
function tryParseJSON(text) {
    if (!text || !text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch {
                return null;
            }
        }
        return null;
    }
}
