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
const DATA_FILE = path.join(__dirname, 'data.json');

// 全局倒計時數據存儲（所有用戶共享）
let countdownItems = [];
let nextId = 1;

// 從文件加載數據
async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    
    // 清理過期的倒計時（比結束時間晚30秒才清理，給緩衝時間）
    const now = Date.now();
    countdownItems = parsed.countdowns.filter(item => item.endTime > (now - 30000));
    nextId = parsed.nextId || 1;
    
    // 確保 nextId 是正確的
    if (countdownItems.length > 0) {
      nextId = Math.max(...countdownItems.map(item => item.id)) + 1;
    }
    
    console.log(`📊 加載了 ${countdownItems.length} 個共享倒計時`);
    
    // 如果清理了過期項目，保存一次
    if (parsed.countdowns.length !== countdownItems.length) {
      await saveData();
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

// 根路由
app.get('/', (req, res) => {
  res.render('index', { 
    title: '多人協作倒計時工具'
  });
});

// Socket.IO 連接處理
io.on('connection', (socket) => {
  console.log(`👤 新用戶連接: ${socket.id}`);
  
  // 初始化用戶信息
  socket.user = {
    id: socket.id,
    name: '未命名用戶',
    color: '#3b82f6',
    connected: true,
    joinTime: Date.now()
  };
  
  // 🎯 發送當前所有共享倒計時給新用戶
  socket.emit('countdown-list', countdownItems);
  console.log(`📤 向用戶 ${socket.id} 發送了 ${countdownItems.length} 個倒計時`);
  
  // 處理用戶設置信息
  socket.on('set-user-info', (userInfo) => {
    socket.user.name = userInfo.name;
    socket.user.color = userInfo.color;
    console.log(`✅ 用戶 ${socket.user.name} 已加入協作`);
    
    // 通知其他用戶有新用戶加入
    socket.broadcast.emit('user-joined', {
      name: socket.user.name,
      color: socket.user.color,
      id: socket.id
    });
  });
  
  // 處理添加新倒計時（全局共享）
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
    
    // 添加到全局共享列表
    countdownItems.push(newItem);
    
    // 💾 保存到文件
    await saveData();
    
    // 🌍 廣播給所有連接的用戶（包括創建者）
    io.emit('countdown-added', newItem);
    
    console.log(`➕ ${socket.user.name} 創建了共享倒計時: (${x},${y}) ${minutes}:${seconds.toString().padStart(2, '0')}`);
  });
  
  // 處理移除倒計時（全局共享）
  socket.on('remove-countdown', async (data) => {
    const { id } = data;
    const itemIndex = countdownItems.findIndex(item => item.id === id);
    
    if (itemIndex !== -1) {
      const removedItem = countdownItems.splice(itemIndex, 1)[0];
      
      // 💾 保存到文件
      await saveData();
      
      // 🌍 通知所有用戶移除
      io.emit('countdown-removed', { id });
      console.log(`🗑️ ${socket.user.name} 移除了倒計時 (${removedItem.x},${removedItem.y})`);
    }
  });
  
  // 處理清空所有倒計時（全局操作）
  socket.on('clear-all', async () => {
    const clearedCount = countdownItems.length;
    countdownItems = [];
    
    // 💾 保存到文件
    await saveData();
    
    // 🌍 通知所有用戶清空
    io.emit('countdowns-cleared');
    console.log(`🧹 ${socket.user.name} 清空了所有 ${clearedCount} 個倒計時`);
  });
  
  // 用戶斷線
  socket.on('disconnect', () => {
    console.log(`👋 用戶 ${socket.user.name} 離開協作`);
    socket.broadcast.emit('user-left', socket.user.id);
  });
});

// 定期清理過期的倒計時項目
setInterval(async () => {
  const now = Date.now();
  const initialCount = countdownItems.length;
  
  // 保留已結束但未超過1分鐘的項目，給用戶查看時間
  countdownItems = countdownItems.filter(item => item.endTime > (now - 60000));
  
  if (countdownItems.length !== initialCount) {
    // 💾 保存變更
    await saveData();
    
    // 🌍 通知所有用戶更新列表
    io.emit('countdown-list', countdownItems);
    console.log(`🧹 自動清理了 ${initialCount - countdownItems.length} 個過期倒計時`);
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
    connectedUsers: io.engine.clientsCount
  });
});

// 共享數據狀態端點
app.get('/shared-status', (req, res) => {
  res.json({
    totalCountdowns: countdownItems.length,
    nextId: nextId,
    connectedUsers: io.engine.clientsCount,
    countdowns: countdownItems.map(item => ({
      id: item.id,
      coordinates: `(${item.x}, ${item.y})`,
      createdBy: item.createdBy,
      remaining: Math.max(0, item.endTime - Date.now()),
      status: item.endTime > Date.now() ? 'active' : 'expired'
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

// 優雅關閉 - 保存共享數據
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

// 啟動服務器
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 多人協作倒計時工具運行在端口 ${PORT}`);
  console.log(`📅 服務器時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  console.log(`🌍 環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`👥 支持全局共享倒計時協作`);
  console.log(`💾 數據持久化已啟用`);
});