const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      "https://briscola-client.vercel.app", // Your Vercel URL
      "http://localhost:3000" // For local testing
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

const gameRooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (gameRooms.has(code)) {
    return generateRoomCode();
  }
  return code;
}

function createDeck() {
  const suits = ['coppe', 'denari', 'spade', 'bastoni'];
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  
  let deck = [];
  for (let suit of suits) {
    for (let value of values) {
      deck.push({ suit, value });
    }
  }
  
  return deck;
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('createRoom', () => {
    const roomCode = generateRoomCode();
    
    gameRooms.set(roomCode, {
      player1: socket.id,
      player2: null,
      gameState: null,
      phase: 'waiting', // waiting, rolling_dice, shuffling, cutting, playing, trick_complete, drawing, counting, game_over
      player1Name: 'Player 1',
      player2Name: 'Player 2'
    });
    
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, playerNumber: 1 });
    console.log(`Room created: ${roomCode}`);
  });

  socket.on('joinRoom', (roomCode) => {
    const room = gameRooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    
    if (room.player2) {
      socket.emit('error', 'Room is full');
      return;
    }
    
    room.player2 = socket.id;
    socket.join(roomCode);
    
    socket.emit('roomJoined', { roomCode, playerNumber: 2 });
    
    // Start dice roll animation
    room.phase = 'rolling_dice';
    io.to(roomCode).emit('startDiceRoll');
    
    // Roll dice after 2 seconds
    setTimeout(() => {
      const dice1 = Math.floor(Math.random() * 6) + 1;
      const dice2 = Math.floor(Math.random() * 6) + 1;
      
      // Higher roll becomes player 1 (dealer)
      let dealer, nonDealer;
      if (dice1 >= dice2) {
        dealer = 1;
        nonDealer = 2;
      } else {
        dealer = 2;
        nonDealer = 1;
        // Swap players
        [room.player1, room.player2] = [room.player2, room.player1];
      }
      
      io.to(roomCode).emit('diceRolled', { 
        dice1, 
        dice2, 
        dealer,
        message: `Player ${dealer} rolled ${dealer === 1 ? dice1 : dice2}, Player ${nonDealer} rolled ${nonDealer === 1 ? dice1 : dice2}. Player ${dealer} deals!`
      });
      
      // Start shuffle after 3 seconds
      setTimeout(() => {
        room.phase = 'shuffling';
        const deck = createDeck();
        io.to(roomCode).emit('startShuffle', { deck });
        
        // After shuffle animation (3 seconds), let player 2 cut
        setTimeout(() => {
          const shuffledDeck = shuffleDeck(deck);
          room.shuffledDeck = shuffledDeck;
          room.phase = 'cutting';
          io.to(room.player2).emit('yourTurnToCut');
          io.to(room.player1).emit('opponentCutting');
        }, 3000);
      }, 3000);
    }, 2000);
    
    console.log(`Player joined room: ${roomCode}`);
  });

  socket.on('cutDeck', ({ roomCode, cutPosition }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.phase !== 'cutting') return;
    
    // Cut the deck at the specified position
    const deck = room.shuffledDeck;
    const cutIndex = Math.floor((cutPosition / 100) * deck.length);
    const cutDeck = [...deck.slice(cutIndex), ...deck.slice(0, cutIndex)];
    
    // Deal cards and set up game
    const player1Hand = cutDeck.splice(0, 3);
    const player2Hand = cutDeck.splice(0, 3);
    const trumpCard = cutDeck[cutDeck.length - 1];
    
    room.gameState = {
      deck: cutDeck,
      trumpCard,
      player1Hand,
      player2Hand,
      player1Pile: [],
      player2Pile: [],
      player1Score: 0,
      player2Score: 0,
      currentTrick: [],
      currentPlayer: 2, // Non-dealer starts
      lastTrickWinner: null,
      gameOver: false
    };
    
    room.phase = 'playing';
    
    // Notify about cut and start game
    io.to(roomCode).emit('deckCut', { cutPosition });
    
    // Deal animation
    setTimeout(() => {
      io.to(roomCode).emit('startDealing');
      
      // After dealing animation, start game
      setTimeout(() => {
        io.to(roomCode).emit('gameStart');
        sendGameStateToPlayers(roomCode);
      }, 2000);
    }, 1000);
  });

  socket.on('playCard', ({ roomCode, card }) => {
    const room = gameRooms.get(roomCode);
    if (!room || !room.gameState) return;
    
    const playerNumber = room.player1 === socket.id ? 1 : 2;
    const gameState = room.gameState;
    
    if (gameState.currentPlayer !== playerNumber) {
      socket.emit('error', 'Not your turn');
      return;
    }
    
    gameState.currentTrick.push({ card, player: playerNumber });
    
    const hand = playerNumber === 1 ? gameState.player1Hand : gameState.player2Hand;
    const cardIndex = hand.findIndex(c => c.suit === card.suit && c.value === card.value);
    if (cardIndex !== -1) {
      hand.splice(cardIndex, 1);
    }
    
    if (gameState.currentTrick.length === 2) {
      room.phase = 'trick_complete';
      
      const winner = determineTrickWinner(gameState.currentTrick, gameState.trumpCard.suit);
      const points = calculateTrickPoints(gameState.currentTrick);
      
      // Add cards to winner's pile (in order played)
      const pile = winner === 1 ? gameState.player1Pile : gameState.player2Pile;
      pile.push(gameState.currentTrick[0].card);
      pile.push(gameState.currentTrick[1].card);
      
      if (winner === 1) {
        gameState.player1Score += points;
      } else {
        gameState.player2Score += points;
      }
      
      gameState.lastTrickWinner = winner;
      
      sendTrickComplete(roomCode, winner, points);
      
      setTimeout(() => {
        room.phase = 'drawing';
        
        if (gameState.deck.length > 0) {
          drawCards(roomCode, winner);
        } else {
          finishTrick(roomCode, winner);
        }
      }, 2500);
      
    } else {
      gameState.currentPlayer = playerNumber === 1 ? 2 : 1;
      sendGameStateToPlayers(roomCode);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    for (let [roomCode, room] of gameRooms.entries()) {
      if (room.player1 === socket.id || room.player2 === socket.id) {
        io.to(roomCode).emit('playerDisconnected');
        gameRooms.delete(roomCode);
      }
    }
  });
});

