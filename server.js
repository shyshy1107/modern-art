const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ==================== 游戏常量 ====================
const ARTISTS = [
  { id: 'lite_metal', name: 'Lite Metal', color: '#FFD700', count: 12 },
  { id: 'yoko', name: 'Yoko', color: '#32CD32', count: 13 },
  { id: 'christin_p', name: 'Christin P', color: '#FF4500', count: 14 },
  { id: 'karl_gitter', name: 'Karl Gitter', color: '#1E90FF', count: 15 },
  { id: 'krypto', name: 'Krypto', color: '#8B4513', count: 16 }
];

const CARD_DISTRIBUTION = {
  'lite_metal': { open: 3, round: 2, sealed: 2, fixed: 3, double: 2 },
  'yoko': { open: 3, round: 3, sealed: 2, fixed: 3, double: 2 },
  'christin_p': { open: 4, round: 3, sealed: 2, fixed: 3, double: 2 },
  'karl_gitter': { open: 4, round: 3, sealed: 2, fixed: 3, double: 3 },
  'krypto': { open: 4, round: 4, sealed: 2, fixed: 3, double: 3 }
};

const INITIAL_MONEY = 100;
const DRAW_COUNTS = { 3: 11, 4: 8, 5: 8 };
const REFILL_COUNTS = { 3: 4, 4: 3, 5: 2 };
const TURN_TIMEOUT = 90000;  // 回合限时 90 秒

// 拍卖限时配置（毫秒）
const AUCTION_TIMEOUT = {
  open: 15000,   // 公开竞价：15秒（每次出价重置）
  round: 30000,  // 一圈价：30秒
  sealed: 30000, // 暗标：30秒
  fixed: 30000   // 一口价：30秒
};

// ==================== 房间管理 ====================
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createDeck() {
  const deck = [];
  ARTISTS.forEach(artist => {
    const dist = CARD_DISTRIBUTION[artist.id];
    Object.entries(dist).forEach(([type, count]) => {
      for (let i = 0; i < count; i++) {
        deck.push({
          id: `${artist.id}_${type}_${i}`,
          artistId: artist.id,
          artistName: artist.name,
          artistColor: artist.color,
          type: type
        });
      }
    });
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getNextPlayerIndex(current, total) {
  return (current + 1) % total;
}

function getPlayerLeftIndex(current, total) {
  return (current + 1) % total;
}

function checkRoundEnd(room) {
  for (const [artistId, count] of Object.entries(room.playedCounts)) {
    if (count >= 5) {
      console.log(`[SERVER DEBUG] 回合结束触发: ${artistId} 已达到 ${count} 张`);
      return true;
    }
  }
  return false;
}

function calculateArtistRanks(room) {
  const counts = Object.entries(room.playedCounts).map(([id, count]) => ({
    id,
    count,
    order: ARTISTS.findIndex(a => a.id === id)
  }));
  counts.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.order - b.order;
  });
  return counts;
}

function scoreRound(room) {
  const ranks = calculateArtistRanks(room);
  const values = {};
  [30, 20, 10].forEach((val, idx) => {
    if (ranks[idx]) {
      values[ranks[idx].id] = val;
    }
  });

  const roundIndex = room.currentRound - 1;
  ARTISTS.forEach(artist => {
    const val = values[artist.id] || 0;
    room.valueBoard[artist.id][roundIndex] = val;
  });

  // 累计值直接汇总 valueBoard（已在上面正确设置为 30/20/10/0））
  const cumulativeValues = {};
  ARTISTS.forEach(artist => {
    cumulativeValues[artist.id] = room.valueBoard[artist.id]
      .slice(0, room.currentRound)
      .reduce((sum, v) => sum + v, 0);
  });

  room.players.forEach(player => {
    player.collection.forEach(card => {
      const value = cumulativeValues[card.artistId];
      if (value > 0) {
        player.money += value;
      }
    });
    player.collection = [];
  });

  return { values, cumulativeValues };
}

function calculateArtistRanksForRound(room, roundNum) {
  const counts = {};
  ARTISTS.forEach(a => counts[a.id] = 0);

  if (room.roundHistory[roundNum - 1]) {
    room.roundHistory[roundNum - 1].forEach(card => {
      if (!card.isEndCard && !card.isDoublePair) {
        counts[card.artistId]++;
      }
    });
  }

  const sorted = Object.entries(counts).map(([id, count]) => ({
    id,
    count,
    order: ARTISTS.findIndex(a => a.id === id)
  }));
  sorted.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.order - b.order;
  });
  return sorted;
}

