const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);

// 🔧 最簡化但穩定的 Socket.IO 配置
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  allowEIO3: true
});

// 設置 Handlebars
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'src/pages'));

// 服務靜態文件
app.use(express.static('public'));

// 數據存儲
let countdownItems = [];
let nextId = 1;

// 簡化的數據持久化
const DATA_FILE = 'data.json';

async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    countdownItems = parsed.countdowns || [];
    nextId = parsed.nextId || 1;
    console.log(`📊 加載了 ${countdownItems.length} 個倒計時`);
  } catch (error) {
    console.log('📝 創建新數據文件');
    countdownItems = [];
    nextId = 1;
  }
}

async function saveData() {
  try {
    const data = {
      countdowns: countdownItems,
      nextId: nextId,
      updated: new Date().toISOString()
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('保存失敗:', error);
  }
}

// 啟動時加載數據
loadData();

// 🎯 基本路由
app.get('/', (req, res) => {
  res.render('index', { title: '多人協作倒計時工具' });
});

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    time: new Date().toISOString(),
    countdowns: countdownItems.length,
    users: io.engine.clientsCount
  });
});

// 測試端點
app.get('/test', (req, res) => {
  res.json({ message: '服務器正常運行', timestamp: Date.now() });
});

// Socket.IO 連接處理（簡化版本）
io.on('connection', (socket) => {
  console.log(`👤 用戶連接: ${socket.id}`);
  
  // 立即發送確認
  socket.emit('welcome', { 
    message: '歡迎！', 
    socketId: socket.id,
    serverTime: Date.now()
  });
  
  // 用戶設置信息
  socket.on('set-user-info', (userInfo) => {
    socket.user = userInfo;
    console.log(`✅ 用戶 ${userInfo.name} 已設置`);
    
    // 發送當前倒計時列表
    const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
    socket.emit('countdown-list', activeCountdowns);
    console.log(`📤 發送 ${activeCountdowns.length} 個倒計時給 ${userInfo.name}`);
  });
  
  // 添加倒計時
  socket.on('add-countdown', async (data) => {
    try {
      const { x, y, minutes, seconds, user } = data;
      
      // 基本驗證
      if (typeof x !== 'number' || typeof y !== 'number' || 
          minutes < 0 || seconds < 0 || (minutes === 0 && seconds === 0)) {
        socket.emit('error', { message: '輸入無效' });
        return;
      }
      
      // 檢查重複座標
      const existing = countdownItems.find(item => 
        item.x === x && item.y === y && item.endTime > Date.now()
      );
      
      if (existing) {
        socket.emit('error', { 
          message: `座標 (${x}, ${y}) 已存在倒計時`,
          duplicateId: existing.id 
        });
        return;
      }
      
      // 創建新倒計時
      const totalMs = (minutes * 60 + seconds) * 1000;
      const newItem = {
        id: nextId++,
        x: x,
        y: y,
        endTime: Date.now() + totalMs,
        createdBy: user?.name || '未知用戶',
        createdByColor: user?.color || '#3b82f6',
        createdAt: Date.now()
      };
      
      countdownItems.push(newItem);
      await saveData();
      
      // 廣播給所有用戶
      io.emit('countdown-added', newItem);
      console.log(`➕ 新增倒計時: (${x},${y}) by ${newItem.createdBy}`);
      
    } catch (error) {
      console.error('添加倒計時錯誤:', error);
      socket.emit('error', { message: '添加失敗' });
    }
  });
  
  // 移除倒計時
  socket.on('remove-countdown', async (data) => {
    try {
      const index = countdownItems.findIndex(item => item.id === data.id);
      if (index !== -1) {
        countdownItems.splice(index, 1);
        await saveData();
        io.emit('countdown-removed', { id: data.id });
        console.log(`🗑️ 移除倒計時 ID: ${data.id}`);
      }
    } catch (error) {
      console.error('移除倒計時錯誤:', error);
    }
  });
  
  // 清空所有
  socket.on('clear-all', async () => {
    try {
      countdownItems = [];
      await saveData();
      io.emit('countdowns-cleared');
      console.log('🧹 清空所有倒計時');
    } catch (error) {
      console.error('清空錯誤:', error);
    }
  });
  
  // 請求同步
  socket.on('request-sync', () => {
    const activeCountdowns = countdownItems.filter(item => item.endTime > Date.now());
    socket.emit('countdown-list', activeCountdowns);
  });
  
  // 斷線處理
  socket.on('disconnect', () => {
    console.log(`👋 用戶 ${socket.id} 斷線`);
  });
});

// 定期清理過期項目
setInterval(async () => {
  const before = countdownItems.length;
  countdownItems = countdownItems.filter(item => item.endTime > Date.now() - 60000);
  
  if (countdownItems.length !== before) {
    await saveData();
    io.emit('countdown-list', countdownItems);
    console.log(`🧹 清理了 ${before - countdownItems.length} 個過期項目`);
  }
}, 60000);

// 啟動服務器
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服務器運行在端口 ${PORT}`);
  console.log(`🌍 環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ 啟動時間: ${new Date().toLocaleString('zh-TW')}`);
});

// 錯誤處理
process.on('uncaughtException', (error) => {
  console.error('未捕獲異常:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('未處理的 Promise 拒絕:', error);
});