// I Spy Road Trip - Phase 1: Basic Game Loop

// Hardcoded clues for Phase 1 (will be replaced with Claude API later)
const clueDatabase = {
    'civil-rights': {
        'M': {
            answer: 'Martin Luther King Jr',
            hints: [
                'This person gave a famous speech about a dream.',
                'He led the March on Washington in 1963.',
                'He won the Nobel Peace Prize in 1964.',
                'He was a Baptist minister from Atlanta.'
            ]
        },
        'R': {
            answer: 'Rosa Parks',
            hints: [
                'This person refused to give up their seat on a bus.',
                'This happened in Montgomery, Alabama in 1955.',
                'She is known as the "Mother of the Civil Rights Movement".',
                'Her act of defiance sparked a 381-day bus boycott.'
            ]
        },
        'J': {
            answer: 'John Lewis',
            hints: [
                'This person was one of the Big Six civil rights leaders.',
                'He led the march across the Edmund Pettus Bridge.',
                'He later served in the U.S. Congress for over 30 years.',
                'He encouraged people to get into "good trouble".'
            ]
        },
        'H': {
            answer: 'Harriet Tubman',
            hints: [
                'This person escaped slavery and helped others do the same.',
                'She was a conductor on the Underground Railroad.',
                'She made 13 missions to rescue around 70 enslaved people.',
                'She later served as a spy for the Union Army.'
            ]
        },
        'F': {
            answer: 'Frederick Douglass',
            hints: [
                'This person was an escaped slave who became a famous speaker.',
                'He wrote an influential autobiography about his life.',
                'He advised President Lincoln during the Civil War.',
                'He published a newspaper called "The North Star".'
            ]
        }
    },
    'music': {
        'E': {
            answer: 'Elvis Presley',
            hints: [
                'This person is known as the "King of Rock and Roll".',
                'He lived in a mansion called Graceland.',
                'His famous songs include "Hound Dog" and "Jailhouse Rock".',
                'He was born in Tupelo, Mississippi.'
            ]
        },
        'M': {
            answer: 'Michael Jackson',
            hints: [
                'This person is known as the "King of Pop".',
                'He popularized the moonwalk dance move.',
                'His album "Thriller" is one of the best-selling of all time.',
                'He started his career with his brothers in a famous group.'
            ]
        },
        'B': {
            answer: 'Beyonce',
            hints: [
                'This artist started in a group called Destiny\'s Child.',
                'She performed at multiple Super Bowl halftime shows.',
                'She is married to a famous rapper.',
                'Her visual album "Lemonade" was a cultural phenomenon.'
            ]
        }
    },
    'hollywood': {
        'M': {
            answer: 'Marilyn Monroe',
            hints: [
                'This actress was known for her platinum blonde hair.',
                'She starred in "Some Like It Hot" and "Gentlemen Prefer Blondes".',
                'She famously sang "Happy Birthday" to a president.',
                'She became an icon of the 1950s and 60s.'
            ]
        },
        'S': {
            answer: 'Steven Spielberg',
            hints: [
                'This person directed Jaws and E.T.',
                'He created the Indiana Jones franchise.',
                'He directed Schindler\'s List and Saving Private Ryan.',
                'He co-founded DreamWorks studio.'
            ]
        }
    },
    'history': {
        'G': {
            answer: 'George Washington',
            hints: [
                'This person was the first President of the United States.',
                'He led the Continental Army during the Revolutionary War.',
                'His face appears on the one-dollar bill.',
                'He is known as the "Father of His Country".'
            ]
        },
        'A': {
            answer: 'Abraham Lincoln',
            hints: [
                'This president issued the Emancipation Proclamation.',
                'He led the country during the Civil War.',
                'He was known for his tall stature and top hat.',
                'He gave the famous Gettysburg Address.'
            ]
        },
        'B': {
            answer: 'Benjamin Franklin',
            hints: [
                'This person flew a kite in a thunderstorm.',
                'He was a Founding Father and inventor.',
                'He established the first public library in America.',
                'His face appears on the hundred-dollar bill.'
            ]
        }
    },
    'science': {
        'A': {
            answer: 'Albert Einstein',
            hints: [
                'This scientist developed the theory of relativity.',
                'He won the Nobel Prize in Physics in 1921.',
                'His famous equation relates energy and mass.',
                'He fled Germany and became a U.S. citizen.'
            ]
        },
        'M': {
            answer: 'Marie Curie',
            hints: [
                'This scientist discovered two elements: polonium and radium.',
                'She was the first woman to win a Nobel Prize.',
                'She won Nobel Prizes in both Physics and Chemistry.',
                'She pioneered research on radioactivity.'
            ]
        },
        'N': {
            answer: 'Neil Armstrong',
            hints: [
                'This person was the first human to walk on the Moon.',
                'He said "one small step for man, one giant leap for mankind."',
                'He was the commander of Apollo 11.',
                'Before NASA, he was a Navy pilot.'
            ]
        }
    }
};

// Game State
let gameState = {
    playerCount: 5,
    category: null,
    currentLetter: null,
    currentClue: null,
    hintIndex: 0,
    score: 0
};

