// Stripe Webhook Handler
// Processes successful payments and adds credits to user accounts

import { createClient } from '@supabase/supabase-js';

export const config = {
    api: {
        bodyParser: false // Required for Stripe webhook verification
    }
};

async function buffer(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    const buf = await buffer(req);
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            buf,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const userId = session.metadata.userId;
            const type = session.metadata.type;

            if (type === 'subscription') {
                // Mark user as subscriber
                await supabase
                    .from('users')
                    .update({
                        is_subscriber: true,
                        subscription_id: session.subscription
                    })
                    .eq('id', userId);
            } else {
                // Add credits
                const credits = parseInt(session.metadata.credits) || 1000;
                const amountPaid = session.amount_total / 100; // Convert cents to dollars

                // Get current user data
                const { data: user } = await supabase
                    .from('users')
                    .select('credits, total_spent')
                    .eq('id', userId)
                    .single();

                const newCredits = (user?.credits || 0) + credits;
                const newTotalSpent = (user?.total_spent || 0) + amountPaid;

                // Update user credits and total spent
                await supabase
                    .from('users')
                    .update({
                        credits: newCredits,
                        total_spent: newTotalSpent
                    })
                    .eq('id', userId);
            }
            break;
        }

        case 'customer.subscription.deleted': {
            // Handle subscription cancellation
            const subscription = event.data.object;
            await supabase
                .from('users')
                .update({ is_subscriber: false, subscription_id: null })
                .eq('subscription_id', subscription.id);
            break;
        }
    }

    return res.status(200).json({ received: true });
}
