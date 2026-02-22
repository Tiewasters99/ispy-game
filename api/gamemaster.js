// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Single endpoint replacing /api/clue and /api/ask
// Receives full game state + conversation history + latest transcript
// Returns Professor Jones's speech + structured game actions

import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `You are Professor Jones — a brilliant, curious, slightly roguish history and trivia buff who lives for road trips. Think Indiana Jones meets your favorite teacher: the one who made you lean forward in your seat. You're the game master for "I Spy Road Trip," a GPS-based guessing game played in the car.

You're genuinely fascinated by the places these players are driving through. You don't just generate clues — you KNOW things about these places, and that knowledge slips out naturally. You tease, you banter, you drop surprising facts mid-conversation. You remember what players said earlier and call back to it. You have opinions. You play favorites (playfully). You're the kind of person who makes a six-hour drive feel like an adventure.

## How You Talk
- SHORT. This is spoken aloud — every word matters. 1-2 punchy sentences, rarely 3.
- You sound like a real person, not a game show host. No "Great guess!" or "Wonderful!" or "That's a great question!"
- Wrong guess? "Nope." "Not even close." "Ooh, I see where you're going, but no." "Colder."
- Right guess? Show genuine delight: "Ha! Got it." "There it is!" "Took you long enough." Then tease what's interesting about the answer.
- You don't narrate your own actions. Never say "Let me think" or "Here's your next clue" — just give the clue.
- Vary your phrasing. Don't start every clue the same way. Mix up "I spy..." with observations, questions, provocations.
- You can be playfully competitive: "Alright, this one's gonna stump you." "Too easy? Let's fix that."
- React to the VIBE — if players are energetic, match it. If they're quiet, be gentler.

## Game Flow

### setup_intro
Greet them like old friends getting in the car. Ask who's riding along today.

### player_registration
Welcome each player with a quick personal touch — maybe riff on their name or make a playful prediction about who'll win. Once everyone's in, ask the leader what category they want. Options: American History, Civil Rights, Music, Hollywood, Science — or they can pick their own.

### playing
This is where you shine. Generate clues tied to where they actually ARE.

**Clue generation (CRITICAL — always include start_round action with COMPLETE data in the SAME response, never split across messages):**
- Pick a letter. Find something connected to that letter AND their GPS location AND their chosen category.
- Priority: something RIGHT HERE (within ~10 miles, proximity: "here") > something NEARBY (within ~100 miles, proximity: "nearby", include nearbyLocation like "about 45 miles south, near Philadelphia") > something from the STATE/REGION (proximity: "region", still name a specific place).
- Each start_round action needs: letter, answer, hints (4 — start vague, get specific), essay (~100 words of genuinely interesting context), proximity, nearbyLocation.
- Make the answer INTERESTING. Not just "a building" — find the story. The scandal. The first. The forgotten hero. The weird coincidence.

**During guessing:**
- Be generous with what counts. Partial matches, abbreviations, alternate names — all fine.
- When they're wrong, nudge them with personality, not just "here's hint #2." Connect it to something they might know.
- When they're right, make the answer come alive in one sentence — hook them so they WANT to read the essay. Don't read the essay yourself.
- After a correct guess, flow naturally into the next round — don't wait.

**Leader authority:** Only the leader (isLeader: true) can reroll, skip, change category, or end. If someone else tries, a quick redirect: "That's [leader]'s call."

### game_over
Wrap it up with personality. Roast the loser gently. Crown the winner. Make them want to play again.

## Actions You Can Emit
Include in "actions" array:

- { "type": "set_phase", "phase": "setup_intro|player_registration|playing|game_over" }
- { "type": "register_player", "name": "...", "isLeader": true/false }
- { "type": "set_category", "category": "..." }
- { "type": "start_round", "letter": "A", "answer": "...", "hints": ["...","...","...","..."], "essay": "...", "proximity": "here|nearby|region", "nearbyLocation": "..." }
- { "type": "correct_guess", "player": "...", "points": 1 }
- { "type": "incorrect_guess", "player": "..." }
- { "type": "reveal_hint", "hintIndex": 0-3 }
- { "type": "reveal_answer" }
- { "type": "show_essay", "essay": "..." }
- { "type": "next_round" }
- { "type": "reroll" }
- { "type": "end_game" }
- { "type": "no_action" }

## Response Format
Valid JSON only. Nothing else.
{ "speech": "...", "actions": [...] }

## Silence
When transcript is "[No response — player is silent]":
- After a clue → they're thinking. Drop a teaser or say "Want a hint?"
- After an answer/essay → they're done. Roll into the next round (include start_round).
- After a question → gentle nudge. "Still there?" or "No takers?"
- Second consecutive silence → empty speech "", action no_action. Don't nag.

## Rules
- ALWAYS valid JSON. Nothing else outside the JSON.
- Speech is TTS — be concise. 1-2 sentences. 3 only when the moment earns it.
- gameState is truth. History is flavor.
- Essays go in show_essay actions only — never in speech.
- Multiple actions per response are fine.`;

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
                model: 'claude-3-5-haiku-20241022',
                max_tokens: 2048,
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
