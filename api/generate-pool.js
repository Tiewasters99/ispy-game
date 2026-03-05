// Vercel Serverless Function — Pre-generate a pool of I Spy answers
// Called once when category + difficulty are set, generates 10 validated rounds
// Returns an array of {letter, answer, hints[3], essay, proximity} objects

import Anthropic from '@anthropic-ai/sdk';

const POOL_TOOL = {
    name: 'answer_pool',
    description: 'Generate a pool of I Spy game answers. Each answer MUST start with its assigned letter.',
    input_schema: {
        type: 'object',
        properties: {
            answers: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        letter: {
                            type: 'string',
                            description: 'A single uppercase letter (A-Z)'
                        },
                        answer: {
                            type: 'string',
                            description: 'The answer — MUST start with the assigned letter'
                        },
                        hints: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '3 hints, vague to specific',
                            minItems: 3,
                            maxItems: 3
                        },
                        essay: {
                            type: 'string',
                            description: '2-3 sentence fun fact about the answer'
                        },
                        speech: {
                            type: 'string',
                            description: 'Professor Jones announcing this round. MUST begin with "I spy with my little eye something that begins with the letter [X]." Then a brief witty teaser. Keep under 2 sentences total.'
                        }
                    },
                    required: ['letter', 'answer', 'hints', 'essay', 'speech']
                }
            }
        },
        required: ['answers']
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { category, difficulty, location, previousAnswers } = req.body;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
    }

    // Pick 10 random letters, avoiding letters already used
    const usedLetters = (previousAnswers || []).map(a => a[0]?.toUpperCase()).filter(Boolean);
    const available = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => !usedLetters.includes(l));

    // If fewer than 10 available, allow repeats of letters (different answers)
    let letters;
    if (available.length >= 10) {
        // Shuffle and take 10
        letters = available.sort(() => Math.random() - 0.5).slice(0, 10);
    } else {
        letters = available.sort(() => Math.random() - 0.5);
        // Pad with random letters to get to 10
        while (letters.length < 10) {
            letters.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]);
        }
    }

    const locationStr = location?.city
        ? `${location.city}${location.county ? ', ' + location.county : ''}, ${location.region}`
        : 'United States';

    const prevList = (previousAnswers || []).length > 0
        ? (previousAnswers || []).join(', ')
        : 'none';

    const client = new Anthropic({ apiKey });

    try {
        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            system: 'You generate I Spy game answer pools. Always use the answer_pool tool. Every answer MUST start with its assigned letter — this is validated by code. Be creative and varied. Avoid the most obvious/famous answers. Each essay should teach something genuinely surprising. For speech: always begin with "I spy with my little eye something that begins with the letter [X]." then add a brief witty teaser. Keep speech punchy — 2 sentences max.',
            messages: [{
                role: 'user',
                content: `Generate one answer per letter for: ${letters.join(', ')}.
Category: ${category || 'general knowledge'}.
Difficulty: ${difficulty || 'medium'} (easy = household names, medium = mix, hard = deep cuts).
Players are near: ${locationStr}. Prefer local/regional connections when possible.
Already used answers (do NOT repeat any): ${prevList}.
Each answer MUST start with its assigned letter. Be creative — avoid the most obvious entry for each letter.`
            }],
            tools: [POOL_TOOL],
            tool_choice: { type: 'tool', name: 'answer_pool' }
        });

        // Extract the tool use result
        let pool = [];
        for (const block of response.content) {
            if (block.type === 'tool_use' && block.name === 'answer_pool') {
                pool = block.input.answers || [];
            }
        }

        // Validate each answer: letter must match
        const validated = pool.filter(entry => {
            const letter = (entry.letter || '').toUpperCase();
            const answer = entry.answer || '';
            if (!answer || !letter) return false;
            if (answer[0].toUpperCase() !== letter) {
                console.warn(`[Pool] Rejected: "${answer}" doesn't start with "${letter}"`);
                return false;
            }
            return true;
        }).map(entry => ({
            letter: entry.letter.toUpperCase(),
            answer: entry.answer,
            hints: entry.hints || [],
            essay: entry.essay || '',
            speech: entry.speech || `I spy with my little eye something that begins with the letter ${entry.letter.toUpperCase()}.`,
            proximity: 'region'
        }));

        return res.status(200).json({ pool: validated });
    } catch (error) {
        console.error('[Pool] Generation failed:', error?.message || error);
        return res.status(500).json({
            error: 'Pool generation failed',
            detail: error?.message || String(error)
        });
    }
}