function drawCards(roomCode, winner) {
  const room = gameRooms.get(roomCode);
  if (!room) return;
  
  const gameState = room.gameState;
  
  // Winner draws first
  const winnerCard = gameState.deck.shift();
  const winnerSocketId = winner === 1 ? room.player1 : room.player2;
  const loserSocketId = winner === 1 ? room.player2 : room.player1;
  
  if (winner === 1) {
    gameState.player1Hand.push(winnerCard);
  } else {
    gameState.player2Hand.push(winnerCard);
  }
  
  // Animate winner drawing
  io.to(winnerSocketId).emit('drawCard', { card: winnerCard, fromDeck: true });
  io.to(loserSocketId).emit('opponentDrawCard');
  
  sendGameStateToPlayers(roomCode);
  
  // Loser draws after delay
  setTimeout(() => {
    if (gameState.deck.length > 0) {
      const loserCard = gameState.deck.shift();
      
      if (winner === 1) {
        gameState.player2Hand.push(loserCard);
        io.to(room.player2).emit('drawCard', { card: loserCard, fromDeck: true });
        io.to(room.player1).emit('opponentDrawCard');
      } else {
        gameState.player1Hand.push(loserCard);
        io.to(room.player1).emit('drawCard', { card: loserCard, fromDeck: true });
        io.to(room.player2).emit('opponentDrawCard');
      }
      
      sendGameStateToPlayers(roomCode);
    }
    
    finishTrick(roomCode, winner);
  }, 800);
}

function finishTrick(roomCode, winner) {
  const room = gameRooms.get(roomCode);
  if (!room) return;
  
  const gameState = room.gameState;
  
  gameState.currentTrick = [];
  room.phase = 'playing';
  gameState.currentPlayer = winner;
  
  // Check if game is over
  if (gameState.player1Hand.length === 0 && gameState.player2Hand.length === 0) {
    gameState.gameOver = true;
    room.phase = 'counting';
    
    // Start counting animation
    io.to(roomCode).emit('startCounting', {
      player1Pile: gameState.player1Pile,
      player2Pile: gameState.player2Pile
    });
    
    return;
  }
  
  sendGameStateToPlayers(roomCode);
}

function sendTrickComplete(roomCode, winner, points) {
  const room = gameRooms.get(roomCode);
  if (!room) return;
  
  io.to(roomCode).emit('trickComplete', {
    winner,
    points
  });
  
  sendGameStateToPlayers(roomCode);
}

function sendGameStateToPlayers(roomCode) {
  const room = gameRooms.get(roomCode);
  if (!room || !room.gameState) return;
  
  const { gameState, player1, player2 } = room;
  
  const baseState = {
    trumpCard: gameState.trumpCard,
    deckSize: gameState.deck.length,
    currentTrick: gameState.currentTrick,
    gameOver: gameState.gameOver,
    phase: room.phase,
    lastTrickWinner: gameState.lastTrickWinner
  };
  
  io.to(player1).emit('gameState', {
    ...baseState,
    myHand: gameState.player1Hand,
    opponentHandSize: gameState.player2Hand.length,
    isMyTurn: gameState.currentPlayer === 1,
    playerNumber: 1
  });
  
  if (player2) {
    io.to(player2).emit('gameState', {
      ...baseState,
      myHand: gameState.player2Hand,
      opponentHandSize: gameState.player1Hand.length,
      isMyTurn: gameState.currentPlayer === 2,
      playerNumber: 2
    });
  }
}

function determineTrickWinner(trick, trumpSuit) {
  const [first, second] = trick;
  
  if (second.card.suit === trumpSuit && first.card.suit !== trumpSuit) {
    return second.player;
  }
  
  if (first.card.suit === trumpSuit && second.card.suit !== trumpSuit) {
    return first.player;
  }
  
  if (first.card.suit === second.card.suit) {
    return getCardStrength(first.card) > getCardStrength(second.card) ? first.player : second.player;
  }
  
  return first.player;
}

function getCardStrength(card) {
  const strengths = {
    1: 11, 3: 10, 10: 4, 9: 3, 8: 2,
    7: 0, 6: 0, 5: 0, 4: 0, 2: 0
  };
  return strengths[card.value] || 0;
}

function calculateTrickPoints(trick) {
  const pointValues = {
    1: 11, 3: 10, 10: 4, 9: 3, 8: 2,
    7: 0, 6: 0, 5: 0, 4: 0, 2: 0
  };
  
  return trick.reduce((sum, { card }) => sum + (pointValues[card.value] || 0), 0);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});