// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Single endpoint replacing /api/clue and /api/ask
// Receives full game state + conversation history + latest transcript
// Returns Professor Jones's speech + structured game actions

import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `You ARE Professor Jones — bailed on academia, rides along on road trips because the world is funnier than any syllabus.

VOICE: TTS in a car. Max 15 words per sentence. Conversational — false starts, pivots. Never narrate actions. Never "Great question!" Be quick, warm, real.

WHO YOU ARE: Witty first, smart second. Playful, mischievous, rebel at heart. You love repartee — volley jokes back, find the absurd, drop knowledge like gossip not lectures. Game for ANY direction: tangents, hypotheticals, dumb jokes. Match their energy. Never ornery, never grumpy. Even disagreements come with a grin. Road trip companion FIRST, game master second. Lean into what people share — riff, connect to something unexpected, take it somewhere funny. The game waits. The person doesn't.

WHEN ASKED TO DO SOMETHING (hint/skip/next/answer): Just DO it. Don't echo or confirm.

PHASES: setup_intro → greet, ask who's playing. player_registration → welcome each, leader picks category (American History, Civil Rights, Music, Hollywood, Science, or custom). playing → GPS-based clues. game_over → final scores.

CLUES: Include start_round with ALL data in ONE response. GPS + category. Priority: here (<10mi) > nearby (<100mi, set nearbyLocation) > region. Find the STORY. 3 hints (vague→specific). Essay: 2-3 sentences. Vary openings — not always "I spy."

GUESSING: Be generous — partial matches count. Wrong: quick reaction. Right: vary it, hook them on the answer, flow into next round. Skip/give up: reveal + show_essay + start_round.

LEADER: Only isLeader:true can reroll/skip/change category/end.

SILENCE ("[No response — player is silent]"): After clue → say NOTHING, emit no_action. After answer/essay → next round. After your question → one gentle nudge. Second silence → empty speech, no_action.

ACTIONS: set_phase, register_player, set_category, start_round(letter/answer/hints[3]/essay/proximity/nearbyLocation), correct_guess(player/points), incorrect_guess, reveal_hint(hintIndex 0-2), reveal_answer, show_essay(essay), next_round, reroll, end_game, no_action

RESPONSE: Valid JSON only. {"speech":"...","actions":[...]}
gameState = truth. Essays in show_essay only, never speech.`;

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

    // Check user credits and deduct in one query if userId provided
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

            // Deduct credits (don't await — fire and forget, we already computed the balance)
            supabase
                .from('users')
                .update({ credits: remainingCredits })
                .eq('id', userId)
                .then(null, err => console.error('Credit deduct failed:', err));
        }
    }

    // Build the user message with current game state context
    const location = gameState?.location || {};
    let locationContext = '';
    if (location.city && location.region) {
        locationContext = `Players are near ${location.city}${location.county ? ', ' + location.county : ''}, ${location.region}. GPS: ${location.latitude}, ${location.longitude}.`;
    } else if (location.latitude && location.longitude) {
        locationContext = `Players at GPS: ${location.latitude}, ${location.longitude}.`;
    }

    // Strip essay from currentRound to save tokens (Claude already generated it)
    const roundForContext = gameState?.currentRound ? { ...gameState.currentRound } : {};
    delete roundForContext.essay;

    const stateDescription = `
GAME STATE:
Phase: ${gameState?.phase || 'setup_intro'} | Round: ${gameState?.roundNumber || 0} | Category: ${gameState?.category || 'none'}
Players: ${JSON.stringify(gameState?.players || [])}
Round: ${JSON.stringify(roundForContext)}
Location: ${locationContext || 'Unknown'}

"${transcript}"`;

    // Build messages array with conversation history
    const messages = [];

    // Add conversation history (last 10 exchanges)
    const history = (conversationHistory || []).slice(-12); // 12 messages = 6 exchanges
    for (const entry of history) {
        messages.push({
            role: entry.role,
            content: entry.content
        });
    }

    // Add the current user message
    messages.push({
        role: 'user',
        content: stateDescription
    });

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 512,
                system: SYSTEM_PROMPT,
                messages: messages
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Claude API error:', errorData);
            return res.status(response.status).json({ error: 'Claude API error' });
        }

        const data = await response.json();
        const content = data.content[0].text;

        // Parse JSON response — try direct parse, then regex fallback
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    parsed = JSON.parse(jsonMatch[0]);
                } catch (e2) {
                    console.error('Failed to parse Claude response:', content);
                    return res.status(500).json({
                        error: 'Failed to parse response',
                        speech: "Sorry, I lost my train of thought. Say that again?",
                        actions: [{ type: 'no_action' }]
                    });
                }
            } else {
                parsed = {
                    speech: content,
                    actions: [{ type: 'no_action' }]
                };
            }
        }

        return res.status(200).json({
            speech: parsed.speech || '',
            actions: parsed.actions || [{ type: 'no_action' }],
            remainingCredits
        });
    } catch (error) {
        console.error('Gamemaster error:', error);
        return res.status(500).json({
            error: 'Failed to process',
            speech: "Sorry, I lost my train of thought. Say that again?",
            actions: [{ type: 'no_action' }]
        });
    }
}
