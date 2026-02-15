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
            ],
            essay: 'Martin Luther King Jr. (1929-1968) was the most influential leader of the American civil rights movement. A Baptist minister from Atlanta, he championed nonviolent resistance inspired by Mahatma Gandhi. His "I Have a Dream" speech, delivered to 250,000 people at the 1963 March on Washington, remains one of history\'s most powerful orations. King led the Montgomery Bus Boycott, helped pass the Civil Rights Act of 1964, and won the Nobel Peace Prize at age 35. He was assassinated in Memphis in 1968, but his legacy of peaceful protest and racial equality continues to inspire movements worldwide.'
        },
        'R': {
            answer: 'Rosa Parks',
            hints: [
                'This person refused to give up their seat on a bus.',
                'This happened in Montgomery, Alabama in 1955.',
                'She is known as the "Mother of the Civil Rights Movement".',
                'Her act of defiance sparked a 381-day bus boycott.'
            ],
            essay: 'Rosa Parks (1913-2005) became an icon of resistance when she refused to give up her bus seat to a white passenger in Montgomery, Alabama on December 1, 1955. Her arrest sparked the Montgomery Bus Boycott, a 381-day protest that brought national attention to segregation and launched Martin Luther King Jr. to prominence. Parks was not simply tired that day—she was a trained activist and NAACP secretary who had long fought against injustice. Congress later called her "the first lady of civil rights" and "the mother of the freedom movement."'
        },
        'J': {
            answer: 'John Lewis',
            hints: [
                'This person was one of the Big Six civil rights leaders.',
                'He led the march across the Edmund Pettus Bridge.',
                'He later served in the U.S. Congress for over 30 years.',
                'He encouraged people to get into "good trouble".'
            ],
            essay: 'John Lewis (1940-2020) was a towering figure in American civil rights history. At 23, he was the youngest speaker at the March on Washington. On "Bloody Sunday" in 1965, Lewis led 600 marchers across the Edmund Pettus Bridge in Selma, Alabama, where state troopers fractured his skull. The brutal images shocked the nation and helped pass the Voting Rights Act. Lewis served 17 terms in Congress, becoming known as the "conscience of Congress." His famous call to get into "good trouble, necessary trouble" continues to inspire activists.'
        },
        'H': {
            answer: 'Harriet Tubman',
            hints: [
                'This person escaped slavery and helped others do the same.',
                'She was a conductor on the Underground Railroad.',
                'She made 13 missions to rescue around 70 enslaved people.',
                'She later served as a spy for the Union Army.'
            ],
            essay: 'Harriet Tubman (c.1822-1913) escaped slavery in 1849 and became the most famous "conductor" on the Underground Railroad, a secret network helping enslaved people reach freedom. Over 13 missions, she rescued approximately 70 people, including her elderly parents, never losing a single passenger. During the Civil War, she served as a spy, scout, and nurse for the Union Army, becoming the first woman to lead an armed assault when she guided the Combahee River Raid, liberating more than 700 enslaved people. She later championed women\'s suffrage until her death at 91.'
        },
        'F': {
            answer: 'Frederick Douglass',
            hints: [
                'This person was an escaped slave who became a famous speaker.',
                'He wrote an influential autobiography about his life.',
                'He advised President Lincoln during the Civil War.',
                'He published a newspaper called "The North Star".'
            ],
            essay: 'Frederick Douglass (1818-1895) escaped slavery at 20 and became the most influential African American of the 19th century. His autobiography, "Narrative of the Life of Frederick Douglass," exposed slavery\'s horrors to the world. A gifted orator, his speeches drew thousands and changed minds. He founded "The North Star" newspaper and advised President Lincoln on emancipation and Black soldiers\' rights. Douglass held several government positions, including U.S. Marshal. His famous words—"If there is no struggle, there is no progress"—still resonate in movements for justice today.'
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
            ],
            essay: 'Elvis Presley (1935-1977), the "King of Rock and Roll," transformed American music by blending blues, gospel, and country into an electrifying new sound. Born in poverty in Tupelo, Mississippi, he became the best-selling solo artist in history. His 1956 appearances on TV scandalized parents with his hip-shaking performances while making teenagers swoon. Hits like "Heartbreak Hotel," "Hound Dog," and "Jailhouse Rock" defined an era. His Memphis mansion, Graceland, became a pilgrimage site after his death. Elvis remains a cultural icon whose influence on music, fashion, and performance endures.'
        },
        'M': {
            answer: 'Michael Jackson',
            hints: [
                'This person is known as the "King of Pop".',
                'He popularized the moonwalk dance move.',
                'His album "Thriller" is one of the best-selling of all time.',
                'He started his career with his brothers in a famous group.'
            ],
            essay: 'Michael Jackson (1958-2009), the "King of Pop," was perhaps the most influential entertainer of the 20th century. Starting at age 5 with the Jackson 5, he launched a solo career that shattered records. His 1982 album "Thriller" remains the best-selling album ever, with over 70 million copies sold. Jackson revolutionized music videos as art forms—"Thriller," "Beat It," and "Billie Jean" were groundbreaking short films. His moonwalk dance became iconic worldwide. Despite controversy later in life, his musical genius, from vocal techniques to choreography, permanently shaped pop music and performance.'
        },
        'B': {
            answer: 'Beyonce',
            hints: [
                'This artist started in a group called Destiny\'s Child.',
                'She performed at multiple Super Bowl halftime shows.',
                'She is married to a famous rapper.',
                'Her visual album "Lemonade" was a cultural phenomenon.'
            ],
            essay: 'Beyoncé Knowles-Carter (born 1981) rose from Destiny\'s Child to become one of the most influential artists of her generation. Her solo career produced hits like "Crazy in Love," "Single Ladies," and "Halo." She transformed the industry with surprise album drops and visual albums like "Lemonade," which explored Black womanhood, infidelity, and resilience. Her 2018 Coachella performance, celebrating Black culture and HBCUs, became a Netflix documentary. With 32 Grammy wins—the most ever—she uses her platform to address social issues while maintaining artistic excellence that spans R&B, pop, hip-hop, and country.'
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
            ],
            essay: 'Marilyn Monroe (1926-1962) transcended her troubled childhood to become Hollywood\'s most iconic star. Born Norma Jeane Mortenson, she spent years in foster care before transforming into the platinum blonde bombshell who defined 1950s glamour. Films like "Some Like It Hot," "Gentlemen Prefer Blondes," and "The Seven Year Itch" showcased both her comedic talent and screen presence. Her breathy rendition of "Happy Birthday" to President Kennedy became legendary. Despite her comedic image, she struggled for serious recognition and battled personal demons. Her mysterious death at 36 cemented her status as an eternal symbol of beauty and tragedy.'
        },
        'S': {
            answer: 'Steven Spielberg',
            hints: [
                'This person directed Jaws and E.T.',
                'He created the Indiana Jones franchise.',
                'He directed Schindler\'s List and Saving Private Ryan.',
                'He co-founded DreamWorks studio.'
            ],
            essay: 'Steven Spielberg (born 1946) is arguably cinema\'s most influential director. His 1975 thriller "Jaws" invented the summer blockbuster, while "E.T." and "Indiana Jones" defined 1980s entertainment. Yet Spielberg proved equally masterful with serious fare: "Schindler\'s List" and "Saving Private Ryan" won him Best Director Oscars. His films have grossed over $10 billion worldwide. Beyond directing, he co-founded DreamWorks Studios and produced countless hits. From dinosaurs in "Jurassic Park" to World War II in "Band of Brothers," Spielberg\'s ability to balance spectacle with emotional depth has made him cinema\'s most commercially successful storyteller.'
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
            ],
            essay: 'George Washington (1732-1799), the "Father of His Country," shaped America more than any other founder. As commander of the Continental Army, he held together an outmatched fighting force through brutal winters and defeats to ultimately defeat the British Empire. As the first President, he established precedents—like the two-term limit and peaceful transfer of power—that defined American democracy. Remarkably, he voluntarily relinquished power twice, first as general, then as president, when he could have remained indefinitely. His leadership, integrity, and restraint set the template for American leadership that endures today.'
        },
        'A': {
            answer: 'Abraham Lincoln',
            hints: [
                'This president issued the Emancipation Proclamation.',
                'He led the country during the Civil War.',
                'He was known for his tall stature and top hat.',
                'He gave the famous Gettysburg Address.'
            ],
            essay: 'Abraham Lincoln (1809-1865) rose from a Kentucky log cabin to become America\'s greatest president. Self-educated, he became a lawyer and congressman before winning the 1860 election, which triggered Southern secession. Leading the nation through the Civil War, he preserved the Union while transforming it. His Emancipation Proclamation freed enslaved people in Confederate states, and he championed the 13th Amendment abolishing slavery entirely. His Gettysburg Address redefined America\'s purpose: "government of the people, by the people, for the people." Assassinated just days after the war ended, Lincoln became a martyr for unity and freedom.'
        },
        'B': {
            answer: 'Benjamin Franklin',
            hints: [
                'This person flew a kite in a thunderstorm.',
                'He was a Founding Father and inventor.',
                'He established the first public library in America.',
                'His face appears on the hundred-dollar bill.'
            ],
            essay: 'Benjamin Franklin (1706-1790) was America\'s first celebrity and most versatile founder. A printer who became wealthy publishing "Poor Richard\'s Almanack," he then devoted himself to science and public service. His kite experiment proved lightning was electrical, leading to the lightning rod. He invented bifocals, the Franklin stove, and started America\'s first lending library, fire department, and hospital. As a diplomat, he secured crucial French support during the Revolution. The only founder to sign all four founding documents, Franklin embodied Enlightenment ideals: curiosity, pragmatism, wit, and the belief that knowledge should benefit humanity.'
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
            ],
            essay: 'Albert Einstein (1879-1955) revolutionized physics and became synonymous with genius. His 1905 "miracle year" produced four groundbreaking papers, including special relativity and E=mc², showing that mass and energy are interchangeable. His general theory of relativity reimagined gravity as curves in spacetime, predictions confirmed during a 1919 eclipse that made him world-famous. Fleeing Nazi Germany, he settled at Princeton and urged FDR to develop atomic weapons, a decision he later regretted. Beyond physics, Einstein championed civil rights and pacifism. His wild hair and thought experiments made him science\'s most recognizable face.'
        },
        'M': {
            answer: 'Marie Curie',
            hints: [
                'This scientist discovered two elements: polonium and radium.',
                'She was the first woman to win a Nobel Prize.',
                'She won Nobel Prizes in both Physics and Chemistry.',
                'She pioneered research on radioactivity.'
            ],
            essay: 'Marie Curie (1867-1934) broke barriers in science like no one before. Born in Poland, she moved to Paris, where she and husband Pierre discovered polonium and radium, coining the term "radioactivity." She became the first woman to win a Nobel Prize (Physics, 1903), first person to win two Nobels (adding Chemistry, 1911), and first female professor at the Sorbonne. During World War I, she developed mobile X-ray units that saved countless soldiers. Her pioneering work, conducted before radiation\'s dangers were known, ultimately caused her death from aplastic anemia. Her notebooks remain radioactive today.'
        },
        'N': {
            answer: 'Neil Armstrong',
            hints: [
                'This person was the first human to walk on the Moon.',
                'He said "one small step for man, one giant leap for mankind."',
                'He was the commander of Apollo 11.',
                'Before NASA, he was a Navy pilot.'
            ],
            essay: 'Neil Armstrong (1930-2012) took humanity\'s first steps on another world. A Navy pilot who flew 78 combat missions in Korea, he became a test pilot and then astronaut. On July 20, 1969, as commander of Apollo 11, he piloted the lunar module to the Moon\'s surface with just 25 seconds of fuel remaining. His words upon stepping onto the Moon—"That\'s one small step for man, one giant leap for mankind"—became immortal. Unlike many astronauts, Armstrong shunned celebrity, returning to teach engineering and living quietly. His achievement remains humanity\'s greatest exploration milestone.'
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
const answerActions = document.getElementById('answer-actions');
const learnMoreContainer = document.getElementById('learn-more-container');
const learnMoreText = document.getElementById('learn-more-text');

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

    // Learn more listeners
    document.getElementById('learn-more-btn').addEventListener('click', showLearnMore);
    document.getElementById('skip-btn').addEventListener('click', proceedToNextRound);
    document.getElementById('continue-btn').addEventListener('click', proceedToNextRound);

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

    // Show answer actions (learn more / skip)
    showAnswerActions();
}

