/**
 * RockPaperScissors.js
 * 
 * Description:
 * This is a simple implementation of the classic game Rock, Paper, Scissors using Hardened JavaScript.
 * The game allows two players to compete. Each player chooses one of the three moves: Rock, Paper, or Scissors.
 * The winner is decided based on the traditional game rules:
 * - Rock crushes Scissors
 * - Scissors cuts Paper
 * - Paper covers Rock
 * In case both players choose the same move, the game ends in a tie.
 *
 * The implementation uses the `harden` function from the '@agoric/harden' library to make the game rules and
 * moves objects immutable, thus preventing unwanted modifications.
 */

import { harden } from '@agoric/harden';

// Possible moves
const moves = harden({
  ROCK: 'ROCK',
  PAPER: 'PAPER',
  SCISSORS: 'SCISSORS'
});

// Game rules
const rules = harden({
  [moves.ROCK]: moves.SCISSORS,
  [moves.PAPER]: moves.ROCK,
  [moves.SCISSORS]: moves.PAPER
});

// Game function
const playGame = (player1, player2) => {
  if (player1 === player2) {
    return "It's a tie!";
  }
  return rules[player1] === player2 ? 'Player 1 wins!' : 'Player 2 wins!';
};

// Harden the game function
const hardenedPlayGame = harden(playGame);

// Use the hardened function
console.log(hardenedPlayGame(moves.ROCK, moves.SCISSORS)); // prints "Player 1 wins!"

