const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);

// 🔧 優化 Socket.IO 配置 - 增強連接穩定性
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  // 🎯 關鍵配置：增強連接穩定性
  transports: ['websocket', 'polling'], // 支持多種傳輸方式
  upgradeTimeout: 30000,                // 增加升級超時時間
  pingTimeout: 60000,                   // 增加 ping 超時時間
  pingInterval: 25000,                  // ping 間隔時間
  allowEIO3: true,                      // 兼容舊版本
  // Railway 特殊配置
  connectTimeout: 45000,                // 連接超時
  forceNew: false,                      // 不強制新連接
  rememberUpgrade: true,                // 記住升級
  timeout: 20000                        // 響應超時
});

// 設置 Handlebars 作為模板引擎
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'src/pages'));

// 服務靜態文件
app.use(express.static('public'));

// 🎯 增加中間件 - 保持服務器活躍
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 數據文件路徑
const DATA_FILE = path.join(__dirname, 'data.json');

// 全局倒計時數據存儲
let countdownItems = [];
let nextId = 1;
let serverStartTime = Date.now();

// 從文件加載數據
async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    
    const now = Date.now();
    countdownItems = parsed.countdowns.filter(item => item.endTime > now);
    nextId = parsed.nextId || 1;
    
    if (countdownItems.length > 0) {
      nextId = Math.max(...countdownItems.map(item => item.id)) + 1;
    }
    
    console.log(`📊 從文件加載了 ${countdownItems.length} 個活躍倒計時`);
    
    if (parsed.countdowns.length !== countdownItems.length) {
      await saveData();
      console.log(`🧹 清理了 ${parsed.countdowns.length - countdownItems.length} 個過期項目`);
    }
  } catch (error) {
    console.log('📝 創建新的數據文件');
    countdownItems = [];
    nextId = 1;
    await saveData();
  }
}

