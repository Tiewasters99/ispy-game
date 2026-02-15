// Stripe Checkout Session Creator
// Creates a checkout session for credit purchases

import Stripe from 'stripe';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { amount, userId, type } = req.body;

    // type: 'starter' ($10), 'credits' (custom amount), 'subscription' ($9.99/month)

    if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
    }

    try {
        let sessionConfig = {
            payment_method_types: ['card'],
            client_reference_id: userId,
            success_url: `https://ispy-game-six.vercel.app/?payment=success`,
            cancel_url: `https://ispy-game-six.vercel.app/?payment=cancelled`,
            metadata: {
                userId: userId,
                type: type
            }
        };

        if (type === 'subscription') {
            // Monthly subscription at $9.99
            sessionConfig.mode = 'subscription';
            sessionConfig.line_items = [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'I Spy Road Trip - Unlimited',
                        description: 'Unlimited clues every month'
                    },
                    unit_amount: 999, // $9.99 in cents
                    recurring: {
                        interval: 'month'
                    }
                },
                quantity: 1
            }];
        } else {
            // One-time credit purchase
            const creditAmount = type === 'starter' ? 1000 : (amount * 100); // cents
            const credits = type === 'starter' ? 1000 : (amount * 100); // 1 cent = 1 credit

            sessionConfig.mode = 'payment';
            sessionConfig.line_items = [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: type === 'starter' ? 'I Spy Starter Pack' : `${credits} Credits`,
                        description: type === 'starter'
                            ? '1000 credits to get started'
                            : `${credits} credits for gameplay`
                    },
                    unit_amount: creditAmount
                },
                quantity: 1
            }];
            sessionConfig.metadata.credits = credits.toString();
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        return res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Stripe error:', error);
        return res.status(500).json({ error: 'Failed to create checkout session', details: error.message });
    }
}
