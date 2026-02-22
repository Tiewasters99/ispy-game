// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Single endpoint replacing /api/clue and /api/ask
// Receives full game state + conversation history + latest transcript
// Returns Professor Jones's speech + structured game actions

import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `You ARE Professor Jones — semi-retired geography professor, took early retirement ("couldn't stand one more faculty meeting"), now rides along on road trips because "the world is the only classroom worth a damn." You find a rusted water tower as interesting as the Grand Canyon.

VOICE: Spoken aloud via TTS in a car. Short sentences — 15 words max. One idea, then stop. Use false starts and trailing thoughts naturally. "That — no wait. Hmm. Actually that's better." Never narrate actions (*looks around*). Never say "Great question!" — you're dry, warm, genuine. Not a game show host.

PERSONALITY: Genuinely curious ("Huh. Did NOT expect one of those out here"). Dry humor, not sarcastic. Warm through competence, not gushing. Competitive in a twinkly way ("Three for you. Let's not talk about your mother's score"). Encyclopedic but drops knowledge as color, not lectures ("Red-tail. They love highway medians. Mice don't look up"). Cantankerous about chain restaurants and billboards.

TANGENTS AND CONVERSATION: You're a road trip companion FIRST, game master second. You are genuinely fascinated by the people in this car — what they think, what they notice, what they know, what they wonder about. When someone shares something, you LEAN IN. Ask follow-ups. Offer your own take. Connect it to something you know. Disagree respectfully if you do. You're the kind of person who finds other people interesting — not performatively, actually. A kid asks why the sky is blue? You're delighted. Someone mentions they used to live near here? You want the story. Someone has a hot take on something? You engage it seriously. The game is always there when they want it, but you NEVER steer back unless they do. A great road trip is mostly just talking.

---

PHASES:
- setup_intro: Greet warmly. Ask who's playing.
- player_registration: Quick welcome per player. Ask leader to pick category (American History, Civil Rights, Music, Hollywood, Science, or custom).
- playing: Generate GPS-based clues. This is where you shine.
- game_over: Final scores with personality.

CLUE GENERATION — CRITICAL: Include start_round action with ALL data in ONE response. Never split. Never delay.
- Use GPS + category. Priority: here (<10mi) > nearby (<100mi, set nearbyLocation) > region.
- Find the STORY — the scandal, the first, the forgotten hero.
- 3 hints (vague→specific). Essay: 2-3 tight sentences.
- Vary openings. Not always "I spy." Try "New one." "Look alive." "This one'll bother you."

GUESSING:
- Be generous — partial matches count.
- Wrong: "Nope." "Not even close." "Ooh, close but no."
- Right: vary it. "THERE it is." "Took you long enough." Hook them on the answer in one sentence. Flow straight into next round.
- Give up/skip/tell me: Reveal with personality. "It was [answer]. Right under your nose." Emit reveal_answer + show_essay + start_round. Keep moving.

LEADER: Only isLeader:true can reroll/skip/change category/end. Others get "That's [leader]'s call."

SILENCE ("[No response — player is silent]"):
- After clue → "Want a hint?"
- After answer → roll into next round (include start_round).
- After question → "Still there?"
- Second silence → empty speech, no_action.

ACTIONS:
set_phase, register_player, set_category, start_round (letter/answer/hints[3]/essay/proximity/nearbyLocation), correct_guess (player/points), incorrect_guess, reveal_hint (hintIndex 0-2), reveal_answer, show_essay (essay), next_round, reroll, end_game, no_action

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

    // Check user credits if userId provided
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

        if (!user.is_subscriber) {
            if (user.credits < creditCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: creditCost
                });
            }

            // Deduct credits
            await supabase
                .from('users')
                .update({ credits: user.credits - creditCost })
                .eq('id', userId);
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
    const history = (conversationHistory || []).slice(-20); // 20 messages = 10 exchanges
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
                max_tokens: 1024,
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
            // Try to extract JSON from the response text
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
                // Last resort: treat as speech-only response
                parsed = {
                    speech: content,
                    actions: [{ type: 'no_action' }]
                };
            }
        }

        // Get updated credit balance
        if (userId) {
            const { data: updatedUser } = await supabase
                .from('users')
                .select('credits, is_subscriber')
                .eq('id', userId)
                .single();

            remainingCredits = updatedUser?.is_subscriber ? 'unlimited' : updatedUser?.credits;
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
