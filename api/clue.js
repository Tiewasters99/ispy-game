// Vercel Serverless Function - Claude API Integration
// This keeps the API key secure on the server side

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { category, letter, latitude, longitude, city, region, userId, token } = req.body;

    if (!category || !letter) {
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

    // Check user credits if userId provided
    if (userId) {
        const { data: user, error } = await supabase
            .from('users')
            .select('credits, is_subscriber')
            .eq('id', userId)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'User not found' });
        }

        // Subscribers have unlimited access
        if (!user.is_subscriber) {
            // Each clue costs 10 credits (roughly $0.10 worth)
            const clueCost = 10;

            if (user.credits < clueCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: clueCost
                });
            }

            // Deduct credits
            await supabase
                .from('users')
                .update({ credits: user.credits - clueCost })
                .eq('id', userId);
        }
    }

    // Build location context
    let locationContext = '';
    if (city && region) {
        locationContext = `The players are currently near ${city}, ${region}.`;
    } else if (latitude && longitude) {
        locationContext = `The players are at coordinates ${latitude}, ${longitude}.`;
    }

    const prompt = `You are the game master for an educational "I Spy" road trip game. Generate a clue for players.

Category: ${category}
Letter: ${letter}
${locationContext}

Your task:
1. Think of a famous person, place, event, or concept from the "${category}" category that starts with the letter "${letter}"
2. If possible, choose something connected to the players' current location
3. Generate 4 progressive hints (easy to hard)
4. Write a brief educational essay (about 100 words)

Respond in this exact JSON format:
{
    "answer": "The full answer",
    "hints": [
        "First hint (hardest/most vague)",
        "Second hint (medium)",
        "Third hint (easier)",
        "Fourth hint (easiest/most specific)"
    ],
    "essay": "A 100-word educational essay about this answer",
    "locationRelevance": "Brief note about why this is relevant to the location, or null if not location-specific"
}

Only respond with valid JSON, no other text.`;

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
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Claude API error:', errorData);
            return res.status(response.status).json({ error: 'Claude API error' });
        }

        const data = await response.json();
        const content = data.content[0].text;

        // Parse the JSON response from Claude
        const clueData = JSON.parse(content);

        // Get updated credit balance
        let remainingCredits = null;
        if (userId) {
            const { data: updatedUser } = await supabase
                .from('users')
                .select('credits, is_subscriber')
                .eq('id', userId)
                .single();

            remainingCredits = updatedUser?.is_subscriber ? 'unlimited' : updatedUser?.credits;
        }

        return res.status(200).json({
            ...clueData,
            remainingCredits
        });
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Failed to generate clue' });
    }
}