function submitGuess() {
    const guess = guessInput.value.trim().toLowerCase();
    const answer = gameState.currentClue.answer.toLowerCase();

    if (!guess) return;

    if (guess === answer) {
        // Correct!
        gameState.score++;
        resultMessage.textContent = `Correct! The answer was ${gameState.currentClue.answer}`;
        resultMessage.className = 'result-message correct';
        speak(`Correct! The answer was ${gameState.currentClue.answer}`);

        // Show answer actions (learn more / skip)
        showAnswerActions();
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

function showAnswerActions() {
    // Hide guess input, show answer actions
    document.querySelector('.guess-container').classList.add('hidden');
    document.querySelector('.hint-container').classList.add('hidden');
    answerActions.classList.remove('hidden');
}

function showLearnMore() {
    learnMoreText.textContent = gameState.currentClue.essay;

    // Set up Claude link with context about the current answer
    const answer = gameState.currentClue.answer;
    const category = getCategoryDisplayName(gameState.category);
    const prompt = encodeURIComponent(`Tell me more about ${answer} and their significance in ${category} history.`);
    document.getElementById('hungry-for-more-btn').href = `https://claude.ai/new?q=${prompt}`;

    answerActions.classList.add('hidden');
    learnMoreContainer.classList.remove('hidden');
}

function proceedToNextRound() {
    // Hide learn more elements
    answerActions.classList.add('hidden');
    learnMoreContainer.classList.add('hidden');

    // Show guess input again
    document.querySelector('.guess-container').classList.remove('hidden');
    document.querySelector('.hint-container').classList.remove('hidden');

    // Pick a letter from the answer for the next round
    const nextLetter = pickLetterFromAnswer(gameState.currentClue.answer);
    startNewRound(nextLetter);
}

function endGame() {
    speechSynthesis.cancel();
    // Reset UI state
    answerActions.classList.add('hidden');
    learnMoreContainer.classList.add('hidden');
    document.querySelector('.guess-container').classList.remove('hidden');
    document.querySelector('.hint-container').classList.remove('hidden');
    gameScreen.classList.remove('active');
    setupScreen.classList.add('active');
}
