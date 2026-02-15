// Supabase Auth Module
const SUPABASE_URL = 'https://bzkilokykxilglpzrexa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-mO8ktyjPlWJjjJGQcLbpw_AUf_iRZX';

// Simple Supabase client (without npm package)
const supabase = {
    auth: {
        async signUp(email, password) {
            const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY
                },
                body: JSON.stringify({ email, password })
            });
            return response.json();
        },

        async signIn(email, password) {
            const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY
                },
                body: JSON.stringify({ email, password })
            });
            const data = await response.json();
            if (data.access_token) {
                localStorage.setItem('supabase_token', data.access_token);
                localStorage.setItem('supabase_user', JSON.stringify(data.user));
            }
            return data;
        },

        async signOut() {
            localStorage.removeItem('supabase_token');
            localStorage.removeItem('supabase_user');
        },

        getUser() {
            const user = localStorage.getItem('supabase_user');
            return user ? JSON.parse(user) : null;
        },

        getToken() {
            return localStorage.getItem('supabase_token');
        }
    },

    async getUserCredits() {
        const token = this.auth.getToken();
        const user = this.auth.getUser();
        if (!token || !user) return null;

        const response = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}&select=credits,total_spent,is_subscriber`, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await response.json();
        return data[0] || null;
    }
};

// Auth state
let currentUser = supabase.auth.getUser();

// Auth UI handlers
function showAuthScreen() {
    document.getElementById('auth-screen').classList.add('active');
    document.getElementById('setup-screen').classList.remove('active');
    document.getElementById('game-screen').classList.remove('active');
}

function showSetupScreen() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('setup-screen').classList.add('active');
    document.getElementById('game-screen').classList.remove('active');
    updateCreditsDisplay();
}

async function handleSignUp(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');

    errorEl.textContent = '';

    const result = await supabase.auth.signUp(email, password);
    if (result.error) {
        errorEl.textContent = result.error.message || 'Sign up failed';
    } else {
        errorEl.textContent = 'Check your email to confirm, then sign in.';
        errorEl.style.color = '#2ecc71';
    }
}

async function handleSignIn(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');

    errorEl.textContent = '';

    const result = await supabase.auth.signIn(email, password);
    if (result.error) {
        errorEl.textContent = result.error.message || 'Sign in failed';
    } else {
        currentUser = supabase.auth.getUser();
        showSetupScreen();
    }
}

function handleSignOut() {
    supabase.auth.signOut();
    currentUser = null;
    showAuthScreen();
}

async function updateCreditsDisplay() {
    const userData = await supabase.getUserCredits();
    const creditsEl = document.getElementById('credits-display');

    if (creditsEl && userData) {
        if (userData.is_subscriber) {
            creditsEl.textContent = 'Unlimited';
        } else {
            creditsEl.textContent = `${userData.credits || 0} credits`;
        }

        // Check if approaching $29.99 threshold
        if (!userData.is_subscriber && userData.total_spent >= 25) {
            showSubscriptionOffer();
        }
    }
}

function showSubscriptionOffer() {
    const offerEl = document.getElementById('subscription-offer');
    if (offerEl) {
        offerEl.classList.remove('hidden');
    }
}

async function purchaseCredits(type, amount = 0) {
    const user = supabase.auth.getUser();
    console.log('Purchase attempt:', { type, amount, user });

    if (!user || !user.id) {
        alert('Please sign in first');
        return;
    }

    try {
        const response = await fetch('/api/create-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user.id,
                type: type,
                amount: amount
            })
        });

        const data = await response.json();
        console.log('Checkout response:', data);

        if (data.url) {
            window.location.href = data.url;
        } else {
            alert('Failed to create checkout: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Purchase error:', error);
        alert('Payment error: ' + error.message);
    }
}

// Make purchaseCredits available globally for onclick handlers
window.purchaseCredits = purchaseCredits;

// Initialize auth on page load
document.addEventListener('DOMContentLoaded', () => {
    // Check for payment success/cancel in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('payment') === 'success') {
        alert('Payment successful! Your credits have been added.');
        window.history.replaceState({}, '', '/');
    }

    // Wire up auth form handlers
    const authForm = document.getElementById('auth-form');
    if (authForm) {
        authForm.addEventListener('submit', handleSignIn);
    }

    const signUpBtn = document.getElementById('sign-up-btn');
    if (signUpBtn) {
        signUpBtn.addEventListener('click', handleSignUp);
    }

    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', handleSignOut);
    }

    // Check if user is logged in
    if (currentUser) {
        showSetupScreen();
    } else {
        showAuthScreen();
    }
});