// DOM Elements
const setupScreen = document.getElementById('setup-screen');
const gameScreen = document.getElementById('game-screen');
const categoryDisplay = document.getElementById('category-display');
const currentLetterEl = document.getElementById('current-letter');
const currentHintEl = document.getElementById('current-hint');
const guessInput = document.getElementById('guess-input');
const resultMessage = document.getElementById('result-message');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Category button listeners
    document.querySelectorAll('.category-btn').forEach(btn => {
        btn.addEventListener('click', () => startGame(btn.dataset.category));
    });

    // Player count listener
    document.getElementById('player-count').addEventListener('change', (e) => {
        gameState.playerCount = parseInt(e.target.value);
    });

    // Submit guess listener
    document.getElementById('submit-guess-btn').addEventListener('click', submitGuess);
    guessInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitGuess();
    });

    // Next hint listener
    document.getElementById('next-hint-btn').addEventListener('click', showNextHint);

    // Give up listener
    document.getElementById('give-up-btn').addEventListener('click', giveUp);

    // End game listener
    document.getElementById('end-game-btn').addEventListener('click', endGame);
});

function startGame(category) {
    gameState.category = category;
    gameState.score = 0;

    // Update UI
    setupScreen.classList.remove('active');
    gameScreen.classList.add('active');
    categoryDisplay.textContent = getCategoryDisplayName(category);

    // Start first round
    startNewRound();
}

function getCategoryDisplayName(category) {
    const names = {
        'civil-rights': 'Civil Rights',
        'music': 'Music Industry',
        'hollywood': 'Hollywood',
        'history': 'American History',
        'science': 'Science'
    };
    return names[category] || category;
}

function startNewRound(forceLetter = null) {
    const categoryClues = clueDatabase[gameState.category];
    const availableLetters = Object.keys(categoryClues);

    // Pick a letter (use forced letter or random)
    let letter;
    if (forceLetter && categoryClues[forceLetter.toUpperCase()]) {
        letter = forceLetter.toUpperCase();
    } else {
        letter = availableLetters[Math.floor(Math.random() * availableLetters.length)];
    }

    gameState.currentLetter = letter;
    gameState.currentClue = categoryClues[letter];
    gameState.hintIndex = 0;

    // Update UI
    currentLetterEl.textContent = letter;
    currentHintEl.textContent = gameState.currentClue.hints[0];
    guessInput.value = '';
    resultMessage.textContent = '';
    resultMessage.className = 'result-message';

    // Speak the clue (Phase 2 will enhance this)
    speak(`I spy with my little eye, something that begins with ${letter}`);
}

function showNextHint() {
    if (gameState.hintIndex < gameState.currentClue.hints.length - 1) {
        gameState.hintIndex++;
        currentHintEl.textContent = gameState.currentClue.hints[gameState.hintIndex];
        speak(gameState.currentClue.hints[gameState.hintIndex]);
    } else {
        currentHintEl.textContent = "No more hints! Make your best guess.";
    }
}

function giveUp() {
    const answer = gameState.currentClue.answer;
    resultMessage.textContent = `The answer was: ${answer}`;
    resultMessage.className = 'result-message';
    speak(`The answer was ${answer}`);

    // Pick a letter from the answer for the next round
    const nextLetter = pickLetterFromAnswer(answer);

    // Start next round after a delay
    setTimeout(() => {
        startNewRound(nextLetter);
    }, 3000);
}

function submitGuess() {
    const guess = guessInput.value.trim().toLowerCase();
    const answer = gameState.currentClue.answer.toLowerCase();

    if (!guess) return;

    // Check for exact match or close enough (e.g., "Martin Luther King" without "Jr")
    const guessWords = guess.split(/\s+/);
    const answerWords = answer.split(/\s+/);
    const matchingWords = guessWords.filter(word => answerWords.includes(word));
    const isCorrect = guess === answer || matchingWords.length >= Math.min(2, answerWords.length);

    if (isCorrect) {
        // Correct!
        gameState.score++;
        resultMessage.textContent = `Correct! The answer was ${gameState.currentClue.answer}`;
        resultMessage.className = 'result-message correct';
        speak(`Correct! The answer was ${gameState.currentClue.answer}`);

        // Pick a letter from the answer for the next round
        const nextLetter = pickLetterFromAnswer(gameState.currentClue.answer);

        // Start next round after a delay
        setTimeout(() => {
            startNewRound(nextLetter);
        }, 3000);
    } else {
        // Incorrect
        resultMessage.textContent = 'Not quite! Try again or ask for another hint.';
        resultMessage.className = 'result-message incorrect';
    }
}

function pickLetterFromAnswer(answer) {
    // Remove spaces and get unique letters
    const letters = answer.replace(/\s/g, '').toUpperCase().split('');
    const uniqueLetters = [...new Set(letters)];

    // Pick a random letter
    return uniqueLetters[Math.floor(Math.random() * uniqueLetters.length)];
}

function speak(text) {
    // Basic text-to-speech (Phase 2 will enhance this)
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1;
        speechSynthesis.speak(utterance);
    }
}

function endGame() {
    speechSynthesis.cancel();
    gameScreen.classList.remove('active');
    setupScreen.classList.add('active');
}