// 保存數據到文件
async function saveData() {
  try {
    const data = {
      countdowns: countdownItems,
      nextId: nextId,
      lastUpdated: new Date().toISOString(),
      totalCreated: nextId - 1
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 已保存 ${countdownItems.length} 個倒計時到文件`);
  } catch (error) {
    console.error('❌ 保存數據失敗:', error);
  }
}

// 啟動時加載數據
loadData();

// 🎯 保持服務器活躍的 ping 端點
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'pong', 
    timestamp: Date.now(),
    uptime: Date.now() - serverStartTime,
    countdowns: countdownItems.length
  });
});

// 根路由
app.get('/', (req, res) => {
  res.render('index', { 
    title: '多人協作倒計時工具'
  });
});

// 🔧 Socket.IO 連接處理 - 增強錯誤處理
io.on('connection', (socket) => {
  console.log(`👤 新用戶連接: ${socket.id} (來源: ${socket.handshake.address})`);
  
  // 初始化用戶信息
  socket.user = {
    id: socket.id,
    name: '未命名用戶',
    color: '#3b82f6',
    connected: true,
    joinTime: Date.now(),
    lastActivity: Date.now()
  };
  
  // 🎯 立即發送連接確認
  socket.emit('connection-confirmed', {
    socketId: socket.id,
    serverTime: Date.now(),
    message: '連接成功'
  });
  
  // 處理用戶設置信息
  socket.on('set-user-info', (userInfo) => {
    try {
      socket.user.name = userInfo.name;
      socket.user.color = userInfo.color;
      socket.user.lastActivity = Date.now();
      
      console.log(`✅ 用戶 "${socket.user.name}" 已加入協作`);
      
      // 立即發送當前所有倒計時
      const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
      socket.emit('countdown-list', activeCountdowns);
      console.log(`📤 向新用戶 "${socket.user.name}" 發送了 ${activeCountdowns.length} 個活躍倒計時`);
      
      // 通知其他用戶
      socket.broadcast.emit('user-joined', {
        name: socket.user.name,
        color: socket.user.color,
        id: socket.id
      });
    } catch (error) {
      console.error('設置用戶信息錯誤:', error);
      socket.emit('error', { message: '設置用戶信息失敗' });
    }
  });
  
  // 🔄 用戶請求最新數據
  socket.on('request-sync', () => {
    try {
      const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
      socket.emit('countdown-list', activeCountdowns);
      socket.user.lastActivity = Date.now();
      console.log(`🔄 向用戶 "${socket.user.name}" 同步了 ${activeCountdowns.length} 個倒計時`);
    } catch (error) {
      console.error('同步數據錯誤:', error);
      socket.emit('error', { message: '同步數據失敗' });
    }
  });
  
  // 🎯 心跳檢測
  socket.on('heartbeat', () => {
    socket.user.lastActivity = Date.now();
    socket.emit('heartbeat-response', { serverTime: Date.now() });
  });
  
  // 處理添加新倒計時
  socket.on('add-countdown', async (data) => {
    try {
      const { x, y, minutes, seconds, user } = data;
      
      // 更新活動時間
      socket.user.lastActivity = Date.now();
      
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
      const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
      const existingItem = activeCountdowns.find(item => item.x === x && item.y === y);
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
      await saveData();
      
      // 廣播給所有用戶
      io.emit('countdown-added', newItem);
      
      console.log(`➕ ${socket.user.name} 創建了共享倒計時: (${x},${y}) ${minutes}:${seconds.toString().padStart(2, '0')}`);
    } catch (error) {
      console.error('添加倒計時錯誤:', error);
      socket.emit('error', { message: '添加倒計時失敗' });
    }
  });
  
  // 處理移除倒計時
  socket.on('remove-countdown', async (data) => {
    try {
      const { id } = data;
      const itemIndex = countdownItems.findIndex(item => item.id === id);
      
      if (itemIndex !== -1) {
        const removedItem = countdownItems.splice(itemIndex, 1)[0];
        await saveData();
        
        io.emit('countdown-removed', { id });
        console.log(`🗑️ ${socket.user.name} 移除了倒計時 (${removedItem.x},${removedItem.y})`);
      }
      
      socket.user.lastActivity = Date.now();
    } catch (error) {
      console.error('移除倒計時錯誤:', error);
      socket.emit('error', { message: '移除倒計時失敗' });
    }
  });
  
  // 處理清空所有倒計時
  socket.on('clear-all', async () => {
    try {
      const clearedCount = countdownItems.length;
      countdownItems = [];
      
      await saveData();
      
      io.emit('countdowns-cleared');
      console.log(`🧹 ${socket.user.name} 清空了所有 ${clearedCount} 個倒計時`);
      
      socket.user.lastActivity = Date.now();
    } catch (error) {
      console.error('清空倒計時錯誤:', error);
      socket.emit('error', { message: '清空倒計時失敗' });
    }
  });
  
  // 🔧 連接錯誤處理
  socket.on('error', (error) => {
    console.error(`Socket 錯誤 (${socket.id}):`, error);
  });
  
  // 用戶斷線
  socket.on('disconnect', (reason) => {
    console.log(`👋 用戶 ${socket.user.name} 離開協作 (原因: ${reason})`);
    socket.broadcast.emit('user-left', socket.user.id);
  });
});

// 定期清理過期的倒計時項目
setInterval(async () => {
  const now = Date.now();
  const initialCount = countdownItems.length;
  
  countdownItems = countdownItems.filter(item => item.endTime > (now - 30000));
  
  if (countdownItems.length !== initialCount) {
    await saveData();
    io.emit('countdown-list', countdownItems);
    console.log(`🧹 自動清理了 ${initialCount - countdownItems.length} 個過期倒計時`);
  }
}, 60000);

// 🎯 定期向所有用戶發送心跳和同步
setInterval(() => {
  if (io.engine.clientsCount > 0) {
    const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
    io.emit('server-heartbeat', {
      serverTime: Date.now(),
      activeCountdowns: activeCountdowns.length,
      connectedUsers: io.engine.clientsCount
    });
  }
}, 30000); // 每30秒一次

// 健康檢查端點
app.get('/health', (req, res) => {
  const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    serverTime: Date.now(),
    uptime: Date.now() - serverStartTime,
    totalCountdowns: countdownItems.length,
    activeCountdowns: activeCountdowns.length,
    connectedUsers: io.engine.clientsCount,
    version: '2.0.0'
  });
});

// 共享數據狀態端點
app.get('/shared-status', (req, res) => {
  const now = Date.now();
  res.json({
    totalCountdowns: countdownItems.length,
    activeCountdowns: countdownItems.filter(item => item.endTime > now).length,
    expiredCountdowns: countdownItems.filter(item => item.endTime <= now).length,
    nextId: nextId,
    connectedUsers: io.engine.clientsCount,
    serverTime: now,
    uptime: now - serverStartTime,
    countdowns: countdownItems.map(item => ({
      id: item.id,
      coordinates: `(${item.x}, ${item.y})`,
      createdBy: item.createdBy,
      remaining: Math.max(0, item.endTime - now),
      status: item.endTime > now ? 'active' : 'expired',
      endTime: new Date(item.endTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
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

// 優雅關閉
process.on('SIGTERM', async () => {
  console.log('收到 SIGTERM 信號，正在保存共享數據...');
  await saveData();
  server.close(() => {
    console.log('服務器已關閉，共享數據已保存');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('收到 SIGINT 信號，正在保存共享數據...');
  await saveData();
  server.close(() => {
    console.log('服務器已關閉，共享數據已保存');
    process.exit(0);
  });
});

// 🎯 捕獲未處理的異常
process.on('uncaughtException', (error) => {
  console.error('未捕獲的異常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未處理的 Promise 拒絕:', reason);
});

// 啟動服務器
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 多人協作倒計時工具運行在端口 ${PORT}`);
  console.log(`📅 服務器時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  console.log(`🌍 環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`👥 支持全局共享倒計時協作`);
  console.log(`💾 數據持久化已啟用`);
  console.log(`🔄 連接穩定性增強已啟用`);
  console.log(`⚡ 服務器啟動時間: ${serverStartTime}`);
});