// ==================== Socket.IO ====================
io.on('connection', (socket) => {
  console.log('[SERVER DEBUG] User connected:', socket.id);

  // 创建房间
  socket.on('create_room', (playerName, customCode, callback) => {
    // 支持自定义房间号
    let roomCode;
    if (typeof customCode === 'function') {
      callback = customCode;
      customCode = null;
    }
    if (customCode && typeof customCode === 'string') {
      customCode = customCode.trim().toUpperCase().slice(0, 10);
      if (!/^[A-Z0-9]{2,10}$/.test(customCode)) {
        callback({ success: false, error: '房间号只能包含大写字母和数字，2-10位' });
        return;
      }
      if (rooms[customCode]) {
        callback({ success: false, error: '该房间号已被占用' });
        return;
      }
      roomCode = customCode;
    } else {
      roomCode = generateRoomCode();
    }
    rooms[roomCode] = {
      code: roomCode,
      host: socket.id,
      players: [{
        id: socket.id,
        name: playerName,
        money: INITIAL_MONEY,
        hand: [],
        collection: [],
        isConnected: true
      }],
      status: 'waiting',
      deck: [],
      currentRound: 0,
      currentPlayerIndex: 0,
      playedCounts: {},
      valueBoard: {},
      auctionState: null,
      roundHistory: [[], [], [], []],
      log: [],
      auctionTimeout: null,
      turnTimeout: null,
      spectators: [],
      chat: []
    };

    ARTISTS.forEach(artist => {
      rooms[roomCode].valueBoard[artist.id] = [0, 0, 0, 0];
      rooms[roomCode].playedCounts[artist.id] = 0;
    });

    socket.join(roomCode);
    socket.roomCode = roomCode;
    console.log(`[SERVER DEBUG] 房间 ${roomCode} 创建，玩家: ${playerName}`);
    callback({ success: true, roomCode });
    io.to(roomCode).emit('room_update', getPublicRoomState(rooms[roomCode]));
  });

  // 加入房间（支持断线重连和观战）
  socket.on('join_room', (roomCode, playerName, callback) => {
    const room = rooms[roomCode];
    if (!room) {
      callback({ success: false, error: '房间不存在' });
      return;
    }

    // 等待中：正常加入
    if (room.status === 'waiting') {
      if (room.players.length >= 5) {
        callback({ success: false, error: '房间已满' });
        return;
      }
      if (room.players.find(p => p.id === socket.id)) {
        callback({ success: false, error: '已在房间中' });
        return;
      }
      room.players.push({
        id: socket.id, name: playerName,
        money: INITIAL_MONEY, hand: [], collection: [], isConnected: true
      });
      socket.join(roomCode);
      socket.roomCode = roomCode;
      callback({ success: true });
      io.to(roomCode).emit('room_update', getPublicRoomState(room));
      return;
    }

    // 游戏进行中：尝试断线重连
    const disconnectedPlayer = room.players.find(p =>
      p.name === playerName && !p.isConnected
    );
    if (disconnectedPlayer) {
      // 重连：接管旧玩家位置
      disconnectedPlayer.id = socket.id;
      disconnectedPlayer.isConnected = true;
      if (room.host === disconnectedPlayer.name) {
        // 如果旧玩家是房主，更新 host（host 存的是旧 socket.id，需要修复）
        // host 实际存的是创建者的 socket.id，这里改为更新 host 引用
      }
      // 如果旧玩家是当前回合玩家，无需变更 currentPlayerIndex（已指向旧 id）
      socket.join(roomCode);
      socket.roomCode = roomCode;
      console.log(`[SERVER DEBUG] 玩家 ${playerName} 断线重连，房间 ${roomCode}`);
      callback({ success: true, reconnected: true });

      // 立即发送完整游戏状态给重连玩家
      const personalState = {
        ...getPublicRoomState(room),
        myHand: disconnectedPlayer.hand,
        myCollection: disconnectedPlayer.collection,
        myMoney: disconnectedPlayer.money
      };
      socket.emit('game_state', personalState);
      socket.emit('turn_started', {
        playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room),
        turnRemaining: getTurnRemaining(room)
      });

      // 如果有正在进行的拍卖，同步给重连玩家
      if (room.auctionState) {
        const st = room.auctionState;
        const auctioneer = room.players[st.auctioneerIndex];
        if (st.type === 'open' || st.type === 'round' || st.type === 'sealed' || st.type === 'fixed') {
          const data = {
            type: st.type,
            card: st.card || st.cards?.[0],
            cards: st.cards,
            auctioneer: auctioneer?.id,
            auctioneerName: auctioneer?.name,
            isDouble: st.isDouble,
            timeoutSeconds: AUCTION_TIMEOUT[st.type] ? AUCTION_TIMEOUT[st.type] / 1000 : 30,
            timeRemaining: getAuctionRemaining(room)
          };
          if (st.type === 'round') data.firstBidder = room.players[st.currentBidder]?.id;
          if (st.type === 'sealed') { data.totalPlayers = room.players.length; }
          socket.emit('auction_started', data);
          // 如果已经有出价，补充当前的最高出价信息
          if (st.currentBid) {
            socket.emit('bid_update', {
              type: st.type,
              currentBid: st.currentBid,
              bidderName: room.players.find(p => p.id === st.currentBid.playerId)?.name,
              lastBid: st.lastBid,
              currentBidder: st.currentBidder != null ? room.players[st.currentBidder]?.id : null,
              timeRemaining: getAuctionRemaining(room)
            });
          }
          // 暗标：如果自己已出价，发 sealed_bid_placed
          if (st.type === 'sealed' && st.bids[socket.id] !== undefined) {
            socket.emit('sealed_bid_placed', {
              amount: st.bids[socket.id],
              totalBids: Object.keys(st.bids).length,
              totalPlayers: room.players.length
            });
          }
          // 一口价：如果已定价，发 fixed_price_set
          if (st.type === 'fixed' && st.fixedPrice !== undefined) {
            socket.emit('fixed_price_set', {
              price: st.fixedPrice,
              firstBidder: room.players[st.currentBidder]?.id,
              timeRemaining: getAuctionRemaining(room)
            });
          }
        } else if (st.type === 'double_select_mode') {
          // 打出 Double 牌正在选择模式 → 只发给打出者
          if (socket.id === room.players[st.playerIndex]?.id) {
            const hasPartner = disconnectedPlayer.hand.some(c =>
              c.artistId === st.card.artistId && c.type !== 'double'
            );
            socket.emit('double_mode_select', { card: st.card, hasPartner });
          } else {
            socket.emit('double_waiting', {
              message: `${room.players[st.playerIndex]?.name} 正在选择联合拍卖方式...`,
              playerName: room.players[st.playerIndex]?.name
            });
          }
        } else if (st.type === 'double_find_partner') {
          // 正在寻找合作伙伴 → 发给被问者和其他人
          const askedPlayer = room.players[st.askedIndex];
          if (socket.id === askedPlayer?.id) {
            socket.emit('double_ask_partner', {
              card: st.card,
              askedPlayer: askedPlayer.id,
              auctioneerName: room.players[st.playerIndex]?.name
            });
          } else {
            socket.emit('double_waiting', {
              message: `等待 ${askedPlayer?.name} 决定是否合作...`,
              playerName: askedPlayer?.name
            });
          }
        }
      }
      io.to(roomCode).emit('room_update', getPublicRoomState(room));
      return;
    }

    // 名字不匹配 → 观战
    room.spectators.push({ id: socket.id, name: playerName });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    console.log(`[SERVER DEBUG] 玩家 ${playerName} 以观战身份加入房间 ${roomCode}`);
    callback({ success: true, spectator: true });

    // 给观战者发送当前状态
    const specState = {
      ...getPublicRoomState(room),
      isSpectator: true,
      myHand: [],
      myCollection: [],
      myMoney: 0
    };
    socket.emit('game_state', specState);
    socket.emit('turn_started', {
      playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room)
    });
    io.to(roomCode).emit('room_update', getPublicRoomState(room));
  });

  // 开始游戏
  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) {
      socket.emit('error_msg', '至少需要3人才能开始');
      return;
    }

    room.status = 'playing';
    room.currentRound = 1;
    room.deck = createDeck();

    const drawCount = DRAW_COUNTS[room.players.length];
    room.players.forEach(player => {
      player.hand = room.deck.splice(0, drawCount);
      player.money = INITIAL_MONEY;
      player.collection = [];
    });

    room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);

    console.log(`[SERVER DEBUG] 游戏开始！房间: ${room.code}, 首玩家: ${room.players[room.currentPlayerIndex].name}`);

    io.to(room.code).emit('game_started', {
      room: getPublicRoomState(room),
      currentPlayer: room.players[room.currentPlayerIndex].id
    });

    broadcastGameState(room);
    setTurnTimeout(room);
    io.to(room.code).emit('turn_started', {
      playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room)
    });
  });

  // 打出卡牌
  socket.on('play_card', (cardId) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'playing') return;
    if (room.auctionState) return;  // 拍卖进行中，不能上架新画
    clearTurnTimeout(room);  // 玩家行动，重置回合计时

    const player = room.players[room.currentPlayerIndex];
    if (player.id !== socket.id) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const card = player.hand[cardIndex];
    console.log(`[SERVER DEBUG] ${player.name} 打出 ${card.artistName} (${card.type})`);

    const newCount = room.playedCounts[card.artistId] + 1;
    const isEndCard = newCount === 5;

    if (isEndCard) {
      player.hand.splice(cardIndex, 1);
      room.playedCounts[card.artistId]++;
      room.roundHistory[room.currentRound - 1].push({
        ...card,
        isEndCard: true
      });
      endRound(room);
      return;
    }

    if (card.type === 'double') {
      const hasPartner = player.hand.some(c =>
        c.artistId === card.artistId && c.type !== 'double' && c.id !== card.id
      );

      // ==================== 修复：只有打出Double的玩家收到模式选择 ====================
      // 其他玩家只显示"等待XX选择联合拍卖方式"
      room.auctionState = {
        type: 'double_select_mode',
        card: card,
        playerIndex: room.currentPlayerIndex,
        hasPartner: hasPartner
      };
      
      // 只给打出Double的玩家发送选择模态框
      io.to(player.id).emit('double_mode_select', {
        card: card,
        hasPartner: hasPartner
      });
      
      // 给其他玩家显示等待信息
      room.players.forEach(p => {
        if (p.id !== player.id) {
          io.to(p.id).emit('double_waiting', {
            message: `${player.name} 正在选择联合拍卖方式...`,
            playerName: player.name
          });
        }
      });
      
      broadcastGameState(room);
      return;
    }

    startAuction(room, card, player, cardIndex);
  });

  // Double模式选择（只有打出Double的玩家会触发）
  socket.on('double_mode_choice', (mode, secondCardId = null) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.auctionState) return;

    const state = room.auctionState;
    if (state.type !== 'double_select_mode') return;
    
    // 验证：只有打出Double的玩家才能选择模式
    const doublePlayer = room.players[state.playerIndex];
    if (doublePlayer.id !== socket.id) {
      console.log(`[SERVER DEBUG] rejected: 不是打出Double的玩家`);
      return;
    }

    const { card, playerIndex } = state;
    const player = room.players[playerIndex];

    if (mode === 'self') {
      // 自己配第二张牌
      const secondIndex = player.hand.findIndex(c => c.id === secondCardId);
      if (secondIndex === -1) return;
      const secondCard = player.hand[secondIndex];

      if (secondCard.artistId !== card.artistId || secondCard.type === 'double') {
        socket.emit('error_msg', '必须选择同画家且非Double的牌');
        return;
      }

      const newCount = room.playedCounts[card.artistId] + 2;
      const isEndPair = newCount >= 5;

      player.hand.splice(player.hand.indexOf(card), 1);
      player.hand.splice(secondIndex, 1);

      if (isEndPair) {
        room.playedCounts[card.artistId] = Math.min(newCount, 5);
        room.roundHistory[room.currentRound - 1].push({
          ...card,
          isDoublePair: true
        }, {
          ...secondCard,
          isDoublePair: true
        });
        endRound(room);
        return;
      }

      // 两张一起拍卖，按第二张的卖法
      room.playedCounts[card.artistId] += 2;
      room.roundHistory[room.currentRound - 1].push(card, secondCard);

      room.auctionState = {
        type: secondCard.type,
        cards: [card, secondCard],
        auctioneerIndex: playerIndex,
        isDouble: true,
        oldAuctioneerIndex: playerIndex,
        bids: {},
        currentBid: null,
        lastBid: null,
        passedPlayers: [],
        currentBidder: null
      };

      room.currentPlayerIndex = playerIndex;
      startAuctionType(room, secondCard.type);
    } else if (mode === 'find_partner') {
      // 寻找合作伙伴：从左手边开始问
      room.auctionState = {
        type: 'double_find_partner',
        card: card,
        playerIndex: playerIndex,
        askedIndex: getPlayerLeftIndex(playerIndex, room.players.length)
      };
      
      // 先同步状态，确保被问玩家拿到最新手牌数据
      broadcastGameState(room);
      
      // 再给被问的玩家发送邀请
      const askedPlayer = room.players[room.auctionState.askedIndex];
      io.to(askedPlayer.id).emit('double_ask_partner', {
        card: card,
        askedPlayer: askedPlayer.id,
        auctioneerName: player.name
      });
      
      // 给其他玩家（包括打出Double的玩家）显示等待
      room.players.forEach(p => {
        if (p.id !== askedPlayer.id) {
          io.to(p.id).emit('double_waiting', {
            message: `等待 ${askedPlayer.name} 决定是否合作...`,
            playerName: askedPlayer.name
          });
        }
      });
    }
  });

  // 响应联合拍卖邀请
  socket.on('partner_response', (accept, secondCardId = null) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.auctionState) return;

    const state = room.auctionState;
    if (state.type !== 'double_find_partner') return;

    const { card, playerIndex, askedIndex } = state;
    const askedPlayer = room.players[askedIndex];

    // 验证：只有被邀请的玩家才能响应
    if (askedPlayer.id !== socket.id) {
      console.log(`[SERVER DEBUG] rejected: 不是被邀请的玩家`);
      return;
    }

    if (accept) {
      const secondIndex = askedPlayer.hand.findIndex(c => c.id === secondCardId);
      if (secondIndex === -1) return;
      const secondCard = askedPlayer.hand[secondIndex];

      if (secondCard.artistId !== card.artistId || secondCard.type === 'double') {
        socket.emit('error_msg', '必须选择同画家且非Double的牌');
        return;
      }

      const newCount = room.playedCounts[card.artistId] + 2;
      const isEndPair = newCount >= 5;

      const auctioneer = room.players[playerIndex];
      auctioneer.hand.splice(auctioneer.hand.indexOf(card), 1);
      askedPlayer.hand.splice(secondIndex, 1);

      if (isEndPair) {
        room.playedCounts[card.artistId] = Math.min(newCount, 5);
        room.roundHistory[room.currentRound - 1].push({
          ...card,
          isDoublePair: true
        }, {
          ...secondCard,
          isDoublePair: true
        });
        endRound(room);
        return;
      }

      // 新主持人是合作者
      room.playedCounts[card.artistId] += 2;
      room.roundHistory[room.currentRound - 1].push(card, secondCard);

      room.auctionState = {
        type: secondCard.type,
        cards: [card, secondCard],
        auctioneerIndex: askedIndex,
        isDouble: true,
        oldAuctioneerIndex: playerIndex,
        bids: {},
        currentBid: null,
        lastBid: null,
        passedPlayers: [],
        currentBidder: null
      };

      room.currentPlayerIndex = askedIndex;
      startAuctionType(room, secondCard.type);
    } else {
      // 拒绝，问下一个人
      const nextAsked = getPlayerLeftIndex(askedIndex, room.players.length);
      if (nextAsked === playerIndex) {
        // 一圈问完，没人参加，弃掉此牌，回合交给下一位玩家
        const auctioneer = room.players[playerIndex];
        auctioneer.hand.splice(auctioneer.hand.indexOf(card), 1);

        addLog(room, `${auctioneer.name} 的联合拍卖无人响应，牌被弃掉，回合继续`);

        room.currentPlayerIndex = getPlayerLeftIndex(playerIndex, room.players.length);
        room.auctionState = null;

        broadcastGameState(room);
        setTurnTimeout(room);
        io.to(room.code).emit('turn_started', {
          playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room)
        });
      } else {
        // 继续问下一个人
        room.auctionState.askedIndex = nextAsked;
        const nextAskedPlayer = room.players[nextAsked];
        
        // 先同步状态，再发邀请
        broadcastGameState(room);
        
        io.to(nextAskedPlayer.id).emit('double_ask_partner', {
          card: card,
          askedPlayer: nextAskedPlayer.id,
          auctioneerName: room.players[playerIndex].name
        });
        
        // 给其他人显示等待
        room.players.forEach(p => {
          if (p.id !== nextAskedPlayer.id) {
            io.to(p.id).emit('double_waiting', {
              message: `等待 ${nextAskedPlayer.name} 决定是否合作...`,
              playerName: nextAskedPlayer.name
            });
          }
        });
      }
    }
  });

  // ==================== 定时器管理 ====================
  function clearAuctionTimeout(room) {
    if (room.auctionTimeout) {
      clearTimeout(room.auctionTimeout);
      room.auctionTimeout = null;
      console.log('[SERVER DEBUG] 清除拍卖定时器');
    }
    room.auctionTimeoutStart = null;
  }

  function setAuctionTimeout(room, durationMs) {
    clearAuctionTimeout(room);
    room.auctionTimeoutStart = Date.now();
    room.auctionTimeoutDuration = durationMs;
    console.log(`[SERVER DEBUG] 设置拍卖定时器: ${durationMs}ms`);

    room.auctionTimeout = setTimeout(() => {
      console.log('[SERVER DEBUG] ====== 拍卖时间到！======');
      handleAuctionTimeout(room);
    }, durationMs);
  }

  function getAuctionRemaining(room) {
    if (!room.auctionTimeoutStart) return 0;
    const elapsed = (Date.now() - room.auctionTimeoutStart) / 1000;
    return Math.max(0, Math.round((room.auctionTimeoutDuration || 30000) / 1000 - elapsed));
  }

  function handleAuctionTimeout(room) {
    const state = room.auctionState;
    if (!state) return;

    console.log(`[SERVER DEBUG] 处理超时, type=${state.type}`);

    if (state.type === 'open') {
      if (!state.currentBid) {
        io.to(room.code).emit('auction_timeout', { reason: '无人出价，拍卖师免费获得' });
        resolveAuction(room, state.auctioneerIndex, 0);
      } else {
        const winnerIndex = room.players.findIndex(p => p.id === state.currentBid.playerId);
        io.to(room.code).emit('auction_timeout', { reason: '时间到，最高出价者获胜' });
        resolveAuction(room, winnerIndex, state.currentBid.amount);
      }
    } else if (state.type === 'round') {
      const currentBidderIndex = state.currentBidder;
      const currentBidder = room.players[currentBidderIndex];
      
      console.log(`[SERVER DEBUG] 一圈价超时: 当前出价者 ${currentBidder?.name} 放弃`);
      
      if (!Array.isArray(state.passedPlayers)) state.passedPlayers = [];
      state.passedPlayers.push(currentBidderIndex);

      // 画主超时也应立即成交
      if (currentBidderIndex === state.auctioneerIndex) {
        if (state.lastBid) {
          const winnerIndex = room.players.findIndex(p => p.id === state.lastBid.playerId);
          io.to(room.code).emit('auction_timeout', { reason: '画主超时，最高出价者获胜' });
          resolveAuction(room, winnerIndex, state.lastBid.amount);
        } else {
          io.to(room.code).emit('auction_timeout', { reason: '画主超时且无人出价，免费获得' });
          resolveAuction(room, state.auctioneerIndex, 0);
        }
        return;
      }

      let nextBidder = getPlayerLeftIndex(currentBidderIndex, room.players.length);
      let loopCount = 0;
      while (state.passedPlayers.includes(nextBidder) && nextBidder !== state.auctioneerIndex && loopCount < 10) {
        nextBidder = getPlayerLeftIndex(nextBidder, room.players.length);
        loopCount++;
      }

      if (nextBidder === state.auctioneerIndex || nextBidder === currentBidderIndex) {
        if (state.lastBid) {
          const winnerIndex = room.players.findIndex(p => p.id === state.lastBid.playerId);
          io.to(room.code).emit('auction_timeout', { reason: '时间到，最高出价者获胜' });
          resolveAuction(room, winnerIndex, state.lastBid.amount);
        } else {
          io.to(room.code).emit('auction_timeout', { reason: '无人出价，拍卖师免费获得' });
          resolveAuction(room, state.auctioneerIndex, 0);
        }
      } else {
        state.currentBidder = nextBidder;
        io.to(room.code).emit('bid_update', {
          type: 'round',
          lastBid: state.lastBid,
          currentBidder: room.players[nextBidder].id
        });
        setAuctionTimeout(room, AUCTION_TIMEOUT.round);
      }
    } else if (state.type === 'sealed') {
      console.log('[SERVER DEBUG] 暗标超时：自动为未出价者出价 0');
      room.players.forEach(p => {
        if (state.bids[p.id] === undefined) {
          state.bids[p.id] = 0;
          console.log(`[SERVER DEBUG] 自动出价: ${p.name} = 0`);
        }
      });
      io.to(room.code).emit('auction_timeout', { reason: '暗标时间到，自动揭晓' });
      resolveSealedAuction(room);
    } else if (state.type === 'fixed') {
      const currentBidderIndex = state.currentBidder;
      
      if (!Array.isArray(state.passedPlayers)) state.passedPlayers = [];
      state.passedPlayers.push(currentBidderIndex);

      let nextBidder = getPlayerLeftIndex(currentBidderIndex, room.players.length);
      let loopCount = 0;
      while (state.passedPlayers.includes(nextBidder) && loopCount < 10) {
        nextBidder = getPlayerLeftIndex(nextBidder, room.players.length);
        loopCount++;
      }

      if (nextBidder === state.auctioneerIndex) {
        io.to(room.code).emit('auction_timeout', { reason: '所有人都超时放弃，主持人免费获得' });
        resolveFixedAuction(room, state.auctioneerIndex);
      } else {
        state.currentBidder = nextBidder;
        io.to(room.code).emit('fixed_turn', {
          currentBidder: room.players[nextBidder].id,
          price: state.fixedPrice
        });
        setAuctionTimeout(room, AUCTION_TIMEOUT.fixed);
      }
    }
  }

  // ==================== 回合超时管理 ====================
  function clearTurnTimeout(room) {
    if (room.turnTimeout) {
      clearTimeout(room.turnTimeout);
      room.turnTimeout = null;
    }
    room.turnTimeoutStart = null;
  }

  function setTurnTimeout(room) {
    clearTurnTimeout(room);
    room.turnTimeoutStart = Date.now();
    room.turnTimeout = setTimeout(() => {
      console.log('[SERVER DEBUG] ====== 回合超时（90秒）！自动跳过 ======');
      const currentPlayer = room.players[room.currentPlayerIndex];
      addLog(room, `${currentPlayer.name} 超时未行动，自动跳过`);
      room.currentPlayerIndex = getPlayerLeftIndex(room.currentPlayerIndex, room.players.length);
      broadcastGameState(room);
      setTurnTimeout(room);
      emitTurnStarted(room);
    }, TURN_TIMEOUT);
  }

  function getTurnRemaining(room) {
    if (!room.turnTimeoutStart) return TURN_TIMEOUT / 1000;
    const elapsed = (Date.now() - room.turnTimeoutStart) / 1000;
    return Math.max(0, Math.round(TURN_TIMEOUT / 1000 - elapsed));
  }

  function emitTurnStarted(room) {
    io.to(room.code).emit('turn_started', {
      playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room),
      turnRemaining: getTurnRemaining(room)
    });
  }

  // ==================== 核心修复：出价处理 ====================
  socket.on('place_bid', (amount) => {
    console.log(`\n[SERVER DEBUG] ====== place_bid 收到 ======`);
    console.log(`[SERVER DEBUG] socket.id: ${socket.id}`);
    console.log(`[SERVER DEBUG] raw amount:`, amount, '| type:', typeof amount);

    const room = rooms[socket.roomCode];
    if (!room) {
      console.log('[SERVER DEBUG] rejected: room not found');
      return;
    }
    if (!room.auctionState) {
      console.log('[SERVER DEBUG] rejected: no auction state');
      return;
    }

    const state = room.auctionState;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      console.log('[SERVER DEBUG] rejected: player not found');
      return;
    }

    amount = parseInt(amount);
    if (isNaN(amount)) amount = 0;
    console.log(`[SERVER DEBUG] parsed amount: ${amount}`);
    console.log(`[SERVER DEBUG] auction type: ${state.type}`);
    console.log(`[SERVER DEBUG] player money: ${player.money}`);

    if (amount > player.money) {
      console.log('[SERVER DEBUG] rejected: insufficient funds');
      socket.emit('error_msg', '资金不足');
      return;
    }

    if (state.type === 'open') {
      if (state.currentBid && amount <= state.currentBid.amount) {
        socket.emit('error_msg', '出价必须高于当前最高价');
        return;
      }
      state.currentBid = { playerId: socket.id, amount };
      state.bids[socket.id] = amount;
      
      // ==================== 公开竞价：每次出价重置15秒限时 ====================
      console.log('[SERVER DEBUG] 公开竞价：出价成功，重置15秒定时器');
      setAuctionTimeout(room, AUCTION_TIMEOUT.open);
      
      io.to(room.code).emit('bid_update', {
        type: 'open',
        currentBid: state.currentBid,
        bidderName: player.name
      });
    } else if (state.type === 'round') {
      const bidderIndex = room.players.findIndex(p => p.id === socket.id);
      if (bidderIndex !== state.currentBidder) {
        console.log(`[SERVER DEBUG] rejected: not your turn. current=${state.currentBidder}, you=${bidderIndex}`);
        return;
      }

      if (state.lastBid && amount <= state.lastBid.amount) {
        socket.emit('error_msg', '出价必须高于上家');
        return;
      }

      state.currentBid = { playerId: socket.id, amount };
      state.bids[socket.id] = amount;
      state.lastBid = { playerId: socket.id, amount };

      setAuctionTimeout(room, AUCTION_TIMEOUT.round);

      if (bidderIndex === state.auctioneerIndex) {
        console.log('[SERVER DEBUG] 一圈价：拍卖师出价，拍卖立即结束');
        clearAuctionTimeout(room);
        resolveAuction(room);
        return;
      }

      let nextBidder = getPlayerLeftIndex(bidderIndex, room.players.length);
      
      if (nextBidder === state.auctioneerIndex && state.passedPlayers.includes(state.auctioneerIndex)) {
        console.log('[SERVER DEBUG] round: 回到已放弃的拍卖师，结束拍卖');
        clearAuctionTimeout(room);
        resolveAuction(room);
        return;
      }

      let loopCount = 0;
      while (state.passedPlayers.includes(nextBidder) && nextBidder !== state.auctioneerIndex && loopCount < 10) {
        nextBidder = getPlayerLeftIndex(nextBidder, room.players.length);
        if (nextBidder === bidderIndex) {
          console.log('[SERVER DEBUG] round: 异常循环，强制结束');
          clearAuctionTimeout(room);
          resolveAuction(room);
          return;
        }
        loopCount++;
      }

      if (nextBidder === state.auctioneerIndex) {
        state.currentBidder = nextBidder;
        console.log(`[SERVER DEBUG] 一圈价：轮到拍卖师 (index ${nextBidder}) 最后出价`);
        io.to(room.code).emit('bid_update', {
          type: 'round',
          lastBid: state.lastBid,
          currentBidder: room.players[nextBidder].id
        });
      } else if (nextBidder === bidderIndex) {
        console.log('[SERVER DEBUG] round: 绕回自己，结束拍卖');
        clearAuctionTimeout(room);
        resolveAuction(room);
      } else {
        state.currentBidder = nextBidder;
        io.to(room.code).emit('bid_update', {
          type: 'round',
          lastBid: state.lastBid,
          currentBidder: room.players[nextBidder].id
        });
      }
    } else if (state.type === 'sealed') {
      console.log(`[SERVER DEBUG] 进入 SEALED 处理分支`);
      console.log(`[SERVER DEBUG] 当前已出价人数: ${Object.keys(state.bids).length}, 总玩家: ${room.players.length}`);
      console.log(`[SERVER DEBUG] 已出价者:`, Object.keys(state.bids));

      if (state.bids[socket.id] !== undefined) {
        console.log(`[SERVER DEBUG] sealed: 玩家 ${player.name} 已经出过价了，拒绝重复出价`);
        socket.emit('error_msg', '你已经出过价了');
        return;
      }

      state.bids[socket.id] = amount;
      const totalBids = Object.keys(state.bids).length;
      console.log(`[SERVER DEBUG] sealed: ${player.name} 出价 ${amount}万，当前 ${totalBids}/${room.players.length} 人已出价`);

      io.to(room.code).emit('sealed_bid_placed', {
        playerId: socket.id,
        playerName: player.name,
        amount: amount,
        totalBids: totalBids,
        totalPlayers: room.players.length
      });

      if (totalBids >= room.players.length) {
        console.log(`[SERVER DEBUG] sealed: 所有玩家已出价，准备揭晓`);
        clearAuctionTimeout(room);
        resolveSealedAuction(room);
      } else {
        console.log(`[SERVER DEBUG] sealed: 等待其他 ${room.players.length - totalBids} 位玩家出价`);
        room.players.forEach(p => {
          if (state.bids[p.id] === undefined) {
            io.to(p.id).emit('sealed_waiting', {
              message: `等待其他玩家出价... (${totalBids}/${room.players.length})`
            });
          }
        });
      }
      return;
    } else if (state.type === 'fixed') {
      console.log(`[SERVER DEBUG] 进入 FIXED 处理分支`);
      const bidderIndex = room.players.findIndex(p => p.id === socket.id);
      console.log(`[SERVER DEBUG] bidderIndex: ${bidderIndex}, currentBidder: ${state.currentBidder}`);
      if (bidderIndex !== state.currentBidder) {
        console.log(`[SERVER DEBUG] rejected: not current bidder. current=${state.currentBidder}, me=${socket.id}, myIndex=${bidderIndex}`);
        return;
      }

      setAuctionTimeout(room, AUCTION_TIMEOUT.fixed);

      if (amount === 0) {
        console.log('[SERVER DEBUG] 玩家选择放弃');
        if (!Array.isArray(state.passedPlayers)) {
          console.log('[SERVER DEBUG] 警告: passedPlayers 不是数组，重新初始化');
          state.passedPlayers = [];
        }
        state.passedPlayers.push(bidderIndex);
        console.log(`[SERVER DEBUG] passedPlayers 更新为:`, state.passedPlayers);

        let nextBidder = getPlayerLeftIndex(bidderIndex, room.players.length);
        console.log(`[SERVER DEBUG] 原始 nextBidder: ${nextBidder}`);

        let loopCount = 0;
        while (state.passedPlayers.includes(nextBidder) && loopCount < 10) {
          nextBidder = getPlayerLeftIndex(nextBidder, room.players.length);
          loopCount++;
        }
        console.log(`[SERVER DEBUG] 跳过已放弃后 nextBidder: ${nextBidder}, loopCount: ${loopCount}`);

        if (nextBidder === state.auctioneerIndex) {
          console.log('[SERVER DEBUG] 所有人都放弃了，主持人必须买下');
          clearAuctionTimeout(room);
          resolveFixedAuction(room, state.auctioneerIndex);
          return;
        }

        state.currentBidder = nextBidder;
        console.log(`[SERVER DEBUG] 发送 fixed_turn 给 index ${nextBidder}, id ${room.players[nextBidder]?.id}`);
        io.to(room.code).emit('fixed_turn', {
          currentBidder: room.players[nextBidder].id,
          price: state.fixedPrice
        });
      } else {
        console.log('[SERVER DEBUG] 玩家选择购买');
        clearAuctionTimeout(room);
        resolveFixedAuction(room, bidderIndex);
      }
    }

    broadcastGameState(room);
  });

  // ==================== 放弃出价 ====================
  socket.on('pass_bid', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.auctionState) return;

    const state = room.auctionState;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    console.log(`[SERVER DEBUG] pass_bid 收到, playerIndex: ${playerIndex}, type: ${state.type}`);

    if (state.type === 'open') {
      if (!Array.isArray(state.passedPlayers)) state.passedPlayers = [];
      state.passedPlayers.push(playerIndex);

      const activePlayers = room.players.filter((_, i) => !state.passedPlayers.includes(i));
      if (activePlayers.length === 0) {
        // 所有人都放弃 → 画主免费获得
        clearAuctionTimeout(room);
        resolveAuction(room, state.auctioneerIndex, 0);
      } else if (activePlayers.length === 1 && state.currentBid) {
        // 只剩出价者 → 立即成交
        resolveAuction(room);
      }
    } else if (state.type === 'round') {
      if (playerIndex !== state.currentBidder) {
        console.log(`[SERVER DEBUG] pass_bid rejected: not current bidder. current=${state.currentBidder}, me=${playerIndex}`);
        return;
      }

      setAuctionTimeout(room, AUCTION_TIMEOUT.round);

      if (!Array.isArray(state.passedPlayers)) state.passedPlayers = [];
      state.passedPlayers.push(playerIndex);

      // 画主出价或放弃都应立即成交
      if (playerIndex === state.auctioneerIndex) {
        if (state.lastBid) {
          const winnerIndex = room.players.findIndex(p => p.id === state.lastBid.playerId);
          console.log(`[SERVER DEBUG] 一圈价：画主放弃，最高出价者获胜 (${room.players[winnerIndex].name}, ${state.lastBid.amount}万)`);
          clearAuctionTimeout(room);
          resolveAuction(room, winnerIndex, state.lastBid.amount);
        } else {
          console.log('[SERVER DEBUG] 一圈价：画主放弃且无人出价，免费获得');
          clearAuctionTimeout(room);
          resolveAuction(room, state.auctioneerIndex, 0);
        }
        return;
      }

      let nextBidder = getPlayerLeftIndex(playerIndex, room.players.length);
      let loopCount = 0;

      while (state.passedPlayers.includes(nextBidder) && nextBidder !== state.auctioneerIndex && loopCount < 10) {
        nextBidder = getPlayerLeftIndex(nextBidder, room.players.length);
        loopCount++;
      }

      if (nextBidder === state.auctioneerIndex || nextBidder === playerIndex) {
        // 轮到画主或绕回自己，都意味着该画主做最后决策
        state.currentBidder = state.auctioneerIndex;
        console.log(`[SERVER DEBUG] 一圈价：轮到画主最后决策`);
        io.to(room.code).emit('bid_update', {
          type: 'round',
          lastBid: state.lastBid,
          currentBidder: room.players[state.auctioneerIndex].id
        });
      } else {
        state.currentBidder = nextBidder;
        io.to(room.code).emit('bid_update', {
          type: 'round',
          lastBid: state.lastBid,
          currentBidder: room.players[nextBidder].id
        });
      }
    }

    broadcastGameState(room);
  });

  // 一口价定价
  socket.on('set_fixed_price', (price) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.auctionState) return;

    const state = room.auctionState;
    if (state.type !== 'fixed') return;
    if (room.players[state.auctioneerIndex].id !== socket.id) return;

    const auctioneer = room.players[state.auctioneerIndex];
    price = parseInt(price);
    if (isNaN(price) || price < 0) price = 0;

    if (price > auctioneer.money) {
      socket.emit('error_msg', '定价不能超过你的资金');
      return;
    }

    state.fixedPrice = price;
    state.currentBidder = getPlayerLeftIndex(state.auctioneerIndex, room.players.length);

    console.log(`[SERVER DEBUG] 一口价设定为 ${price}万，轮到 index ${state.currentBidder} (${room.players[state.currentBidder]?.name})`);

    setAuctionTimeout(room, AUCTION_TIMEOUT.fixed);

    io.to(room.code).emit('fixed_price_set', {
      price: price,
      firstBidder: room.players[state.currentBidder].id
    });
    broadcastGameState(room);
  });

  // ==================== 游戏逻辑函数 ====================

  function startAuction(room, card, player, cardIndex) {
    player.hand.splice(cardIndex, 1);

    room.auctionState = {
      type: card.type,
      card: card,
      auctioneerIndex: room.currentPlayerIndex,
      bids: {},
      currentBid: null,
      lastBid: null,
      passedPlayers: [],
      currentBidder: null,
      isDouble: false
    };

    room.playedCounts[card.artistId]++;
    room.roundHistory[room.currentRound - 1].push(card);

    startAuctionType(room, card.type);
  }

  function startAuctionType(room, type) {
    const state = room.auctionState;
    const auctioneer = room.players[state.auctioneerIndex];

    console.log(`[SERVER DEBUG] 开始 ${type} 拍卖，拍卖师: ${auctioneer.name}`);

    // 根据拍卖类型设置不同的限时
    const timeout = AUCTION_TIMEOUT[type] || 30000;
    setAuctionTimeout(room, timeout);

    if (type === 'open') {
      io.to(room.code).emit('auction_started', {
        type: 'open',
        card: state.card || state.cards[0],
        cards: state.cards,
        auctioneer: auctioneer.id,
        auctioneerName: auctioneer.name,
        isDouble: state.isDouble,
        timeoutSeconds: 15,
        timeRemaining: getAuctionRemaining(room)
      });
    } else if (type === 'round') {
      state.currentBidder = getPlayerLeftIndex(state.auctioneerIndex, room.players.length);
      io.to(room.code).emit('auction_started', {
        type: 'round',
        card: state.card || state.cards[0],
        cards: state.cards,
        auctioneer: auctioneer.id,
        auctioneerName: auctioneer.name,
        firstBidder: room.players[state.currentBidder].id,
        isDouble: state.isDouble,
        timeoutSeconds: 30,
        timeRemaining: getAuctionRemaining(room)
      });
    } else if (type === 'sealed') {
      io.to(room.code).emit('auction_started', {
        type: 'sealed',
        card: state.card || state.cards[0],
        cards: state.cards,
        auctioneer: auctioneer.id,
        auctioneerName: auctioneer.name,
        isDouble: state.isDouble,
        totalPlayers: room.players.length,
        timeoutSeconds: 30,
        timeRemaining: getAuctionRemaining(room)
      });
    } else if (type === 'fixed') {
      io.to(room.code).emit('auction_started', {
        type: 'fixed',
        card: state.card || state.cards[0],
        cards: state.cards,
        auctioneer: auctioneer.id,
        auctioneerName: auctioneer.name,
        isDouble: state.isDouble,
        timeoutSeconds: 30,
        timeRemaining: getAuctionRemaining(room)
      });
    }

    broadcastGameState(room);
  }

  function resolveAuction(room, forcedWinner = null, forcedPrice = null) {
    clearAuctionTimeout(room);
    const state = room.auctionState;
    let winnerIndex, price;

    if (forcedWinner !== null) {
      winnerIndex = forcedWinner;
      price = forcedPrice || 0;
    } else if (state.currentBid) {
      winnerIndex = room.players.findIndex(p => p.id === state.currentBid.playerId);
      price = state.currentBid.amount;
    } else {
      winnerIndex = state.auctioneerIndex;
      price = 0;
    }

    const winner = room.players[winnerIndex];
    const auctioneer = room.players[state.auctioneerIndex];
    const cards = state.cards || [state.card];

    console.log(`[SERVER DEBUG] 拍卖结算: 获胜者=${winner.name}, 价格=${price}, 是否联合=${state.isDouble}`);

    if (state.isDouble) {
      const oldAuctioneer = room.players[state.oldAuctioneerIndex];
      const newAuctioneer = room.players[state.auctioneerIndex];

      if (winnerIndex === state.oldAuctioneerIndex) {
        const half = Math.floor(price / 2);
        const extra = price % 2;
        winner.money -= price;
        newAuctioneer.money += half + extra;
      } else if (winnerIndex === state.auctioneerIndex) {
        const half = Math.floor(price / 2);
        winner.money -= price;
        oldAuctioneer.money += half;
      } else {
        const half = Math.floor(price / 2);
        const extra = price % 2;
        winner.money -= price;
        oldAuctioneer.money += half;
        newAuctioneer.money += half + extra;
      }

      winner.collection.push(...cards);
      addLog(room, `${winner.name} 以 ${price}万 购得联合拍卖的 ${cards[0].artistName} 画作（${oldAuctioneer.name} & ${newAuctioneer.name} 合作）`);
    } else {
      if (winnerIndex === state.auctioneerIndex) {
        winner.money -= price;
      } else {
        winner.money -= price;
        auctioneer.money += price;
      }

      winner.collection.push(...cards);
      addLog(room, `${winner.name} 以 ${price}万 购得 ${cards[0].artistName} 画作（拍卖师：${auctioneer.name}）`);
    }

    const shouldEndRound = checkRoundEnd(room);

    if (shouldEndRound) {
      endRound(room);
      return;
    }

    if (state.isDouble) {
      // 联合拍卖后轮到打出 Double 牌的玩家左手边（不是合作者）
      room.currentPlayerIndex = getPlayerLeftIndex(state.oldAuctioneerIndex ?? state.auctioneerIndex, room.players.length);
    } else {
      room.currentPlayerIndex = getPlayerLeftIndex(room.currentPlayerIndex, room.players.length);
    }

    room.auctionState = null;
    clearTurnTimeout(room);
    broadcastGameState(room);
    setTurnTimeout(room);
    io.to(room.code).emit('turn_started', {
      playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room)
    });
  }

  function resolveFixedAuction(room, buyerIndex) {
    clearAuctionTimeout(room);
    const state = room.auctionState;
    const price = state.fixedPrice || 0;
    console.log(`[SERVER DEBUG] resolveFixedAuction: buyerIndex=${buyerIndex}, price=${price}`);
    resolveAuction(room, buyerIndex, price);
  }

  function resolveSealedAuction(room) {
    clearAuctionTimeout(room);
    const state = room.auctionState;
    
    const bidCount = Object.keys(state.bids).length;
    const playerCount = room.players.length;
    console.log(`[SERVER DEBUG] resolveSealedAuction: ${bidCount}/${playerCount} 人已出价`);
    
    if (bidCount < playerCount) {
      console.log(`[SERVER DEBUG] 警告: 并非所有玩家都出价了，延迟揭晓`);
      return;
    }

    const bids = Object.entries(state.bids).map(([pid, amount]) => ({
      playerId: pid,
      amount,
      index: room.players.findIndex(p => p.id === pid)
    }));

    const validBids = bids.filter(b => b.index !== -1);
    if (validBids.length === 0) {
      console.log('[SERVER DEBUG] 暗标: 没有有效出价，拍卖师免费获得');
      resolveAuction(room, state.auctioneerIndex, 0);
      return;
    }

    validBids.sort((a, b) => b.amount - a.amount);

    let winner = validBids[0];
    const maxBid = winner.amount;
    const tiedBids = validBids.filter(b => b.amount === maxBid);

    if (tiedBids.length > 1) {
      const auctioneerInTied = tiedBids.find(b => b.index === state.auctioneerIndex);
      if (auctioneerInTied) {
        winner = auctioneerInTied;
      } else {
        let checkIndex = getPlayerLeftIndex(state.auctioneerIndex, room.players.length);
        while (checkIndex !== state.auctioneerIndex) {
          const found = tiedBids.find(b => b.index === checkIndex);
          if (found) {
            winner = found;
            break;
          }
          checkIndex = getPlayerLeftIndex(checkIndex, room.players.length);
        }
      }
    }

    console.log(`[SERVER DEBUG] 暗标揭晓: 获胜者=${room.players[winner.index].name}, 出价=${winner.amount}`);

    io.to(room.code).emit('sealed_reveal', {
      bids: validBids.map(b => ({
        playerId: b.playerId,
        amount: b.amount,
        playerName: room.players[b.index].name
      })),
      winner: winner.playerId,
      winnerName: room.players[winner.index].name
    });

    setTimeout(() => {
      resolveAuction(room, winner.index, winner.amount);
    }, 3000);
  }

  function endRound(room) {
    clearAuctionTimeout(room);
    clearTurnTimeout(room);
    const result = scoreRound(room);

    // 构建每位玩家的收藏明细
    const playerDetails = room.players.map(p => {
      const artistCounts = {};
      p.collection.forEach(c => {
        artistCounts[c.artistId] = (artistCounts[c.artistId] || 0) + 1;
      });
      return {
        id: p.id,
        name: p.name,
        money: p.money,
        collection: p.collection.map(c => ({ artistId: c.artistId, artistName: c.artistName })),
        artistBreakdown: artistCounts
      };
    });

    io.to(room.code).emit('round_end', {
      round: room.currentRound,
      playedCounts: { ...room.playedCounts },
      values: result.values,
      cumulativeValues: result.cumulativeValues,
      playerDetails
    });

    addLog(room, `=== 第 ${room.currentRound} 回合结束 ===`);
    Object.entries(result.values).forEach(([aid, val]) => {
      if (val > 0) {
        const artist = ARTISTS.find(a => a.id === aid);
        addLog(room, `${artist.name}: +${val}万 (累计 ${result.cumulativeValues[aid]}万)`);
      }
    });

    ARTISTS.forEach(artist => {
      room.playedCounts[artist.id] = 0;
    });

    if (room.currentRound >= 4) {
      setTimeout(() => endGame(room), 5000);
      return;
    }

    setTimeout(() => {
      room.currentRound++;
      const refillCount = REFILL_COUNTS[room.players.length];

      room.players.forEach(player => {
        const drawCount = Math.min(refillCount, room.deck.length);
        if (drawCount > 0) {
          player.hand.push(...room.deck.splice(0, drawCount));
        }
      });

      addLog(room, `第 ${room.currentRound} 回合开始，每人补 ${refillCount} 张牌`);

      io.to(room.code).emit('new_round', {
        round: room.currentRound,
        currentPlayer: room.players[room.currentPlayerIndex].id
      });

      broadcastGameState(room);
      setTurnTimeout(room);
      io.to(room.code).emit('turn_started', {
        playerId: room.players[room.currentPlayerIndex].id,
      turnRemaining: getTurnRemaining(room)
      });
    }, 5000);
  }

  function endGame(room) {
    clearTurnTimeout(room);
    room.status = 'ended';

    const rankings = room.players.map(p => ({
      id: p.id,
      name: p.name,
      money: p.money
    })).sort((a, b) => b.money - a.money);

    io.to(room.code).emit('game_end', { rankings });
    addLog(room, `游戏结束！冠军：${rankings[0].name}，资金：${rankings[0].money}万`);
  }

  function addLog(room, message) {
    room.log.push({ time: Date.now(), message });
    io.to(room.code).emit('game_log', message);
  }

  // 聊天
  socket.on('send_chat', (msg) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const spec = (room.spectators || []).find(s => s.id === socket.id);
    const name = player ? player.name : (spec ? spec.name + '(观战)' : '?');
    const text = String(msg || '').trim().slice(0, 200);
    if (!text) return;
    const entry = { time: Date.now(), name, text };
    room.chat.push(entry);
    if (room.chat.length > 200) room.chat.shift();
    io.to(room.code).emit('chat_msg', entry);
  });

  function getPublicRoomState(room) {
    return {
      code: room.code,
      host: room.host,
      status: room.status,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        money: p.money,
        collectionCount: p.collection.length,
        handCount: p.hand.length,
        isConnected: p.isConnected
      })),
      currentRound: room.currentRound,
      currentPlayerIndex: room.currentPlayerIndex,
      playedCounts: room.playedCounts,
      valueBoard: room.valueBoard,
      auctionState: room.auctionState ? {
        type: room.auctionState.type,
        auctioneerIndex: room.auctionState.auctioneerIndex,
        currentBidder: room.auctionState.currentBidder,
        currentBid: room.auctionState.currentBid,
        fixedPrice: room.auctionState.fixedPrice,
        isDouble: room.auctionState.isDouble,
        auctionTimeRemaining: getAuctionRemaining(room),
        sealedBidsCount: room.auctionState.type === 'sealed' ? Object.keys(room.auctionState.bids).length : undefined,
        sealedTotalPlayers: room.auctionState.type === 'sealed' ? room.players.length : undefined,
        sealedBids: room.auctionState.type === 'sealed' ? { ...room.auctionState.bids } : undefined
      } : null,
      turnTimeRemaining: getTurnRemaining(room),
      log: room.log.slice(-20)
    };
  }

  function broadcastGameState(room) {
    room.players.forEach(player => {
      const personalState = {
        ...getPublicRoomState(room),
        myHand: player.hand,
        myCollection: player.collection,
        myMoney: player.money
      };
      io.to(player.id).emit('game_state', personalState);
    });
    // 给观战者发送（不含手牌）
    (room.spectators || []).forEach(s => {
      io.to(s.id).emit('game_state', {
        ...getPublicRoomState(room),
        isSpectator: true,
        myHand: [], myCollection: [], myMoney: 0
      });
    });
  }

  // 断开连接
  socket.on('disconnect', () => {
    console.log('[SERVER DEBUG] User disconnected:', socket.id);
    const room = rooms[socket.roomCode];
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.isConnected = false;
        io.to(room.code).emit('room_update', getPublicRoomState(room));
      }
      // 移除观战者
      room.spectators = (room.spectators || []).filter(s => s.id !== socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SERVER DEBUG] Modern Art server running on port ${PORT}`);
});