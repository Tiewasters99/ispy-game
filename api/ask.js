// Vercel Serverless Function — Follow-up Q&A with Claude
// Allows conversational questions about the current answer/topic

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { question, answer, category, city, region, userId } = req.body;

    if (!question || !answer) {
        return res.status(400).json({ error: 'Missing question or answer' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
    }

    // Initialize Supabase for credit management
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Check/deduct credits (5 per question)
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
            const askCost = 5;
            if (user.credits < askCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: askCost
                });
            }

            await supabase
                .from('users')
                .update({ credits: user.credits - askCost })
                .eq('id', userId);
        }
    }

    const locationContext = city && region ? `The user is near ${city}, ${region}.` : '';

    const prompt = `You are Professor Jones, an engaging and knowledgeable educator. You are having a spoken conversation with someone who just learned about "${answer}" in the context of ${category || 'general knowledge'}.

${locationContext}

They asked: "${question}"

Respond conversationally as Professor Jones would — warm, informative, and enthusiastic. Keep your answer to 2-3 sentences (this will be read aloud). Connect to the local area if relevant. End by asking if they have another question or are ready for the next round.

Respond with ONLY your spoken answer, no JSON, no formatting.`;

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
                max_tokens: 300,
                messages: [
                    { role: 'user', content: prompt }
                ]
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Claude API error:', errorData);
            return res.status(502).json({ error: 'Claude API error' });
        }

        const data = await response.json();
        const responseText = data.content[0].text;

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
            response: responseText,
            remainingCredits
        });
    } catch (error) {
        console.error('Ask error:', error);
        return res.status(500).json({ error: 'Failed to get answer' });
    }
}
