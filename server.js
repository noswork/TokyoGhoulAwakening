const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 設置 Handlebars 作為模板引擎
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'src/pages'));

// 服務靜態文件
app.use(express.static('public'));

// 全局倒計時數據存儲
let countdownItems = [];
let nextId = 1;

// 根路由
app.get('/', (req, res) => {
  res.render('index', { 
    title: '多人協作倒計時工具'
  });
});

// 生成隨機用戶名
function generateUserName() {
  const adjectives = ['勤奮的', '聰明的', '快速的', '準確的', '專注的', '創新的', '積極的', '高效的'];
  const nouns = ['戰士', '工程師', '設計師', '分析師', '專家', '管理者', '開發者', '策略家'];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const number = Math.floor(Math.random() * 999) + 1;
  return `${adjective}${noun}${number}`;
}

// 生成隨機顏色
function generateUserColor() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', 
    '#98D8C8', '#F7DC6F', '#DDA0DD', '#98FB98',
    '#F0E68C', '#FFB6C1', '#87CEEB', '#DEB887',
    '#FF9999', '#66B2FF', '#99FF99', '#FFB366'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Socket.IO 連接處理
io.on('connection', (socket) => {
  console.log('新用戶連接:', socket.id);
  
  // 為新用戶生成身份
  socket.user = {
    id: socket.id,
    name: generateUserName(),
    color: generateUserColor(),
    connected: true
  };
  
  console.log(`用戶 ${socket.user.name} 已連接`);
  
  // 發送當前所有倒計時項目給新用戶
  socket.emit('countdown-list', countdownItems);
  
  // 通知其他用戶有新用戶加入
  socket.broadcast.emit('user-joined', socket.user);
  
  // 處理添加新倒計時
  socket.on('add-countdown', (data) => {
    const { x, y, minutes, seconds } = data;
    
    // 數據驗證
    if (typeof x !== 'number' || typeof y !== 'number' || 
        typeof minutes !== 'number' || typeof seconds !== 'number' ||
        x < 0 || y < 0 || minutes < 0 || seconds < 0 || 
        minutes > 59 || seconds > 59) {
      socket.emit('error', { message: '輸入數據無效' });
      return;
    }
    
    const totalSeconds = minutes * 60 + seconds;
    if (totalSeconds <= 0) {
      socket.emit('error', { message: '時間必須大於0' });
      return;
    }
    
    const now = new Date();
    const endTime = new Date(now.getTime() + totalSeconds * 1000);
    
    const newItem = {
      id: nextId++,
      x: x,
      y: y,
      originalDuration: totalSeconds,
      endTime: endTime.getTime(),
      createdBy: socket.user.name,
      createdByColor: socket.user.color,
      createdAt: now.getTime()
    };
    
    countdownItems.push(newItem);
    
    // 廣播給所有用戶
    io.emit('countdown-added', newItem);
    
    console.log(`${socket.user.name} 添加了倒計時: (${x},${y}) ${minutes}:${seconds.toString().padStart(2, '0')}`);
  });
  
  // 處理移除倒計時
  socket.on('remove-countdown', (data) => {
    const { id } = data;
    const itemIndex = countdownItems.findIndex(item => item.id === id);
    
    if (itemIndex !== -1) {
      const removedItem = countdownItems.splice(itemIndex, 1)[0];
      io.emit('countdown-removed', { id });
      console.log(`${socket.user.name} 移除了倒計時項目 ID: ${id}`);
    }
  });
  
  // 處理清空所有倒計時
  socket.on('clear-all', () => {
    countdownItems = [];
    io.emit('countdowns-cleared');
    console.log(`${socket.user.name} 清空了所有倒計時`);
  });
  
  // 用戶斷線
  socket.on('disconnect', () => {
    console.log(`用戶 ${socket.user.name} 已斷線`);
    socket.broadcast.emit('user-left', socket.user.id);
  });
});

// 定期清理過期的倒計時項目
setInterval(() => {
  const now = Date.now();
  const initialCount = countdownItems.length;
  
  countdownItems = countdownItems.filter(item => item.endTime > now);
  
  if (countdownItems.length !== initialCount) {
    // 如果有項目被清理，通知所有用戶更新列表
    io.emit('countdown-list', countdownItems);
    console.log(`清理了 ${initialCount - countdownItems.length} 個過期倒計時項目`);
  }
}, 5000); // 每5秒檢查一次

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeCountdowns: countdownItems.length,
    uptime: process.uptime(),
    timezone: 'Asia/Taipei'
  });
});

// 啟動服務器 - Railway 兼容
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 多人協作倒計時工具運行在端口 ${PORT}`);
  console.log(`📅 服務器時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  console.log(`🌍 環境: ${process.env.NODE_ENV || 'development'}`);
});