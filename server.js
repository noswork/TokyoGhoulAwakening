const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;

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

// 數據文件路徑
const DATA_FILE = path.join(__dirname, 'data', 'countdowns.json');

// 全局倒計時數據存儲
let countdownItems = [];
let nextId = 1;

// 確保數據目錄存在
async function ensureDataDirectory() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  } catch (error) {
    console.error('創建數據目錄失敗:', error);
  }
}

// 從文件加載數據
async function loadCountdownData() {
  try {
    await ensureDataDirectory();
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    
    // 清理過期的倒計時
    const now = Date.now();
    countdownItems = parsed.countdowns.filter(item => item.endTime > now);
    nextId = parsed.nextId || 1;
    
    // 找到最大ID + 1
    if (countdownItems.length > 0) {
      nextId = Math.max(...countdownItems.map(item => item.id)) + 1;
    }
    
    console.log(`📊 加載了 ${countdownItems.length} 個倒計時項目`);
  } catch (error) {
    console.log('📝 創建新的數據文件');
    countdownItems = [];
    nextId = 1;
    await saveCountdownData();
  }
}

// 保存數據到文件
async function saveCountdownData() {
  try {
    const data = {
      countdowns: countdownItems,
      nextId: nextId,
      lastUpdated: new Date().toISOString()
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('保存數據失敗:', error);
  }
}

// 啟動時加載數據
loadCountdownData();

// 根路由
app.get('/', (req, res) => {
  res.render('index', { 
    title: '多人協作倒計時工具'
  });
});

// Socket.IO 連接處理
io.on('connection', (socket) => {
  console.log('新用戶連接:', socket.id);
  
  // 初始化用戶信息
  socket.user = {
    id: socket.id,
    name: '未命名用戶',
    color: '#3b82f6',
    connected: true
  };
  
  // 發送當前所有倒計時項目給新用戶
  socket.emit('countdown-list', countdownItems);
  
  // 處理用戶設置信息
  socket.on('set-user-info', (userInfo) => {
    socket.user.name = userInfo.name;
    socket.user.color = userInfo.color;
    console.log(`👤 用戶 ${socket.user.name} 已連接`);
    
    // 通知其他用戶有新用戶加入
    socket.broadcast.emit('user-joined', socket.user);
  });
  
  // 處理添加新倒計時
  socket.on('add-countdown', async (data) => {
    const { x, y, minutes, seconds, user } = data;
    
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
    
    // 檢查座標是否重複
    const existingItem = countdownItems.find(item => item.x === x && item.y === y);
    if (existingItem) {
      const remaining = Math.max(0, existingItem.endTime - Date.now());
      const timeStr = remaining > 0 ? 
        `${Math.floor(remaining / 60000)}:${Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0')}` : 
        '已結束';
      
      socket.emit('error', { 
        message: `座標 (${x}, ${y}) 已存在倒計時！\n創建者：${existingItem.createdBy}\n剩餘時間：${timeStr}`,
        duplicateId: existingItem.id
      });
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
      createdBy: user ? user.name : socket.user.name,
      createdByColor: user ? user.color : socket.user.color,
      createdAt: now.getTime()
    };
    
    countdownItems.push(newItem);
    
    // 保存到文件
    await saveCountdownData();
    
    // 廣播給所有用戶
    io.emit('countdown-added', newItem);
    
    console.log(`✅ ${socket.user.name} 添加了倒計時: (${x},${y}) ${minutes}:${seconds.toString().padStart(2, '0')}`);
  });
  
  // 處理移除倒計時
  socket.on('remove-countdown', async (data) => {
    const { id } = data;
    const itemIndex = countdownItems.findIndex(item => item.id === id);
    
    if (itemIndex !== -1) {
      const removedItem = countdownItems.splice(itemIndex, 1)[0];
      
      // 保存到文件
      await saveCountdownData();
      
      io.emit('countdown-removed', { id });
      console.log(`🗑️ ${socket.user.name} 移除了倒計時項目 ID: ${id}`);
    }
  });
  
  // 處理清空所有倒計時
  socket.on('clear-all', async () => {
    countdownItems = [];
    
    // 保存到文件
    await saveCountdownData();
    
    io.emit('countdowns-cleared');
    console.log(`🧹 ${socket.user.name} 清空了所有倒計時`);
  });
  
  // 用戶斷線
  socket.on('disconnect', () => {
    console.log(`👋 用戶 ${socket.user.name} 已斷線`);
    socket.broadcast.emit('user-left', socket.user.id);
  });
});

// 定期清理過期的倒計時項目並保存
setInterval(async () => {
  const now = Date.now();
  const initialCount = countdownItems.length;
  
  countdownItems = countdownItems.filter(item => item.endTime > (now - 30000)); // 保留30秒緩衝
  
  if (countdownItems.length !== initialCount) {
    // 保存變更
    await saveCountdownData();
    
    // 通知所有用戶更新列表
    io.emit('countdown-list', countdownItems);
    console.log(`🧹 清理了 ${initialCount - countdownItems.length} 個過期倒計時項目`);
  }
}, 60000); // 每分鐘檢查一次

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeCountdowns: countdownItems.length,
    uptime: process.uptime(),
    timezone: 'Asia/Taipei',
    dataFile: DATA_FILE
  });
});

// 數據狀態端點（調試用）
app.get('/data-status', (req, res) => {
  res.json({
    countdowns: countdownItems.length,
    nextId: nextId,
    items: countdownItems.map(item => ({
      id: item.id,
      coordinates: `(${item.x}, ${item.y})`,
      createdBy: item.createdBy,
      remaining: Math.max(0, item.endTime - Date.now())
    }))
  });
});

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error('服務器錯誤:', err.stack);
  res.status(500).json({ error: '內部服務器錯誤' });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({ error: '頁面不存在' });
});

// 優雅關閉 - 保存數據
process.on('SIGTERM', async () => {
  console.log('收到 SIGTERM 信號，正在保存數據並關閉服務器...');
  await saveCountdownData();
  server.close(() => {
    console.log('服務器已關閉');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('收到 SIGINT 信號，正在保存數據並關閉服務器...');
  await saveCountdownData();
  server.close(() => {
    console.log('服務器已關閉');
    process.exit(0);
  });
});

// 啟動服務器 - Railway 兼容
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 多人協作倒計時工具運行在端口 ${PORT}`);
  console.log(`📅 服務器時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  console.log(`🌍 環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 數據文件: ${DATA_FILE}`);
});