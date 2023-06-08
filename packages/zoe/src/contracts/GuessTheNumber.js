import { Far } from '@agoric/marshal';

// Define a start function that sets up the game
const start = _ => {
  // Define the correct number
  const correctNumber = Math.floor(Math.random() * 100) + 1;

  // Create the game logic object
  const gameLogic = Far('gameLogic', {
    // Define the guessTheNumber function
    guessTheNumber: (guess) => {
      // If the guess is correct
      if (guess === correctNumber) {
        return 'Congratulations, your guess is correct!';
      // If the guess is too low
      } else if (guess < correctNumber) {
        return 'Too low! Try again.';
      // If the guess is too high
      } else {
        return 'Too high! Try again.';
      }
    }
  });

  // Return the hardened game logic object
  return harden({ gameLogic });
};

// Harden and export the start function
harden(start);
export { start };
